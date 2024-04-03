import Dexie, { Table } from "dexie"
import { SharedDocument } from "./sharedEntities/sharedDocument"
import { createRandomId } from "./tools"

export interface PermanentShareDocument {
  path: string, persistenceId: string, shareId: string 
}

export interface PermanentShareDirectory {
  path: string, persistenceId: string, shareId: string 
}

export class PermanentShareStore {

  oid: string
  documentTable: Table<PermanentShareDocument, string>
  directoryTable: Table<PermanentShareDirectory, string>

  constructor(oid: string) {
    this.oid = oid
    const db = new Dexie('peerdraft_' + this.oid)
    db.version(1).stores({
      sharedDocs: "path,persistenceId,shareId",
    })
    this.documentTable = db._allTables["sharedDocs"] as Table<PermanentShareDocument, string>
  }

  add(doc: SharedDocument) {
    return this.documentTable.add({
      path: doc.path,
      shareId: doc.shareId,
      persistenceId: createRandomId()
    })
  }

  removeDoc(path: string) {
    return this.documentTable.delete(path)
  }

  getAllDocs() {
    return this.documentTable.toArray()
  }

}