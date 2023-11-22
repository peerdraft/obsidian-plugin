import { Plugin, TFile } from 'obsidian';
import { yCollab } from 'y-codemirror.next';
import { getOrCreateSyncData } from './document';
import { Settings } from './settings';
import { randomUint32 } from './tools';
import Y from './yjs';
import { extensions } from './data';

export const usercolors = [
  { dark: '#30bced', light: '#30bced33' },
  { dark: '#6eeb83', light: '#6eeb8333' },
  { dark: '#ffbc42', light: '#ffbc4233' },
  { dark: '#ecd444', light: '#ecd44433' },
  { dark: '#ee6352', light: '#ee635233' },
  { dark: '#9ac2c9', light: '#9ac2c933' },
  { dark: '#8acb88', light: '#8acb8833' },
  { dark: '#1be7ff', light: '#1be7ff33' }
]

export const userColor = usercolors[randomUint32() % usercolors.length]

export const getOrCreateExtension = (id: string, settings: Settings) => {
  if(!extensions[id]){
    const syncData = getOrCreateSyncData(id, settings)
    const undoManager = new Y.UndoManager(syncData.content)
    syncData.provider.awareness.setLocalStateField('user', {
      name: settings.name,
      color: userColor.dark,
      colorLight: userColor.light
    })
    extensions[id] = yCollab(syncData.content, syncData.provider.awareness, { undoManager })
  }
  return extensions[id]
}

export const removeExtensions = (fileToRemove: TFile, plugin: Plugin) => {
  // doesn't do anything right now. Refresh of cm does not work properly on ending the provider
}