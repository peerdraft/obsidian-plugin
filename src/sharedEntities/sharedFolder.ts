import { TFile, TFolder } from "obsidian";
import * as path from 'path'
import * as Y from 'yjs'
import { showNotice } from "../ui";
import { generateRandomString } from "../tools";
import { SharedEntity } from "./sharedEntity";
import PeerDraftPlugin from "src/main";
import { SharedDocument } from "./sharedDocument";
import { PermanentShareFolder } from "src/permanentShareStore";
import { IndexeddbPersistence } from "y-indexeddb";


const handleUpdate = (ev: Y.YMapEvent<unknown>, tx: Y.Transaction, folder: SharedFolder, plugin: PeerDraftPlugin) => {

  if(tx.local) return

  const changedKeys = ev.changes.keys

  changedKeys.forEach(async (data, key) => {


    if (data.action === "add") {
      const value = tx.doc.getMap("documents").get(key) as string
      const file = await folder.getOrCreateFile(value)
      plugin.log("Creating Remote File " + file?.path + "   " + key)
      if (file) {
        await SharedDocument.fromTFile(file, { id: key, permanent: true }, plugin)
      }
    } else if (data.action === "update") {
      const newPath = tx.doc.getMap("documents").get(key) as string
      const document = SharedDocument.findById(key)
      if (!document) return
      plugin.log("Update " + document.path + "   " + key)
      const folder = SharedFolder.getSharedFolderForSubPath(document.path)
      if (!folder) return
      const newAbsolutePath = path.join(folder.root.path, newPath)
      await SharedFolder.getOrCreatePath(path.parse(newAbsolutePath).dir, plugin)
      plugin.app.vault.rename(document.file, newAbsolutePath)
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

    const data = await plugin.serverAPI.createPermanentSession()

    if (!data || !data.id) {
      showNotice("Error creating share")
      return
    }

    const docs = await Promise.all(files.map((file) => {
      showNotice(`Inititializing share for ${file.path}`)
      return SharedDocument.fromTFile(file, {
        permanent: true
      }, plugin)
    }))

    const folder = new SharedFolder(root, { id: data.id }, plugin)
    
    await plugin.permanentShareStore.add(folder)
    await folder.startWebSocketSync()
    await folder.startIndexedDBSync()

    for (const doc of docs) {
      folder.addDocument(doc)
    }

    navigator.clipboard.writeText(plugin.settings.basePath + '/team/' + folder.shareId)
    showNotice(`Folder ${folder.path} with ${docs.length} documents shared. URL copied to your clipboard.`)

    return folder
  }

  static async fromShareURL(url: string, plugin: PeerDraftPlugin): Promise<SharedFolder | void> {
    const id = url.split('/').pop()
    if (!id || !id.match('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) {
      showNotice("No valid peerdraft link")
      return
    }

    const initialRootName = `_peerdraft_team_folder_${generateRandomString()}`
    const parent = plugin.app.fileManager.getNewFileParent('', initialRootName)
    const folderPath = path.join(parent.path, initialRootName)

    const folder = await plugin.app.vault.createFolder(folderPath)

    const sFolder = new SharedFolder(folder, { id }, plugin)

    sFolder.startWebSocketSync()
    sFolder.startWebRTCSync()
    sFolder.startIndexedDBSync()
    await plugin.permanentShareStore.add(sFolder)

    return sFolder
  }

  static async fromPermanentShareFolder(psf: PermanentShareFolder, plugin: PeerDraftPlugin) {
    if (this.findByPath(psf.path)) return
    const tFolder = plugin.app.vault.getAbstractFileByPath(psf.path)
    if (!(tFolder instanceof TFolder)) return
    const folder = new SharedFolder(tFolder, {id: psf.shareId}, plugin)
    const local = await folder.startIndexedDBSync()
    if (local) {
      if (local.synced || await local.whenSynced) {
        await folder.startWebSocketSync()
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
    const folders = this.getAll()
    for (const folder of folders) {
      if (folder.root.path === dir) return
      if (folder.isPathSubPath(dir)) return folder
    }
  }

  private constructor(root: TFolder, opts: { id: string }, plugin: PeerDraftPlugin) {
    super(plugin)
    this.root = root
    this._path = root.path
    this.yDoc = new Y.Doc()
    this._shareId = opts.id
    this.getDocsFragment().observe((ev, tx) => {
      handleUpdate(ev, tx, this, plugin)
    })
    SharedFolder._sharedEntites.push(this)
  }

  getDocsFragment() {
    return this.yDoc.getMap('documents')
  }

  getDocByRelativePath(dir: string) {
    for (const entry of this.getDocsFragment().entries() as IterableIterator<[key: string, value: string]>) {
      if (entry[1] === dir) return entry[0]
    }
  }

  updatePath(oldPath: string, newPath: string) {
    const oldPathRelative = path.relative(this.root.path, oldPath)
    const newPathRelative = path.relative(this.root.path, newPath)

    const id = this.getDocByRelativePath(oldPathRelative)
    if (id) {
      this.getDocsFragment().set(id, newPathRelative)
    }
    return id
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
    this._path = folder.path
    const dbEntry = await this.plugin.permanentShareStore.getFolderByPath(oldPath)
    if (dbEntry) {
      this.plugin.permanentShareStore.removeFolder(oldPath)
      this.plugin.permanentShareStore.add(this)
    }
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
    let folder = plugin.app.vault.getAbstractFileByPath(absolutePath)
    if (folder && folder instanceof TFolder) return folder
    const segments = absolutePath.split(path.sep)
    for (let index = 0; index < segments.length; index++) {
      const subPath = segments.slice(0, index + 1).join(path.sep)
      folder = plugin.app.vault.getAbstractFileByPath(subPath)
      if (!folder) {
        folder = await plugin.app.vault.createFolder(subPath)
      }
    }
    return folder as TFolder
  }

  isFileInSyncObject(file: TFile) {
    for (const value of this.getDocsFragment().values()) {
      if (file.path === path.join(this.root.path, value)) return true
    }
    return false
  }

  startWebRTCSync() {
    return super.startWebRTCSync((provider) => {

      const handleTimeout = () => {
        this.stopWebRTCSync()
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
    const id = (await this.plugin.permanentShareStore.getFolderByPath(this.path))?.persistenceId
    if (!id) return
    this._indexedDBProvider = new IndexeddbPersistence(SharedEntity.DB_PERSISTENCE_PREFIX + id, this.yDoc)
    return this._indexedDBProvider
  }

  async unshare() {
    const dbEntry = await this.plugin.permanentShareStore.getFolderByPath(this.path)
    if (dbEntry) {
      this.plugin.permanentShareStore.removeFolder(this.path)
    }
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.clearData()
      await this._indexedDBProvider.destroy()
    }
    this.destroy()
  }

  destroy() {
    super.destroy()
    SharedFolder._sharedEntites.splice(SharedFolder._sharedEntites.indexOf(this), 1)
  }

}