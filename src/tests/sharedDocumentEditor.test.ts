import { TFile } from 'obsidian'
import { getLeafIdsByPath } from '../workspace/peerdraftWorkspace'
import type { Node } from '../ui/canvas'
import { Compartment } from '@codemirror/state'
import * as Y from 'yjs'
import type PeerdraftPlugin from '../peerdraftPlugin'
import { SharedDocument } from '../sharedEntities/sharedDocument'
import { PeerdraftRecord } from '../utils/peerdraftRecord'

jest.mock('../main', () => ({ __esModule: true, default: class {} }))
jest.mock('../sharedEntities/sharedFolder', () => ({ SharedFolder: class {} }))
jest.mock('../sharedEntities/canvas', () => ({}))
jest.mock('../permanentShareStoreFS', () => ({ getDocByPath: jest.fn() }))
jest.mock('../ui/login', () => ({}))
jest.mock('../ui/enterText', () => ({}))
jest.mock('../ui/canvas', () => ({}))
jest.mock('../peerdraftWebSocketProvider', () => ({ StopSessionError: class extends Error {} }))
jest.mock('../workspace/peerdraftWorkspace', () => ({ getLeafIdsByPath: jest.fn(() => []) }))
jest.mock('../workspace/explorerView', () => ({
  setStatusClass: jest.fn().mockResolvedValue(undefined),
  removeStatusClass: jest.fn().mockResolvedValue(undefined),
  removeIsSharedClass: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../ui', () => ({ usercolors: [{ dark: '#000', light: '#fff' }], showNotice: jest.fn() }))
jest.mock('y-codemirror.next', () => ({ yCollab: jest.fn(() => []) }))
jest.mock('y-webrtc', () => ({ WebrtcProvider: class {} }))
jest.mock('tiny-jsonc', () => ({ __esModule: true, default: { parse: JSON.parse } }))

function fixture(editorContent: string, sharedContent: string) {
  const yDoc = new Y.Doc()
  yDoc.getText('content').insert(0, sharedContent)
  const editor = {
    getValue: jest.fn(() => editorContent),
    setValue: jest.fn(),
    cm: { dispatch: jest.fn() },
  }
  const extensions = new PeerdraftRecord<Compartment>()
  const pLeaf = { path: 'note.md', isPreview: false, once: jest.fn() }
  const plugin = {
    pws: { markdown: { get: () => pLeaf } },
    app: { workspace: { getLeafById: () => ({ view: { editor } }) } },
  } as unknown as PeerdraftPlugin
  // Use the real attachment methods, substituting constructor-owned integration
  // state so this test does not start IndexedDB, networking, or Obsidian editors.
  const doc: SharedDocument = Object.assign(Object.create(SharedDocument.prototype), {
    yDoc, plugin, _path: 'note.md', _extensions: extensions, isCanvas: false,
    startWebRTCSync: jest.fn(() => ({ awareness: {} })),
  })
  const node = { id: 'node', file: { path: 'note.md' }, child: { editor } } as unknown as Node
  return { doc, node, editor, extensions, destroy: () => yDoc.destroy() }
}

describe.each(['Markdown leaf', 'Canvas file node'])('%s attachment', kind => {
  test('does not replace identical text but still attaches collaboration', () => {
    const f = fixture('Already up to date', 'Already up to date')
    try {
      if (kind === 'Markdown leaf') f.doc.addExtensionToLeaf('leaf')
      else f.doc.addExtensionToCanvasFileNode(f.node)

      expect(f.editor.setValue).not.toHaveBeenCalled()
      expect(f.editor.cm.dispatch).toHaveBeenCalledTimes(1)
      expect(f.extensions.size).toBe(1)
    } finally { f.destroy() }
  })

  test('retains replacement for different text and does not attach twice', () => {
    const f = fixture('Previous text', 'Current shared text')
    try {
      for (let i = 0; i < 2; i++) {
        if (kind === 'Markdown leaf') f.doc.addExtensionToLeaf('leaf')
        else f.doc.addExtensionToCanvasFileNode(f.node)
      }

      expect(f.editor.setValue).toHaveBeenCalledTimes(1)
      expect(f.editor.setValue).toHaveBeenCalledWith('Current shared text')
      expect(f.editor.cm.dispatch).toHaveBeenCalledTimes(1)
      expect(f.extensions.size).toBe(1)
    } finally { f.destroy() }
  })
})


async function flushStartup(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function restoredFixture(editorContent?: string, beforeRestore?: (context: {
  read: jest.Mock; modify: jest.Mock; plugin: PeerdraftPlugin
}) => void) {
  const file = Object.assign(new TFile(), {
    path: 'note.md', extension: 'md', stat: { mtime: 123, size: 20 },
  })
  const read = jest.fn().mockResolvedValue('Offline local edit')
  const modify = jest.fn().mockResolvedValue(undefined)
  const editor = {
    getValue: jest.fn(() => editorContent ?? ''),
    setValue: jest.fn(), cm: { dispatch: jest.fn() },
  }
  const view = { file, editor }
  const plugin = {
    settings: { name: 'Test', signaling: 'ws://local', debug: false },
    manifest: { version: '2.24.0' },
    log: jest.fn(), registerEvent: jest.fn(),
    activeStreamClient: { add: jest.fn() },
    serverSync: { on: jest.fn(), off: jest.fn(), sendSyncStep1: jest.fn(), sendUpdate: jest.fn(), wsconnected: true },
    pws: { markdown: { get: () => ({ path: 'note.md', isPreview: false, once: jest.fn() }) } },
    app: { vault: { getAbstractFileByPath: () => file, read, modify, on: jest.fn() },
      workspace: { getLeafById: () => ({ view }), getLeavesOfType: () => editorContent === undefined ? [] : [{ view }] } },
  } as unknown as PeerdraftPlugin
  beforeRestore?.({ read, modify, plugin })
  const doc = await SharedDocument.fromPermanentShareDocument({
    path: 'note.md', shareId: 'restored-share', persistenceId: 'local-cache',
  }, plugin)
  if (!doc) throw new Error('Fixture failed to restore document')
  jest.spyOn(doc, 'startWebRTCSync').mockReturnValue({ awareness: {} } as unknown as ReturnType<SharedDocument['startWebRTCSync']>)
  if (doc.getContentFragment().length === 0) {
    doc.yDoc.transact(() => doc.getContentFragment().insert(0, 'Cached old text'), 'cache')
  }
  return { doc, read, modify, editor, cleanup: async () => {
    await doc.destroy()
    doc.yDoc.destroy()
    jest.mocked(getLeafIdsByPath).mockReturnValue([])
    jest.restoreAllMocks()
  } }
}

describe('restored text-document readiness', () => {

  const loadCachedState = (): void => {
    jest.spyOn(SharedDocument.prototype, 'startIndexedDBSync').mockImplementation(async function(this: SharedDocument) {
      // Real factory/guard/SyncableDocument, with only persistence I/O substituted.
      this.yDoc.transact(() => this.getContentFragment().insert(0, 'Cached old text'), 'cache')
      jest.spyOn(this.syncable, 'indexedDBLoaded', 'get').mockReturnValue(true)
      this.syncable.emit('indexedDBLoaded', [{ wasEmpty: false }])
      return undefined
    })
  }

  test('the real cached factory defers its first request and active registration until local reconciliation', async () => {
    loadCachedState()
    let finishRead: (content: string) => void = () => {}
    let plugin: PeerdraftPlugin | undefined
    const restoring = restoredFixture(undefined, context => {
      plugin = context.plugin
      context.read.mockReturnValue(new Promise<string>(resolve => { finishRead = resolve }))
    })
    await flushStartup()
    try {
      expect(plugin?.serverSync.sendSyncStep1).not.toHaveBeenCalled()
      expect(plugin?.activeStreamClient.add).not.toHaveBeenCalled()
    } finally { finishRead('Offline local edit') }
    const f = await restoring
    try {
      expect(f.doc.initializationGuardPassed).toBe(true)
      expect(f.doc.getContentFragment().toString()).toBe('Offline local edit')
      expect(plugin?.serverSync.sendSyncStep1).toHaveBeenCalledTimes(1)
      expect(plugin?.activeStreamClient.add).toHaveBeenCalledTimes(1)
      expect(f.modify).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  test('a failed cached initialization keeps initial network work deferred until its retry succeeds', async () => {
    jest.useFakeTimers()
    loadCachedState()
    const log = jest.spyOn(console, 'error').mockImplementation(() => {})
    let plugin: PeerdraftPlugin | undefined
    const f = await restoredFixture(undefined, context => {
      plugin = context.plugin
      context.read.mockRejectedValue(new Error('Transient read failure'))
    })
    try {
      expect(f.doc.initializationGuardPassed).toBe(false)
      expect(plugin?.serverSync.sendSyncStep1).not.toHaveBeenCalled()
      expect(plugin?.activeStreamClient.add).not.toHaveBeenCalled()
      f.read.mockResolvedValue('Offline local edit')
      await jest.advanceTimersByTimeAsync(1000)
      await flushStartup()
      expect(f.doc.initializationGuardPassed).toBe(true)
      expect(plugin?.serverSync.sendSyncStep1).toHaveBeenCalledTimes(1)
      expect(plugin?.activeStreamClient.add).toHaveBeenCalledTimes(1)
      expect(f.doc.getContentFragment().toString()).toBe('Offline local edit')
      expect(f.modify).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
      log.mockRestore()
      jest.useRealTimers()
    }
  })


  test('does not expose an editor or write cached text before a slow local read finishes', async () => {
    jest.useFakeTimers()
    const f = await restoredFixture()
    let finishRead: (content: string) => void = () => {}
    f.read.mockReturnValue(new Promise<string>(resolve => { finishRead = resolve }))
    try {
      jest.spyOn(f.doc.syncable, 'indexedDBLoaded', 'get').mockReturnValue(true)
      f.doc.syncable.emit('indexedDBLoaded', [{ wasEmpty: false }])
      await flushStartup()
      expect(f.doc.initializationGuardPassed).toBe(false)
      expect(f.doc.syncable.canStartServerSync).toBe(false)
      await jest.advanceTimersByTimeAsync(1000)
      expect(f.modify).not.toHaveBeenCalled()
      expect(f.editor.setValue).not.toHaveBeenCalled()

      f.read.mockResolvedValue('Offline local edit')
      finishRead('Offline local edit')
      await flushStartup()
      expect(f.doc.initializationGuardPassed).toBe(true)
      expect(f.doc.syncable.canStartServerSync).toBe(true)
      expect(f.doc.getContentFragment().toString()).toBe('Offline local edit')
      expect(f.modify).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
      jest.useRealTimers()
    }
  })

  test('retries a transient local read failure without opening the write gate early', async () => {
    jest.useFakeTimers()
    const f = await restoredFixture()
    f.read.mockRejectedValueOnce(new Error('Temporary read failure')).mockResolvedValue('Offline local edit')
    const log = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      jest.spyOn(f.doc.syncable, 'indexedDBLoaded', 'get').mockReturnValue(true)
      f.doc.syncable.emit('indexedDBLoaded', [{ wasEmpty: false }])
      await flushStartup()
      expect(f.doc.initializationGuardPassed).toBe(false)
      expect(f.modify).not.toHaveBeenCalled()

      await jest.advanceTimersByTimeAsync(5000)
      await flushStartup()
      expect(f.doc.initializationGuardPassed).toBe(true)
      expect(f.doc.getContentFragment().toString()).toBe('Offline local edit')
      expect(f.modify).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalled()
    } finally {
      await f.cleanup()
      jest.useRealTimers()
    }
  })

  test('a clean stale editor receives newer server text instead of reverting it', async () => {
    const f = await restoredFixture('Offline local edit')
    jest.mocked(getLeafIdsByPath).mockReturnValue(['leaf'])
    f.doc.getContentFragment().delete(0, f.doc.getContentFragment().length)
    f.doc.getContentFragment().insert(0, 'Newer server text')
    try {
      f.doc.syncable._setServerSynced(true)
      await flushStartup()
      expect(f.doc.initializationGuardPassed).toBe(true)
      expect(f.doc.getContentFragment().toString()).toBe('Newer server text')
      expect(f.editor.setValue).toHaveBeenCalledWith('Newer server text')
    } finally { await f.cleanup() }
  })

  test.each(['Unsaved local editor text', ''])('preserves open editor text before collaboration attachment (%p)', async localText => {
    const f = await restoredFixture(localText)
    jest.mocked(getLeafIdsByPath).mockReturnValue(['leaf'])
    try {
      f.doc.syncable._setServerSynced(true)
      await flushStartup()
      expect(f.doc.initializationGuardPassed).toBe(true)
      expect(f.doc.getContentFragment().toString()).toBe(localText)
      expect(f.editor.setValue).not.toHaveBeenCalled()
      expect(f.editor.cm.dispatch).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
  })
})
