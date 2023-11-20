import { Extension } from '@codemirror/state'
import { WebrtcProvider } from 'y-webrtc'
import Y from './yjs'
import { YText } from 'yjs/dist/src/internals'

export const extensions: Record<string, Extension> = {}
export const syncedDocs: Record<string, string> = {}
export const syncObjects: Record<string, {
  provider: WebrtcProvider,
  doc: Y.Doc,
  content: YText
}> = {}
export const statusBars: Record<string, HTMLElement> = {}