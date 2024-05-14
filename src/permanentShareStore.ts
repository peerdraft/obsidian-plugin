import Dexie, { Table } from "dexie"
import { SharedDocument } from "./sharedEntities/sharedDocument"
import { createRandomId } from "./tools"
import { SharedEntity } from "./sharedEntities/sharedEntity"
import { SharedFolder } from "./sharedEntities/sharedFolder"


export interface PermanentShareDocument {
  path: string, persistenceId: string, shareId: string 
}

export interface PermanentShareFolder {
  path: string, persistenceId: string, shareId: string 
}

export class PermanentShareStoreIndexedDB {

  oid: string
  private documentTable: Table<PermanentShareDocument, string>
  private folderTable: Table<PermanentShareFolder, string>
  private db: Dexie

  keepOpen: boolean = true

  constructor(oid: string) {
    this.oid = oid
    this.db = new Dexie('peerdraft_' + this.oid)
    this.db.version(2).stores({
      sharedDocs: "path,persistenceId,shareId",
      sharedFolders: "path,persistenceId,shareId"
    })
    this.db.on("close", () => {
      if(this.keepOpen) {
        this.db.open()
      }
    })
    this.documentTable = this.db._allTables["sharedDocs"] as Table<PermanentShareDocument, string>
    this.folderTable = this.db._allTables["sharedFolders"] as Table<PermanentShareFolder, string>
  }

  close(){
    this.keepOpen = false
    this.db.close()
  }

  add(doc: SharedEntity) {
    if(doc instanceof SharedDocument){
      return this.documentTable.add({
        path: doc.path,
        shareId: doc.shareId,
        persistenceId: createRandomId()
      })
    }
    if(doc instanceof SharedFolder){
      return this.folderTable.add({
        path: doc.path,
        shareId: doc.shareId,
        persistenceId: createRandomId()
      })
    }
  }

  removeDoc(path: string) {
    return this.documentTable.delete(path)
  }

  async getDocByPath(path: string) {
    return this.documentTable.get(path)
  }

  getAllDocs() {
    return this.documentTable.toArray()
  }

  removeFolder(path: string) {
    return this.folderTable.delete(path)
  }

  getAllFolders() {
    return this.folderTable.toArray()
  }

  async getFolderByPath(path: string) {
    return this.folderTable.get(path)
  }


  async deleteDB() {
    window.indexedDB.deleteDatabase(this.folderTable.name)
    window.indexedDB.deleteDatabase(this.documentTable.name)
  }

}