import { TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import * as path from 'path'
import * as Y from 'yjs'
import { showNotice } from "../ui";
import { calculateHash, generateRandomString, serialize } from "../tools";
import { SharedEntity } from "./sharedEntity";
import PeerDraftPlugin from "src/main";
import { SharedDocument } from "./sharedDocument";
import { PermanentShareFolder } from "src/permanentShareStore";
import { IndexeddbPersistence } from "y-indexeddb";
import { addIsSharedClass, removeIsSharedClass } from "src/workspace/explorerView";
import { add, getFolderByPath, moveFolder, removeFolder } from "src/permanentShareStoreFS";
import { openFolderOptions } from "src/ui/folderOptions";

const handleUpdate = (ev: Y.YMapEvent<unknown>, tx: Y.Transaction, folder: SharedFolder, plugin: PeerDraftPlugin) => {

  if (!([plugin.serverSync, folder.webRTCProvider?.room].includes(tx.origin))) return

  const changedKeys = ev.changes.keys

  changedKeys.forEach(async (data, key) => {
    plugin.log("Action: " + data.action + "for " + key + " --> " + tx.doc.getMap("documents").get(key) as string)

    if (data.action === "add") {
      const relativePath = tx.doc.getMap("documents").get(key) as string
      const absolutePath = path.join(folder.path, relativePath)
      const file = plugin.app.vault.getAbstractFileByPath(absolutePath)
      if (file) {

        // safety check if fs already in sync

        const existingDoc = SharedDocument.findById(key)
        if (existingDoc) {
          if (existingDoc.file.path === file.path) {
            // Do nothing.
            plugin.log("Received update, but FS is already in correct state")
          } else {
            // should not occur :-(
            showNotice("There is something wrong with your synced file " + file.path + ". Consider re-creating the synced folder from server.")
          }
        } else {
          showNotice("File " + file.path + " already exists. Renaming local file.")

          const alteredPath = path.join(path.dirname(relativePath), path.basename(relativePath, path.extname(relativePath)) + "_" + generateRandomString() + path.extname(relativePath))
          const alteredAbsolutePath = path.join(folder.root.path, alteredPath)
          plugin.app.fileManager.renameFile(file, alteredAbsolutePath)
          SharedDocument.fromIdAndPath(key, absolutePath, plugin)
        }
      } else {
        showNotice("Creating new shared document: " + absolutePath)
        await SharedFolder.getOrCreatePath(path.parse(absolutePath).dir, plugin)
        await SharedDocument.fromIdAndPath(key, absolutePath, plugin)
      }
    } else if (data.action === "update") {
      const newPath = tx.doc.getMap("documents").get(key) as string
      const document = SharedDocument.findById(key)
      if (!document) {
        showNotice("Document at " + newPath + " doesn't exist in your vault. Consider re-creating the synced folder from server.")
        return
      }
      plugin.log("Update " + document.path + "   " + key)
      const folder = SharedFolder.getSharedFolderForSubPath(document.path)
      if (!folder) return
      let newAbsolutePath = path.join(folder.root.path, newPath)
      await SharedFolder.getOrCreatePath(path.parse(newAbsolutePath).dir, plugin)

      const alreadyExists = SharedDocument.findByPath(newAbsolutePath)
      if (alreadyExists) {
        // check if in sync already
        if (alreadyExists.shareId === key) {
          // Do nothing.
          plugin.log("Received update, but FS is already in correct state.")
        } else {
          showNotice("File " + newPath + " already exists. Renaming local file.")
          const alteredPath = path.join(path.dirname(newPath), path.basename(newPath, path.extname(newPath)) + "_" + generateRandomString() + path.extname(newPath))
          const alteredAbsolutePath = path.join(folder.root.path, alteredPath)
          plugin.app.fileManager.renameFile(alreadyExists.file, alteredAbsolutePath)
          SharedDocument.fromIdAndPath(key, alteredAbsolutePath, plugin)
        }
      } else {
        await plugin.app.fileManager.renameFile(document.file, newAbsolutePath)
      }
    } else if (data.action === "delete") {
      const document = SharedDocument.findById(key)
      if (!document) return
      plugin.log("Delete " + document.path + "   " + key)
      const file = plugin.app.vault.getAbstractFileByPath(document.path)
      if (!file) return
      plugin.app.vault.delete(file)
    }
  })
}

export class SharedFolder extends SharedEntity {

  root: TFolder
  protected static _sharedEntites: Array<SharedFolder> = new Array<SharedFolder>()

  static async fromTFolder(root: TFolder, plugin: PeerDraftPlugin) {
    showNotice(`Inititializing share for ${root.path}.`)
    const files = this.getAllFilesInFolder(root)

    // check if docs for some of them are already there
    for (const file of files) {
      if (SharedDocument.findByPath(file.path)) {
        showNotice("You can not share a directory that already has shared files in it (right now).")
        return
      }
    }

    const docs = await Promise.all(files.map((file) => {
      return SharedDocument.fromTFile(file, {
        permanent: true
      }, plugin)
    }))

    const folder = new SharedFolder(root, plugin)

    for (const doc of docs) {
      if (doc) {
        folder.addDocument(doc)
      }
    }

    folder.yDoc.getText("originalFoldername").insert(0, root.name)

    await folder.initServerYDoc()

    await add(folder, plugin)
    await folder.startIndexedDBSync()
    folder.startWebRTCSync()

    navigator.clipboard.writeText(plugin.settings.basePath + '/team/' + folder.shareId)
    showNotice(`Folder ${folder.path} with ${docs.length} documents shared. URL copied to your clipboard.`, 0)
    openFolderOptions(plugin.app, folder)
    return folder
  }

  getShareURL() {
    return this.plugin.settings.basePath + "/team/" + this.shareId
  }

  static async recreate(folder: SharedFolder, plugin: PeerDraftPlugin) {
    const location = folder.root.path
    await folder.unshare()
    await plugin.app.vault.delete(folder.root, true)
    return await this.fromShareURL(plugin.settings.basePath + '/team/' + folder.shareId, plugin, location)
  }

  static async fromShareURL(url: string, plugin: PeerDraftPlugin, location?: string): Promise<SharedFolder | void> {
    const id = url.split('/').pop()
    if (!id || !id.match('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) {
      showNotice("No valid peerdraft link")
      return
    }

    let folderPath = location
    const preFetchedDoc = await plugin.serverSync.requestDocument(id)


    if (!folderPath) {
      let initialRootName = `_peerdraft_team_folder_${generateRandomString()}`
      const docFoldername = preFetchedDoc.getText("originalFoldername").toString()
      if (docFoldername != '') {
        const folderExists = plugin.app.vault.getAbstractFileByPath(path.join(plugin.settings.root, docFoldername))
        if (!folderExists) {
          initialRootName = docFoldername
        } else {
          initialRootName = `_peerdraft_${generateRandomString()}_${docFoldername}`
        }
      }

      folderPath = path.join(plugin.settings.root, initialRootName)
    }

    const folder = await SharedFolder.getOrCreatePath(folderPath!, plugin)

    if (!folder) {
      showNotice("Could not create folder " + folderPath)
      return
    };

    const paths: Array<string> = []
    const documentMap = preFetchedDoc.getMap("documents") as Y.Map<string>

    for (const entry of documentMap.entries()) {
      let docPath = entry[1]
      const absPath = path.join(folderPath!, docPath)
      // repair inconsistent server version
      if (docPath && paths.includes(normalizePath(docPath))) {
        // sanity check
        const existingDoc = SharedDocument.findById(entry[0])
        if (existingDoc) {
          if (existingDoc.path === absPath) {
            plugin.log("already synced")
          } else {
            plugin.app.fileManager.renameFile(existingDoc.file, absPath)
          }
        } else {
          docPath = normalizePath(path.join(path.dirname(docPath), path.basename(docPath, path.extname(docPath)) + "_" + generateRandomString() + path.extname(docPath)))
          documentMap.set(entry[0], docPath)
        }
      }
      await SharedDocument.fromIdAndPath(entry[0], absPath, plugin)
      paths.push(normalizePath(docPath))
    }

    const sFolder = new SharedFolder(folder, plugin, preFetchedDoc)
    sFolder._shareId = id

    await add(sFolder, plugin)
    await sFolder.startIndexedDBSync()
    if (sFolder.indexedDBProvider) {
      if (!sFolder.indexedDBProvider.synced) await sFolder.indexedDBProvider.whenSynced
      sFolder.syncWithServer()
      sFolder.startWebRTCSync()
    }
    return sFolder
  }

  static async fromPermanentShareFolder(psf: PermanentShareFolder, plugin: PeerDraftPlugin) {
    if (this.findByPath(psf.path)) return
    let tFolder: void | null | TAbstractFile
    tFolder = plugin.app.vault.getAbstractFileByPath(psf.path)
    if (tFolder instanceof TFile) {
      showNotice("Expected " + psf.path + " to be a folder, but it is a file?")
      return
    }
    if (!(tFolder instanceof TFolder)) {
      showNotice("Shared folder " + psf.path + " not found. Creating it now.")
      tFolder = await this.getOrCreatePath(psf.path, plugin)
    }
    if (!(tFolder instanceof TFolder)) {
      showNotice("Could not create folder " + psf.path + ".")
      return
    }

    const folder = new SharedFolder(tFolder, plugin)
    folder._shareId = psf.shareId
    const local = await folder.startIndexedDBSync()
    if (local) {
      if (local.synced || await local.whenSynced) {
        folder.syncWithServer()
        folder.startWebRTCSync()
      }
    }
    return folder
  }

  static findByPath(path: string) {
    return super.findByPath(path) as SharedFolder | undefined
  }

  static findById(id: string) {
    return super.findById(id) as SharedFolder | undefined
  }


  static getAll() {
    return super.getAll() as Array<SharedFolder>
  }

  static getSharedFolderForSubPath(dir: string) {
    const normalizedPath = normalizePath(dir)
    const folders = this.getAll()
    for (const folder of folders) {
      if (folder.root.path === normalizedPath) return
      if (folder.isPathSubPath(normalizedPath)) return folder
    }
  }

  private constructor(root: TFolder, plugin: PeerDraftPlugin, ydoc?: Y.Doc) {
    super(plugin)
    this.root = root
    this._path = root.path
    this.yDoc = ydoc ?? new Y.Doc()
    this.getDocsFragment().observe((ev, tx) => {
      handleUpdate(ev, tx, this, plugin)
    })
    this.yDoc.on("update", (update: Uint8Array, origin: any, yDoc: Y.Doc, tr: Y.Transaction) => {
      if (tr.local && this.shareId) {
        plugin.serverSync.sendUpdate(this, update)
      }
    })
    SharedFolder._sharedEntites.push(this)
    addIsSharedClass(this.path, plugin)
  }

  getDocsFragment() {
    return this.yDoc.getMap('documents') as Y.Map<string>
  }


  getDocByRelativePath(dir: string) {
    const normalizedPath = normalizePath(dir)
    for (const entry of this.getDocsFragment().entries() as IterableIterator<[key: string, value: string]>) {
      if (entry[1] === normalizedPath) return entry[0]
    }
  }

  updatePath(oldPath: string, newPath: string) {
    const oldPathRelative = path.relative(this.root.path, oldPath)
    const newPathRelative = path.relative(this.root.path, newPath)

    const id = this.getDocByRelativePath(oldPathRelative)
    if (id) {
      this.getDocsFragment().set(id, normalizePath(newPathRelative))
    }
    return id
  }

  calculateHash(): string {
    const serialized = serialize(Array.from(this.getDocsFragment()))
    return calculateHash(serialized)
  }

  getOriginalFolderName() {
    return this.yDoc.getText("originalFoldername").toString()
  }

  setOriginalFolderName(name: string) {
    const text = this.yDoc.getText("originalFoldername")
    text.delete(0, text.length)
    text.insert(0, name)
  }

  getAutoFillProperty() {
    return this.yDoc.getText("autoFillProperty").toString()
  }

  setAutoFillProperty(property: string) {
    const prop = this.yDoc.getText("autoFillProperty")
    prop.delete(0, prop.length)
    prop.insert(0, property)
  }

  async updatePropertiesOfAllDocuments(oldPropertyName?: string) {
    const prop = this.getAutoFillProperty()
    if (!prop || prop === "") return
    const docs = this.getDocsFragment()
    for (const entry of docs) {
      const doc = SharedDocument.findById(entry[0])
      if (!doc) return
      doc.updateProperty(prop, doc.getShareURL(), oldPropertyName)
    }
  }

  addDocument(doc: SharedDocument) {
    // doesn't exist yet
    if (this.getDocsFragment().get(doc.shareId)) return
    // check if doc is under root
    const relativePath = path.relative(this.root.path, doc.path)
    if (relativePath.startsWith('..')) return
    this.getDocsFragment().set(doc.shareId, relativePath)
  }

  removeDocument(doc: SharedDocument) {
    this.getDocsFragment().delete(doc.shareId)
    const deleted = this.yDoc.getArray("deleted") as Y.Array<string>
    if (!deleted.toArray().includes(doc.shareId)){
      deleted.push([doc.shareId])
    }
  }

  isPathSubPath(folder: string) {
    const relativePath = path.relative(this.root.path, folder)
    return !(relativePath.startsWith('..'))
  }

  private static getAllFilesInFolder(folder: TFolder): Array<TFile> {
    const files = folder.children.flatMap((child) => {
      if (child instanceof TFile) {
        if (child.extension === "md") {
          return child
        }
      }
      if (child instanceof TFolder) {
        return this.getAllFilesInFolder(child)
      }
      return []
    })
    return files
  }

  async setNewFolderLocation(folder: TFolder) {
    const oldPath = this._path
    this.root = folder
    this._path = normalizePath(folder.path)
    moveFolder(oldPath, folder.path, this.plugin)
  }

  async getOrCreateFile(relativePath: string) {
    const absolutePath = path.join(this.root.path, relativePath)
    let file = this.plugin.app.vault.getAbstractFileByPath(absolutePath)
    if (file && file instanceof TFile) return file

    const folder = await SharedFolder.getOrCreatePath(path.parse(absolutePath).dir, this.plugin)
    if (!folder) {
      showNotice("Error creating shares")
      return
    }
    return await this.plugin.app.vault.create(absolutePath, '')
  }

  static async getOrCreatePath(absolutePath: string, plugin: PeerDraftPlugin): Promise<TFolder | void> {
    let folder = plugin.app.vault.getAbstractFileByPath(normalizePath(absolutePath))
    if (folder && folder instanceof TFolder) return folder
    const segments = absolutePath.split(path.sep)
    for (let index = 0; index < segments.length; index++) {
      const subPath = segments.slice(0, index + 1).join(path.sep)
      folder = plugin.app.vault.getAbstractFileByPath(normalizePath(subPath))
      if (!folder) {
        folder = await plugin.app.vault.createFolder(normalizePath(subPath))
      }
    }
    return folder as TFolder
  }

  isFileInSyncObject(file: TFile) {
    const normalizedPath = normalizePath(file.path)
    for (const value of (this.getDocsFragment() as Y.Map<string>).values()) {
      if (normalizedPath === path.join(this.root.path, value)) return true
    }
    return false
  }

  startWebRTCSync() {
    return super.startWebRTCSync((provider) => {

      const handleTimeout = () => {
        // this.stopWebRTCSync()
      }

      this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)
      provider.doc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc, tr: Y.Transaction) => {
        if (this._webRTCTimeout != null) {
          window.clearTimeout(this._webRTCTimeout)
        }
        this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)
      })
    })
  }

  async startIndexedDBSync() {
    if (this._indexedDBProvider) return this._indexedDBProvider
    const id = getFolderByPath(this.path, this.plugin)?.persistenceId
    if (!id) return
    this._indexedDBProvider = new IndexeddbPersistence(SharedEntity.DB_PERSISTENCE_PREFIX + id, this.yDoc)
    return this._indexedDBProvider
  }

  async unshare() {
    const dbEntry = getFolderByPath(this.path, this.plugin)
    if (dbEntry) {
      removeFolder(this.path, this.plugin)
    }

    if (this._indexedDBProvider) {
      await this._indexedDBProvider.clearData()
      await this._indexedDBProvider.destroy()
    }


    this.getDocsFragment().forEach((path: string, shareId: string) => {
      SharedDocument.findById(shareId)?.unshare()
    })

    this.destroy()
    removeIsSharedClass(this.path, this.plugin)
  }

  destroy() {
    super.destroy()
    SharedFolder._sharedEntites.splice(SharedFolder._sharedEntites.indexOf(this), 1)
  }

}