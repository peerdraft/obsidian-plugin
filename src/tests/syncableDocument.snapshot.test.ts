import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { SyncableDocument, type SyncableServerSync } from '../sharedEntities/syncableDocument'
import { checkIndexedDBAlreadyExists } from '../tools'

function mockCommitDatabase(autoComplete = true): { db: IDBDatabase; transaction: IDBTransaction; request: IDBRequest<number> } {
  const request = { onsuccess: null, onerror: null } as unknown as IDBRequest<number>
  const transaction = {
    oncomplete: null, onerror: null, onabort: null, error: null,
    objectStore: jest.fn(() => ({ add: jest.fn((_state: Uint8Array) => {
      if (autoComplete) queueMicrotask(() => transaction.oncomplete?.(new Event('complete')))
      return request
    }) })),
    abort: jest.fn(() => transaction.onabort?.(new Event('abort'))),
  } as unknown as IDBTransaction
  const db = { transaction: jest.fn(() => transaction) } as unknown as IDBDatabase
  return { db, transaction, request }
}

jest.mock('../tools', () => ({
  calculateHash: (text: string) => 'hash:' + text,
  checkIndexedDBAlreadyExists: jest.fn(),
}))
jest.mock('y-indexeddb', () => ({
  IndexeddbPersistence: jest.fn().mockImplementation(() => ({
    synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: mockCommitDatabase().db,
  })),
}))

function fixture(): { document: SyncableDocument; server: SyncableServerSync; destroy(): void } {
  const server: SyncableServerSync = {
    on: jest.fn(), off: jest.fn(), sendSyncStep1: jest.fn(), sendUpdate: jest.fn(),
  }
  const document = new SyncableDocument({ yDoc: new Y.Doc(), shareId: 'doc', isPermanent: true, serverSync: server })
  return { document, server, destroy: () => { document.destroy(); document.yDoc.destroy() } }
}

beforeEach(() => { jest.clearAllMocks(); jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(false) })

test('accepted verified snapshot completes sync and starts deferred cache without network exchange', async () => {
  const f = fixture()
  try {
    await f.document.startIndexedDBSync('imported')
    expect(f.document.isIndexedDBDeferred).toBe(true)
    const synced = jest.fn()
    const serverSynced = jest.fn()
    const stateChanged = jest.fn()
    f.document.on('synced', synced)
    f.document.on('serverSynced', serverSynced)
    f.document.on('syncStateChanged', stateChanged)
    expect(f.document.acceptServerSnapshot('hash:', () => true)).toBe(true)
    await f.document.whenIndexedDBSynced()
    expect(f.document.serverSynced).toBe(true)
    expect(f.document.serverSyncing).toBe(false)
    expect(f.document.isFullyInitialized).toBe(true)
    expect(f.document.isIndexedDBDeferred).toBe(false)
    expect(IndexeddbPersistence).toHaveBeenCalledWith('peerdraft_persistence_imported', f.document.yDoc)
    expect(synced).toHaveBeenCalledWith('hash:')
    expect(serverSynced).toHaveBeenCalledWith('hash:')
    expect(stateChanged).toHaveBeenCalled()
    expect(f.server.sendSyncStep1).not.toHaveBeenCalled()
    expect(f.server.sendUpdate).not.toHaveBeenCalled()
  } finally { f.destroy() }
})

test.each(['stale-guard', 'destroyed', 'changed-checksum', 'active-handshake'])('refuses snapshot acceptance for %s', async cause => {
  const f = fixture()
  try {
    const synced = jest.fn()
    f.document.on('serverSynced', synced)
    if (cause === 'destroyed') f.document.destroy()
    if (cause === 'active-handshake') void f.document.syncWithServer()
    const accepted = f.document.acceptServerSnapshot(cause === 'changed-checksum' ? 'different' : 'hash:', () => cause !== 'stale-guard')
    expect(accepted).toBe(false)
    expect(f.document.serverSynced).toBe(false)
    expect(synced).not.toHaveBeenCalled()
    expect(IndexeddbPersistence).not.toHaveBeenCalled()
  } finally { f.destroy() }
})

test('destroying a document with deferred cache removes acceptance side effects', async () => {
  const f = fixture()
  await f.document.startIndexedDBSync('cancelled')
  f.destroy()
  expect(f.document.acceptServerSnapshot('hash:', () => true)).toBe(false)
  expect(f.document.isIndexedDBDeferred).toBe(false)
  expect(IndexeddbPersistence).not.toHaveBeenCalled()
})

