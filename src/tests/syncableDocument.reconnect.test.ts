import * as Y from 'yjs'
import { SyncableDocument, type SyncableFileIO, type SyncableServerSnapshot } from '../sharedEntities/syncableDocument'

jest.mock('../tools', () => ({
  calculateHash: (text: string) => text,
  checkIndexedDBAlreadyExists: jest.fn().mockResolvedValue(true),
}))
jest.mock('y-indexeddb', () => ({
  IndexeddbPersistence: jest.fn().mockImplementation(() => ({
    synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(),
  })),
}))

const original = 'Title: old.\nComments.'
const replacement = 'Title: new.\nComments.'
const verify = { initialState: 'cached' as const, verifyCachedServer: true }

function clone(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

async function fixture(pendingCacheEdit = false) {
  const base = new Y.Doc()
  base.getText('content').insert(0, original)
  const cached = clone(base)
  const server = clone(base)
  base.destroy()
  const serverText = server.getText('content')
  server.transact(() => { serverText.delete(7, 3); serverText.insert(7, 'new') })
  if (pendingCacheEdit) cached.getText('content').insert(cached.getText('content').length, '\nCached edit.')
  let disk = replacement
  let mtime = 123
  let editor: string | undefined
  let snapshotCurrent = true
  const snapshots: Array<{ doc: Y.Doc; destroy: jest.SpyInstance }> = []
  const createSnapshot = (): SyncableServerSnapshot => {
    const doc = clone(server)
    snapshots.push({ doc, destroy: jest.spyOn(doc, 'destroy') })
    return { doc, isCurrent: () => snapshotCurrent }
  }
  const loadSnapshot = jest.fn(async () => createSnapshot())
  const fileIO: SyncableFileIO = {
    read: jest.fn(async () => disk), modify: jest.fn(async () => {}), getMTime: () => mtime,
  }
  const sendUpdate = jest.fn()
  const document = new SyncableDocument({
    yDoc: cached, shareId: 'doc', isPermanent: true, fileIO,
    serverSync: { on: jest.fn(), off: jest.fn(), sendSyncStep1: jest.fn(), sendUpdate },
    loadInitialServerSnapshot: loadSnapshot,
  })
  await document.startIndexedDBSync('existing-cache')
  return {
    document, cached, server, fileIO, sendUpdate, loadSnapshot, snapshots, createSnapshot,
    readEditor: () => editor,
    setEditor: (value: string) => { editor = value },
    setDisk: (value: string) => { disk = value },
    bumpMtime: () => { mtime++ },
    expireSnapshot: () => { snapshotCurrent = false },
    cleanup: () => { document.destroy(); cached.destroy(); server.destroy() },
  }
}

describe('cached startup with text already on the server', () => {
  test('merges server character identities without inserting the same text again', async () => {
    const f = await fixture()
    try {
      const serverState = Y.encodeStateAsUpdate(f.server)
      await expect(f.document.reconcileWithFile(f.readEditor, verify)).resolves.toBe(true)
      expect(f.cached.getText('content').toString()).toBe(replacement)
      expect(Y.encodeStateAsUpdate(f.cached)).toEqual(serverState)
      expect(f.document.pendingUpdateCount).toBe(0)
      await f.document.flushPendingUpdates()
      expect(f.sendUpdate).not.toHaveBeenCalled()
      Y.applyUpdate(f.server, Y.encodeStateAsUpdate(f.cached))
      expect(f.server.getText('content').toString()).toBe(replacement)
      expect(f.snapshots[0].destroy).toHaveBeenCalledTimes(1)
    } finally { f.cleanup() }
  })

  test('keeps real cached operations when incorporating matching server history', async () => {
    const f = await fixture(true)
    try {
      await f.document.reconcileWithFile(f.readEditor, verify)
      expect(f.cached.getText('content').toString()).toBe(replacement + '\nCached edit.')
      Y.applyUpdate(f.server, Y.encodeStateAsUpdate(f.cached))
      expect(f.server.getText('content').toString()).toBe(replacement + '\nCached edit.')
      expect(f.document.pendingUpdateCount).toBe(0)
    } finally { f.cleanup() }
  })

  test('does not merge a different snapshot before applying existing local-edit behavior', async () => {
    const f = await fixture()
    f.server.getText('content').insert(0, 'Remote-only prefix. ')
    try {
      await f.document.reconcileWithFile(f.readEditor, verify)
      expect(f.cached.getText('content').toString()).toBe(replacement)
      expect(f.document.pendingUpdateCount).toBeGreaterThan(0)
      expect(f.server.getText('content').toString()).toBe('Remote-only prefix. ' + replacement)
      expect(f.snapshots[0].destroy).toHaveBeenCalledTimes(1)
    } finally { f.cleanup() }
  })

  test('does not download a snapshot when disk and cache already agree', async () => {
    const f = await fixture()
    f.setDisk(original)
    try {
      await f.document.reconcileWithFile(f.readEditor, verify)
      expect(f.loadSnapshot).not.toHaveBeenCalled()
      expect(f.cached.getText('content').toString()).toBe(original)
    } finally { f.cleanup() }
  })

  test('does not introduce snapshot checks into later ordinary local edits', async () => {
    const f = await fixture()
    try {
      await f.document.reconcileWithFile(f.readEditor)
      expect(f.loadSnapshot).not.toHaveBeenCalled()
      expect(f.cached.getText('content').toString()).toBe(replacement)
    } finally { f.cleanup() }
  })

  test('a failed imported-file attempt cannot bypass verification on retry', async () => {
    const f = await fixture()
    const imported = { initialState: 'imported' as const, verifyCachedServer: true }
    f.loadSnapshot.mockRejectedValueOnce(new Error('Snapshot unavailable'))
    try {
      await expect(f.document.reconcileWithFile(f.readEditor, imported)).rejects.toThrow('Snapshot unavailable')
      expect(f.cached.getText('content').toString()).toBe(original)
      expect(f.document.pendingUpdateCount).toBe(0)
      await expect(f.document.reconcileWithFile(f.readEditor, imported)).resolves.toBe(true)
      expect(f.loadSnapshot).toHaveBeenCalledTimes(2)
      expect(f.cached.getText('content').toString()).toBe(replacement)
      expect(f.document.pendingUpdateCount).toBe(0)
    } finally { f.cleanup() }
  })

  test.each(['mtime', 'disk-same-mtime', 'editor', 'delete-only', 'identity', 'adapter', 'destroyed', 'snapshot'] as const)(
    'rejects an obsolete snapshot after %s changes', async change => {
      const f = await fixture()
      let release = (): void => {}
      const pending = new Promise<void>(resolve => { release = resolve })
      f.loadSnapshot.mockImplementationOnce(async () => {
        const snapshot = f.createSnapshot()
        await pending
        return snapshot
      })
      const reconcile = f.document.reconcileWithFile(f.readEditor, verify)
      for (let i = 0; i < 15; i++) await Promise.resolve()
      expect(f.loadSnapshot).toHaveBeenCalledTimes(1)
      switch (change) {
        case 'mtime': f.bumpMtime(); break
        case 'disk-same-mtime': f.setDisk('Changed during download'); break
        case 'editor': f.setEditor('Unsaved editor changes'); break
        case 'delete-only': f.cached.getText('content').delete(0, 1); break
        case 'identity': f.document.setShareId('different-document'); break
        case 'adapter': f.document.setFileIO({ read: async () => 'Other file', modify: async () => {}, getMTime: () => 123 }); break
        case 'destroyed': f.document.destroy(); break
        case 'snapshot': f.expireSnapshot(); break
      }
      release()
      try {
        await expect(reconcile).resolves.toBe(false)
        expect(f.cached.getText('content').toString()).toBe(change === 'delete-only' ? original.slice(1) : original)
        expect(f.fileIO.modify).not.toHaveBeenCalled()
        expect(f.snapshots[0].destroy).toHaveBeenCalledTimes(1)
      } finally { release(); f.cleanup() }
    },
  )
})
