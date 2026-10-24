import * as Y from 'yjs'
import { SyncableDocument, type SyncableServerSync } from '../sharedEntities/syncableDocument'

function fixture(verify: () => Promise<string | null>) {
  const yDoc = new Y.Doc()
  const handlers = new Set<(id: string, hash: string) => void>()
  const server: SyncableServerSync = {
    on: (_event, handler) => { handlers.add(handler) },
    off: (_event, handler) => { handlers.delete(handler) },
    sendSyncStep1: jest.fn(), sendUpdate: jest.fn(),
  }
  const document = new SyncableDocument({
    yDoc, shareId: 'doc', isPermanent: true, serverSync: server, tryFastRestart: verify,
  })
  return { document, server, finish: () => { for (const handler of Array.from(handlers)) handler('doc', 'server-hash') },
    destroy: () => { document.destroy(); yDoc.destroy() } }
}

async function flush(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('verified restart completes normal sync state without a document handshake', async () => {
  const f = fixture(async () => 'verified-hash')
  try {
    const synced = jest.fn()
    f.document.on('serverSynced', synced)
    await expect(f.document.syncWithServer()).resolves.toBe('verified-hash')
    expect(f.document.serverSynced).toBe(true)
    expect(f.document.serverSyncing).toBe(false)
    expect(f.server.sendSyncStep1).not.toHaveBeenCalled()
    expect(synced).toHaveBeenCalledWith('verified-hash')
  } finally { f.destroy() }
})

test.each(['changed', 'error'])('%s verification uses one ordinary handshake for concurrent callers', async kind => {
  const f = fixture(async () => { if (kind === 'error') throw new Error('Unavailable'); return null })
  try {
    const first = f.document.syncWithServer()
    const second = f.document.syncWithServer()
    expect(second).toBe(first)
    await flush()
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
    f.finish()
    await expect(first).resolves.toBe('server-hash')
  } finally { f.destroy() }
})

test('an invalidation during a handshake performs a fresh exchange after it settles', async () => {
  const f = fixture(async () => null)
  try {
    const first = f.document.syncWithServer()
    await flush()
    const resync = f.document.resyncAfterCurrent()
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
    f.finish()
    await first
    await flush()
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(2)
    f.finish()
    await expect(resync).resolves.toBe('server-hash')
  } finally { f.destroy() }
})

test('a reconnect sends a fresh request rather than joining a lost socket flight', async () => {
  const f = fixture(async () => null)
  try {
    const first = f.document.syncWithServer()
    await flush()
    f.document.resetServerSyncFlight()
    const reconnect = f.document.syncWithServer()
    await flush()
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(2)
    f.finish()
    await Promise.all([first, reconnect])
    expect(f.document.serverSynced).toBe(true)
  } finally { f.destroy() }
})
