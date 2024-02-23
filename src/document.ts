import { WebrtcProvider } from 'y-webrtc'
import * as Y from 'yjs'
import { syncObjects } from './data'
import { createRandomId, generateRandomString } from './tools'
import { App, TFile, TFolder, Vault } from 'obsidian'
import * as path from 'path'

export const getOrCreateSyncData = (id: string, settings: { signaling: string }) => {
  if (!syncObjects[id]) {
    const doc = new Y.Doc()
    const provider = new WebrtcProvider(id, doc, { signaling: [settings.signaling] })
    const text = doc.getText("content")
    syncObjects[id] = { doc, provider, content: text }
  }
  return syncObjects[id]
}

export const initDocument = (initial: string, settings: { signaling: string }) => {
  const id = createRandomId()
  const { content, doc, provider } = getOrCreateSyncData(id, settings)
  doc.getText("owner").insert(0, provider.awareness.clientID.toFixed(0))
  content.insert(0, initial)
  return id
}

export const initDocumentToJoin = (id: string, settings: { signaling: string }) => {
  return getOrCreateSyncData(id, settings)
}

export const stopSync = (id: string) => {
  console.log("stopping sync for " + id)
  const syncData = syncObjects[id]
  if (!syncData) return
  syncData.provider.awareness.destroy()
  syncData.provider.disconnect()
  syncData.provider.destroy()

  delete syncObjects[id]
  console.log("sync stopped")
}

export const getContentFromDoc = (id: string) => {
  const sync = syncObjects[id]
  if (!sync) return
  return sync.doc.getText("content").toString()
}

export const createDocumentWithSyncId = async (id: string, app: App) => {
  const initialFileName = `_peerdraft_session_${id}_${generateRandomString()}.md`
  const parent = app.fileManager.getNewFileParent('', initialFileName)
  const filePath = path.join(parent.path, initialFileName)
  try {
    const file = await app.vault.create(filePath, '')
    return { file: file, id }
  } catch {

  }

  return
  
}