test('stopping persistence rejects a pending commit barrier and removes its transaction handlers', async () => {
  const f = fixture()
  const commit = mockCommitDatabase(false)
  try {
    jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(true)
    jest.mocked(IndexeddbPersistence).mockImplementationOnce(() => ({
      synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: commit.db,
    } as unknown as IndexeddbPersistence))
    await f.document.startIndexedDBSync('stopped')
    const pending = f.document.whenPersistenceSettled()
    const rejected = expect(pending).rejects.toThrow('stopped')
    await Promise.resolve()
    await f.document.stopIndexedDBSync()
    await rejected
    expect(commit.transaction.oncomplete).toBeNull()
    expect(commit.transaction.onabort).toBeNull()
    expect(commit.transaction.onerror).toBeNull()
    expect(commit.transaction.abort).toHaveBeenCalledTimes(1)
  } finally { f.destroy() }
})

test('destroying a deferred-cache document rejects a barrier still waiting for initialization', async () => {
  const f = fixture()
  await f.document.startIndexedDBSync('never-created')
  const pending = f.document.whenPersistenceSettled()
  const rejected = expect(pending).rejects.toThrow('destroyed')
  f.destroy()
  await rejected
})


test('a synchronous failure adding the complete snapshot aborts the transaction and rejects durability', async () => {
  const f = fixture()
  const commit = mockCommitDatabase(false)
  try {
    jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(true)
    jest.mocked(IndexeddbPersistence).mockImplementationOnce(() => ({
      synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: commit.db,
    } as unknown as IndexeddbPersistence))
    ;(commit.transaction.objectStore as jest.Mock).mockReturnValue({ add: () => { throw new Error('Quota exceeded') } })
    await f.document.startIndexedDBSync('quota')
    await expect(f.document.whenPersistenceSettled()).rejects.toThrow('Quota exceeded')
    expect(commit.transaction.abort).toHaveBeenCalledTimes(1)
  } finally { f.destroy() }
})

let fakeIndexedDB: IDBFactory | undefined
try {
  // Reuse the backend's existing development dependency without requiring it
  // for standalone plugin installations.
  fakeIndexedDB = (require('../../../app/node_modules/fake-indexeddb') as { indexedDB: IDBFactory }).indexedDB
} catch { /* The integration test is optional when the sibling backend is absent. */ }
const testWithIndexedDB = fakeIndexedDB ? test : test.skip

testWithIndexedDB('an aborted initial seed is repaired by a committed full snapshot that replays into a fresh document', async () => {
  const f = fixture()
  const reopened = new Y.Doc()
  const previousClone = globalThis.structuredClone
  let db: IDBDatabase | undefined
  try {
    if (!globalThis.structuredClone) {
      const v8 = require('node:v8') as { serialize(value: unknown): Uint8Array; deserialize(value: Uint8Array): unknown }
      Object.defineProperty(globalThis, 'structuredClone', { configurable: true, writable: true,
        value: (value: unknown) => v8.deserialize(v8.serialize(value)) })
    }
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = fakeIndexedDB!.open('aborted-seed-' + Date.now(), 1)
      open.onupgradeneeded = () => open.result.createObjectStore('updates', { autoIncrement: true })
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    f.document.yDoc.getText('content').insert(0, 'Complete current text with obsolete tail')
    f.document.yDoc.getText('content').delete(21, 18)
    f.document.yDoc.getMap('metadata').set('important', 'preserved after initial abort')
    const initial = db.transaction('updates', 'readwrite')
    const aborted = new Promise<void>(resolve => { initial.onabort = () => resolve() })
    initial.objectStore('updates').add(Y.encodeStateAsUpdate(f.document.yDoc))
    initial.abort()
    await aborted
    const readUpdates = (): Promise<Uint8Array[]> => new Promise((resolve, reject) => {
      const request = db!.transaction('updates', 'readonly').objectStore('updates').getAll()
      request.onsuccess = () => resolve(request.result as Uint8Array[])
      request.onerror = () => reject(request.error)
    })
    expect(await readUpdates()).toEqual([])
    jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(true)
    jest.mocked(IndexeddbPersistence).mockImplementationOnce(() => ({
      synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db,
    } as unknown as IndexeddbPersistence))
    await f.document.startIndexedDBSync('aborted-initial-seed')
    await f.document.whenPersistenceSettled()
    const updates = await readUpdates()
    expect(updates).toHaveLength(1)
    for (const update of updates) Y.applyUpdate(reopened, Uint8Array.from(update))
    expect(reopened.getText('content').toString()).toBe(f.document.yDoc.getText('content').toString())
    expect(reopened.getMap('metadata').get('important')).toBe('preserved after initial abort')
    expect(Y.encodeStateAsUpdate(reopened)).toEqual(Y.encodeStateAsUpdate(f.document.yDoc))
  } finally {
    f.destroy(); reopened.destroy(); db?.close()
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, writable: true, value: previousClone })
  }
})
