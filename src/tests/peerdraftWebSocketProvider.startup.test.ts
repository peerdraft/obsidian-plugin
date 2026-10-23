import type { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { PeerdraftWebsocketProvider } from '../peerdraftWebSocketProvider'
import { SyncableDocument } from '../sharedEntities/syncableDocument'
import { SyncableFolder } from '../sharedEntities/syncableFolder'

class StartupWebSocket {
  static readonly OPEN = 1
  readyState = StartupWebSocket.OPEN
  binaryType = ''
  onopen: (() => Promise<void>) | null = null
  onclose: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  send(_message: Uint8Array): void {}
  close(): void { this.onclose?.({}) }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('PeerdraftWebsocketProvider startup reconnect targets', () => {
  const originalWebSocket = global.WebSocket
  let provider: PeerdraftWebsocketProvider
  let socket: StartupWebSocket
  let entities: Array<SyncableDocument | SyncableFolder>

  const document = (id: string, permanent = true): SyncableDocument => {
    const entity = new SyncableDocument({
      yDoc: new Y.Doc(), shareId: id, isPermanent: permanent, serverSync: provider,
    })
    entities.push(entity)
    jest.spyOn(entity, 'syncWithServer').mockResolvedValue('hash')
    return entity
  }

  const folder = (id: string): SyncableFolder => {
    const entity = new SyncableFolder({ yDoc: new Y.Doc(), shareId: id, serverSync: provider })
    entities.push(entity)
    jest.spyOn(entity, 'syncWithServer').mockResolvedValue('hash')
    return entity
  }

  beforeEach(() => {
    jest.useFakeTimers()
    global.WebSocket = StartupWebSocket as unknown as typeof WebSocket
    entities = []
    provider = new PeerdraftWebsocketProvider('ws://startup-test', { connect: false })
    provider.connect()
    socket = provider.ws as unknown as StartupWebSocket
  })

  afterEach(() => {
    jest.restoreAllMocks()
    for (const entity of entities) {
      entity.destroy()
      entity.yDoc.destroy()
    }
    provider.destroy()
    global.WebSocket = originalWebSocket
    jest.useRealTimers()
  })

  test('startup-created documents wait for their cache and request only their own initial sync', async () => {
    const cacheReady = deferred()
    let restored!: SyncableDocument
    // The real startup continuation constructs models after connected() resolves,
    // then performs the initial sync only after IndexedDB has finished loading.
    const restoration = provider.connected().then(async () => {
      restored = document('restored-document')
      await cacheReady.promise
      await restored.syncWithServer()
    })

    await socket.onopen?.()
    const callsBeforeCacheReady = jest.mocked(restored.syncWithServer).mock.calls.length
    cacheReady.resolve()
    await restoration

    expect(callsBeforeCacheReady).toBe(0)
    expect(restored.syncWithServer).toHaveBeenCalledTimes(1)
  })

  test('models registered by synchronous connected listeners are excluded from reconnect work', async () => {
    const newlyRegistered: Array<SyncableDocument | SyncableFolder> = []
    provider.on('status', ({ status }) => {
      if (status === 'connected') {
        newlyRegistered.push(document('status-document'), folder('status-folder'))
      }
    })
    provider.on('connected', () => {
      newlyRegistered.push(document('connected-document'), folder('connected-folder'))
    })

    await socket.onopen?.()

    expect(newlyRegistered).toHaveLength(4)
    for (const entity of newlyRegistered) expect(entity.syncWithServer).not.toHaveBeenCalled()
  })

  test('a reconnect leaves cache-backed local initialization to its owning factory', async () => {
    let localReady = false
    const entity = new SyncableDocument({
      yDoc: new Y.Doc(), shareId: 'initializing-document', isPermanent: true, serverSync: provider,
      canStartServerSync: () => localReady,
    })
    entities.push(entity)
    const sync = jest.spyOn(entity, 'syncWithServer').mockResolvedValue('hash')

    await socket.onopen?.()
    expect(sync).not.toHaveBeenCalled()
    localReady = true
    await entity.syncWithServer()
    expect(sync).toHaveBeenCalledTimes(1)
    await socket.onopen?.()
    expect(sync).toHaveBeenCalledTimes(2)
  })

  test('existing folders and permanent documents reconnect after their caches are ready', async () => {
    const existingFolder = folder('existing-folder')
    const existingDocument = document('existing-document')
    const temporaryDocument = document('temporary-document', false)
    const folderCache = deferred()
    const documentCache = deferred()
    jest.spyOn(existingFolder, 'indexedDBProvider', 'get').mockReturnValue({
      synced: false, whenSynced: folderCache.promise,
    } as unknown as IndexeddbPersistence)
    jest.spyOn(existingDocument, 'indexedDBProvider', 'get').mockReturnValue({
      synced: false, whenSynced: documentCache.promise,
    } as unknown as IndexeddbPersistence)

    const opening = socket.onopen?.()
    await Promise.resolve()
    expect(existingFolder.syncWithServer).not.toHaveBeenCalled()
    expect(existingDocument.syncWithServer).not.toHaveBeenCalled()
    folderCache.resolve()
    await jest.advanceTimersByTimeAsync(0)
    expect(existingFolder.syncWithServer).toHaveBeenCalledTimes(1)
    expect(existingDocument.syncWithServer).not.toHaveBeenCalled()
    documentCache.resolve()
    await opening

    expect(existingFolder.syncWithServer).toHaveBeenCalledTimes(1)
    expect(existingDocument.syncWithServer).toHaveBeenCalledTimes(1)
    expect(temporaryDocument.syncWithServer).not.toHaveBeenCalled()

    await socket.onopen?.()
    expect(existingFolder.syncWithServer).toHaveBeenCalledTimes(2)
    expect(existingDocument.syncWithServer).toHaveBeenCalledTimes(2)
    expect(temporaryDocument.syncWithServer).not.toHaveBeenCalled()
  })
})
