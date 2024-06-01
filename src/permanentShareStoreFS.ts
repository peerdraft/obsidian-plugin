import { SharedDocument } from "./sharedEntities/sharedDocument"
import { createRandomId, normalizePathPD } from "./tools"
import { SharedEntity } from "./sharedEntities/sharedEntity"
import { SharedFolder } from "./sharedEntities/sharedFolder"
import PeerdraftPlugin from "./peerdraftPlugin"
import { saveSettings } from "./settings"

export interface PermanentShareDocument {
  path: string, persistenceId: string, shareId: string
}

export interface PermanentShareFolder {
  path: string, persistenceId: string, shareId: string
}


export const add = async (doc: SharedEntity, plugin: PeerdraftPlugin) => {
  if (doc instanceof SharedDocument) {
    plugin.settings.serverShares.files.set(doc.path, {
      shareId: doc.shareId,
      persistenceId: createRandomId()
    })
  }
  if (doc instanceof SharedFolder) {
    plugin.settings.serverShares.folders.set(doc.path, {
      shareId: doc.shareId,
      persistenceId: createRandomId()
    })
  }
  saveSettings(plugin.settings, plugin)
}

export const removeDoc = async (path: string, plugin: PeerdraftPlugin) => {
  plugin.settings.serverShares.files.delete(path)
  saveSettings(plugin.settings, plugin)
}

export const getDocByPath = (path: string, plugin: PeerdraftPlugin) => {
  return plugin.settings.serverShares.files.get(path)
}

export const moveDoc = async (oldPath: string, newPath: string, plugin: PeerdraftPlugin) => {
  const files = plugin.settings.serverShares.files
  const entry = files.get(oldPath)
  if (entry) {
    files.delete(oldPath)
    files.set(newPath, entry)
    saveSettings(plugin.settings, plugin)
  }
}

export const removeFolder = async (path: string, plugin: PeerdraftPlugin) => {
  plugin.settings.serverShares.folders.delete(path)
  saveSettings(plugin.settings, plugin)
}

export const getFolderByPath = (path: string, plugin: PeerdraftPlugin) =>  {
  return plugin.settings.serverShares.folders.get(path)
}

export const moveFolder = async (oldPath: string, newPath: string, plugin: PeerdraftPlugin) => {
  const oldPathNormalized = normalizePathPD(oldPath)
  const newPathNormalized = normalizePathPD(newPath)
  const files = plugin.settings.serverShares.folders
  const entry = files.get(oldPathNormalized)
  if (entry) {
    files.delete(oldPathNormalized)
    files.set(newPathNormalized, entry)
    saveSettings(plugin.settings, plugin)
  }
}