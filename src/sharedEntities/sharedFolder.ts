import { TFile, TFolder } from "obsidian";
import * as path from 'path'
import * as Y from 'yjs'
import { SharedDocument } from "./sharedDocument";
import { showNotice } from "../ui";
import { createRandomId } from "../tools";
import { SharedEntity } from "./sharedEntity";
import PeerDraftPlugin from "src/main";

export class SharedFolder extends SharedEntity {

  root: TFolder

  static async fromTFolder(root: TFolder, plugin: PeerDraftPlugin) {
    const files = this.getAllFilesInFolder(root)

    // check if docs for some of them are already there
    for (const file of files) {
      if (SharedDocument.findByPath(file.path)) {
        showNotice("You can not share a directory that already has shared files in it (right now).")
        return
      }
    }

    const docs = await Promise.all(files.map((file) => {
      return SharedDocument.fromTFile(file, plugin)
    }))

    const folder = new SharedFolder(root, plugin)
    
    for (const doc of docs) {
      folder.addDocument(doc)
    }

    // register doc at central
    // save doc in db

    console.log(folder.getDocsFragment().toJSON())
    
    return folder

  }

  private constructor(root: TFolder, plugin: PeerDraftPlugin) {
    super(plugin)
    this.root = root
    this.yDoc = new Y.Doc()
    this._shareId = createRandomId()
    this.yDoc.getText("shareId").insert(0, this.shareId)
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

}