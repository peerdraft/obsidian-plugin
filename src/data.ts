import { WebrtcProvider } from 'y-webrtc'
import Y from './yjs'
import { YText } from 'yjs/dist/src/internals'
import { EditorView } from '@codemirror/view';
import { Compartment } from "@codemirror/state";

// Path of the doc -> sessionID
export const syncedDocs: Record<string, string> = {}

// sessionID -> sync Document
export const syncObjects: Record<string, {
  provider: WebrtcProvider,
  doc: Y.Doc,
  content: YText
}> = {}

// sessionID -> statusBar element
export const statusBars: Record<string, HTMLElement> = {}

// sessionID -> editors with active sessions
export const activeEditors: Record<string, Array<{
  editor: EditorView,
  // The compartment with the yCollab extension
  compartment: Compartment
}>> = {}