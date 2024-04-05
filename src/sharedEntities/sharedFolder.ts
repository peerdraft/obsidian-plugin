import { TFile, TFolder } from "obsidian";
import * as path from 'path'
import * as Y from 'yjs'
import { showNotice } from "../ui";
import { generateRandomString } from "../tools";
import { SharedEntity } from "./sharedEntity";
import PeerDraftPlugin from "src/main";
import { SharedDocument } from "./sharedDocument";


const handleUpdate = (ev: Y.YMapEvent<unknown>, tx: Y.Transaction, folder: SharedFolder, plugin: PeerDraftPlugin) => {

  const changedKeys = ev.changes.keys

  changedKeys.forEach(async (data, key) => {

    if (data.action === "add") {
      const value = tx.doc.getMap("documents").get(key) as string
      const file = await folder.getOrCreateFile(value)
      if (file) {
        await SharedDocument.fromTFile(file, { id: key, permanent: true }, plugin)
      }
    }

    // check if dir structure conforms with dir structure
    // possible options:


    // create -> create file and SharedDocument
    // rename -> 
    // delete -> rename


  })
}

export class SharedFolder extends SharedEntity {

  root: TFolder
  static _sharedDocuments: Array<SharedFolder> = []

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

    for (const doc of docs) {
      folder.addDocument(doc)
    }

    navigator.clipboard.writeText(plugin.settings.basePath + '/team/' + folder.shareId)
    showNotice(`Folder ${folder.path} with ${docs.length} documents shared. URL copied to your clipboard.`)

    folder.startWebSocketSync()

    await plugin.permanentShareStore.add(folder)

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
    await plugin.permanentShareStore.add(sFolder)

    return sFolder
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

  addDocument(doc: SharedDocument) {
    // doesn't exist yet
    if (this.getDocsFragment().get(doc.shareId)) return
    // check if doc is under root
    const relativePath = path.relative(this.root.path, doc.path)
    if (relativePath.startsWith('..')) return
    this.getDocsFragment().set(doc.shareId, relativePath)
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

    const folder = await this.getOrCreatePath(path.parse(absolutePath).dir)
    if (!folder) {
      showNotice("Error creating shares")
      return
    }

    return await this.plugin.app.vault.create(absolutePath, '')
  }

  async getOrCreatePath(absolutePath: string): Promise<TFolder | void> {
    let folder = this.plugin.app.vault.getAbstractFileByPath(absolutePath)
    if (folder && folder instanceof TFolder) return folder
    const segments = absolutePath.split(path.sep)
    for (let index = 0; index < segments.length; index++) {
      const subPath = segments.slice(0, index + 1).join(path.sep)
      folder = this.plugin.app.vault.getAbstractFileByPath(subPath)
      if (!folder) {
        folder = await this.plugin.app.vault.createFolder(subPath)
      }
    }
    return folder as TFolder
  }

  destroy() {
    super.destroy()
    SharedFolder._sharedEntites.splice(SharedFolder._sharedEntites.indexOf(this), 1)
  }

}