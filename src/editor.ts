import { Editor } from 'obsidian';
import { yCollab } from 'y-codemirror.next';
import { Compartment } from "@codemirror/state";
import { getOrCreateSyncData } from './document';
import { Settings } from './settings';
import { randomUint32 } from './tools';
import Y from './yjs';
import { StateEffect } from "@codemirror/state";
import { EditorView } from '@codemirror/view';
import { activeEditors } from './data';

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

export const addExtensionToEditor = (id: string, settings: Settings, editor: Editor) => {
  const extension = createExtensionForSession(id, settings)
  const compartment = new Compartment()
  const editorView = (editor as any).cm as EditorView;

  if (!activeEditors[id]) {
    activeEditors[id] = []
  }

  activeEditors[id].push({
    compartment,
    editor: editorView
  })

  editorView.dispatch({
    effects: StateEffect.appendConfig.of(compartment.of(extension))
  })
}

export const removeExtensionsForSession = (id: string) => {
  const actives = activeEditors[id]
  if (!actives) return
  for (const active of actives) {
    active.editor.dispatch({
      effects: active.compartment.reconfigure([])
    })
  }
}

export const createExtensionForSession = (id: string, settings: Settings) => {
  const syncData = getOrCreateSyncData(id, settings)
  const undoManager = new Y.UndoManager(syncData.content)
  syncData.provider.awareness.setLocalStateField('user', {
    name: settings.name,
    color: userColor.dark,
    colorLight: userColor.light
  })
  return yCollab(syncData.content, syncData.provider.awareness, { undoManager })
}