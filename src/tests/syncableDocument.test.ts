/**
 * Unit tests for SyncableDocument state tracking
 *
 * Tests state flags, events, and computed states for sync state tracking
 * to prevent data loss when Y.Doc is out of sync with editor/file content.
 */

import { Mutex } from 'async-mutex'
import * as Y from 'yjs'

import {
  SyncableDocument,
  type SyncableFileIO,
  type SyncableClock,
  type SyncableServerSync,
  type SyncableLogger,
} from '../sharedEntities/syncableDocument'

// Mock tools
jest.mock('../tools', () => ({
  calculateHash: jest.fn((text: string) => 'mock-hash'),
  checkIndexedDBAlreadyExists: jest.fn(),
}))

// Mock y-indexeddb
jest.mock('y-indexeddb', () => ({
  IndexeddbPersistence: jest.fn().mockImplementation(() => ({
    synced: true,
    whenSynced: Promise.resolve(),
    destroy: jest.fn(),
  })),
}))

// Mock global indexedDB
const mockIndexedDB = {
  open: jest.fn(),
}

const createMockOpenRequest = (): IDBOpenDBRequest => {
  const request = {
    result: { close: jest.fn() },
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
    readyState: 'done',
    transaction: null,
    source: null,
    error: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }

  return request as unknown as IDBOpenDBRequest
}

const setIndexedDBExisting = (existed: boolean) => {
  const { checkIndexedDBAlreadyExists } = require('../tools')
  checkIndexedDBAlreadyExists.mockResolvedValue(existed)
}

global.indexedDB = mockIndexedDB as any

describe('SyncableDocument State Tracking', () => {
  let yDoc: Y.Doc
  let mockServerSync: SyncableServerSync
  let mockLogger: SyncableLogger
  let mockFileIO: SyncableFileIO
  let mockClock: SyncableClock
  let syncable: SyncableDocument
  let syncedHandlers: Array<(id: string, hash: string) => void> = []

  beforeEach(() => {
    yDoc = new Y.Doc()
    syncedHandlers = []

    // Reset indexedDB mock
    jest.clearAllMocks()
    setIndexedDBExisting(false)

    mockServerSync = {
      on: jest.fn((event: string, handler: (id: string, hash: string) => void) => {
        if (event === 'synced') {
          syncedHandlers.push(handler)
        }
      }),
      off: jest.fn((event: string, handler: (id: string, hash: string) => void) => {
        if (event === 'synced') {
          const index = syncedHandlers.indexOf(handler)
          if (index > -1) {
            syncedHandlers.splice(index, 1)
          }
        }
      }),
      sendSyncStep1: jest.fn(),
      sendUpdate: jest.fn(),
    }
    mockLogger = {
      log: jest.fn(),
    }
    mockFileIO = {
      read: jest.fn().mockResolvedValue(''),
      modify: jest.fn().mockResolvedValue(undefined),
      getMTime: jest.fn(() => 123),
    }
    mockClock = {
      now: jest.fn(() => Date.now()),
    }

    syncable = new SyncableDocument({
      yDoc,
      shareId: 'test-share-id',
      isPermanent: true,
      serverSync: mockServerSync,
      logger: mockLogger,
      fileIO: mockFileIO,
      clock: mockClock,
      flushIntervalMs: 1000,
    })
  })

  afterEach(() => {
    syncable.destroy()
    yDoc.destroy()
    jest.clearAllMocks()
  })

  describe('State Flags - Initial State', () => {
    test('should have false initial state flags', () => {
      expect(syncable.indexedDBLoaded).toBe(false)
      expect(syncable.indexedDBWasEmpty).toBe(false)
      expect(syncable.serverSyncing).toBe(false)
      expect(syncable.serverSynced).toBe(false)
    })
  })

  describe('Computed States - Initial State', () => {
    test('should have false computed states initially', () => {
      expect(syncable.isFullyInitialized).toBe(false)
      expect(syncable.isOffline).toBe(false)
    })
  })

  describe('IndexedDB State Tracking', () => {
    test('should set indexedDBLoaded and emit indexedDBLoaded event after startIndexedDBSync with existing DB', async () => {
      setIndexedDBExisting(true)
      const indexedDBLoadedHandler = jest.fn()
      syncable.on('indexedDBLoaded', indexedDBLoadedHandler)

      await syncable.startIndexedDBSync('test-persistence-id')

      expect(syncable.indexedDBLoaded).toBe(true)
      expect(indexedDBLoadedHandler).toHaveBeenCalledTimes(1)
      expect(indexedDBLoadedHandler).toHaveBeenCalledWith({ wasEmpty: expect.any(Boolean) })
    })

    test('should defer IndexedDB creation when DB does not exist and server has not synced', async () => {
      setIndexedDBExisting(false)
      const indexedDBLoadedHandler = jest.fn()
      syncable.on('indexedDBLoaded', indexedDBLoadedHandler)

      const result = await syncable.startIndexedDBSync('test-persistence-id')

      // IndexedDB should NOT be created yet - creation is deferred
      expect(result).toBeUndefined()
      expect(syncable.indexedDBLoaded).toBe(false)
      expect(syncable.indexedDBWasEmpty).toBe(false)
      expect(indexedDBLoadedHandler).not.toHaveBeenCalled()
    })

    test('should create IndexedDB immediately when server has already synced even if DB does not exist', async () => {
      setIndexedDBExisting(false)
      const indexedDBLoadedHandler = jest.fn()
      syncable.on('indexedDBLoaded', indexedDBLoadedHandler)

      // Sync with server first
      const syncPromise = syncable.syncWithServer()
      syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))
      await syncPromise

      // Now start IndexedDB - should create immediately since serverSynced is true
      await syncable.startIndexedDBSync('test-persistence-id')

      expect(syncable.indexedDBLoaded).toBe(true)
      expect(syncable.indexedDBWasEmpty).toBe(true) // new DB, but has data from server sync
      expect(indexedDBLoadedHandler).toHaveBeenCalledWith({ wasEmpty: true })
    })

    test('should create IndexedDB after server sync when previously deferred', async () => {
      setIndexedDBExisting(false)
      const indexedDBLoadedHandler = jest.fn()
      syncable.on('indexedDBLoaded', indexedDBLoadedHandler)

      // Start IndexedDB - should be deferred
      const result = await syncable.startIndexedDBSync('test-persistence-id')
      expect(result).toBeUndefined()
      expect(syncable.indexedDBLoaded).toBe(false)

      // Simulate server sync - should trigger deferred IndexedDB creation
      const syncPromise = syncable.syncWithServer()
      syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))
      await syncPromise

      // Wait for deferred IndexedDB creation to complete
      await syncable.whenIndexedDBSynced()

      expect(syncable.indexedDBLoaded).toBe(true)
      expect(indexedDBLoadedHandler).toHaveBeenCalledWith({ wasEmpty: true })
    })

    test('should detect non-empty IndexedDB when existing data found', async () => {
      setIndexedDBExisting(true)
      const indexedDBLoadedHandler = jest.fn()
      syncable.on('indexedDBLoaded', indexedDBLoadedHandler)

      await syncable.startIndexedDBSync('test-persistence-id')

      expect(syncable.indexedDBWasEmpty).toBe(false)
      expect(indexedDBLoadedHandler).toHaveBeenCalledWith({ wasEmpty: false })
    })

    test('should emit syncStateChanged after IndexedDB loads', async () => {
      setIndexedDBExisting(true)
      const syncStateChangedHandler = jest.fn()
      syncable.on('syncStateChanged', syncStateChangedHandler)

      await syncable.startIndexedDBSync('test-persistence-id')

      expect(syncStateChangedHandler).toHaveBeenCalledTimes(1)
      expect(syncStateChangedHandler).toHaveBeenCalledWith({
        indexedDBLoaded: true,
        indexedDBWasEmpty: false,
        serverSyncing: false,
        serverSynced: false,
        newDocConfirmed: false,
      })
    })

    test('should emit indexedDBLoadFailed and reset state on IndexedDB initialization error', async () => {
      setIndexedDBExisting(true) // DB must exist (or server synced) for creation to be attempted
      const { IndexeddbPersistence } = require('y-indexeddb')
      IndexeddbPersistence.mockImplementationOnce(() => {
        throw new Error('Quota exceeded')
      })

      const indexedDBLoadFailedHandler = jest.fn()
      const syncStateChangedHandler = jest.fn()
      syncable.on('indexedDBLoadFailed', indexedDBLoadFailedHandler)
      syncable.on('syncStateChanged', syncStateChangedHandler)

      await expect(syncable.startIndexedDBSync('test-persistence-id')).rejects.toThrow('Quota exceeded')

      expect(syncable.indexedDBLoaded).toBe(false)
      expect(syncable.indexedDBWasEmpty).toBe(false)
      expect(indexedDBLoadFailedHandler).toHaveBeenCalledWith(expect.any(Error))
      expect(syncStateChangedHandler).toHaveBeenCalledWith({
        indexedDBLoaded: false,
        indexedDBWasEmpty: false,
        serverSyncing: false,
        serverSynced: false,
        newDocConfirmed: false,
      })
    })
  })

  describe('Server Sync State Tracking', () => {
    test('should set serverSyncing and emit serverSyncing event on sync start', () => {
      const serverSyncingHandler = jest.fn()
      const syncStateChangedHandler = jest.fn()
      syncable.on('serverSyncing', serverSyncingHandler)
      syncable.on('syncStateChanged', syncStateChangedHandler)

      void syncable.syncWithServer()

      expect(syncable.serverSyncing).toBe(true)
      expect(serverSyncingHandler).toHaveBeenCalledTimes(1)
      expect(syncStateChangedHandler).toHaveBeenCalledTimes(1)
      expect(syncStateChangedHandler).toHaveBeenCalledWith({
        indexedDBLoaded: false,
        indexedDBWasEmpty: false,
        serverSyncing: true,
        serverSynced: false,
        newDocConfirmed: false,
      })
    })

    test('should set serverSynced and emit serverSynced event on successful sync', async () => {
      const serverSyncedHandler = jest.fn()
      const syncStateChangedHandler = jest.fn()
      syncable.on('serverSynced', serverSyncedHandler)
      syncable.on('syncStateChanged', syncStateChangedHandler)

      const syncPromise = syncable.syncWithServer()

      // Simulate successful sync
      syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

      await syncPromise

      expect(syncable.serverSyncing).toBe(false)
      expect(syncable.serverSynced).toBe(true)
      expect(serverSyncedHandler).toHaveBeenCalledTimes(1)
      expect(serverSyncedHandler).toHaveBeenCalledWith('test-hash')
      expect(syncStateChangedHandler).toHaveBeenCalledTimes(2) // start + success
      expect(syncStateChangedHandler).toHaveBeenNthCalledWith(1, {
        indexedDBLoaded: false,
        indexedDBWasEmpty: false,
        serverSyncing: true,
        serverSynced: false,
        newDocConfirmed: false,
      })
      expect(syncStateChangedHandler).toHaveBeenNthCalledWith(2, {
        indexedDBLoaded: false,
        indexedDBWasEmpty: false,
        serverSyncing: false,
        serverSynced: true,
        newDocConfirmed: false,
      })
    })

    test('should emit serverSyncFailed and clear serverSyncing on timeout', async () => {
      const serverSyncFailedHandler = jest.fn()
      const syncStateChangedHandler = jest.fn()
      syncable.on('serverSyncFailed', serverSyncFailedHandler)
      syncable.on('syncStateChanged', syncStateChangedHandler)

      const syncPromise = syncable.syncWithServer(10)

      await expect(syncPromise).rejects.toThrow('timed out')

      expect(syncable.serverSyncing).toBe(false)
      expect(syncable.serverSynced).toBe(false)
      expect(serverSyncFailedHandler).toHaveBeenCalledTimes(1)
      expect(serverSyncFailedHandler).toHaveBeenCalledWith(expect.any(Error))
      expect(syncStateChangedHandler).toHaveBeenCalledTimes(2) // start + failure
      expect(syncStateChangedHandler).toHaveBeenNthCalledWith(1, {
        indexedDBLoaded: false,
        indexedDBWasEmpty: false,
        serverSyncing: true,
        serverSynced: false,
        newDocConfirmed: false,
      })
      expect(syncStateChangedHandler).toHaveBeenNthCalledWith(2, {
        indexedDBLoaded: false,
        indexedDBWasEmpty: false,
        serverSyncing: false,
        serverSynced: false,
        newDocConfirmed: false,
      })
    })
  })

  describe('Computed States After State Changes', () => {
    test('isFullyInitialized should be true when IndexedDB loaded and server synced', async () => {
      setIndexedDBExisting(true)
      await syncable.startIndexedDBSync('test-persistence-id')

      const syncPromise = syncable.syncWithServer()

      syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

      await syncPromise

      expect(syncable.isFullyInitialized).toBe(true)
    })

    test('isOffline should be true when IndexedDB loaded but server not synced', async () => {
      setIndexedDBExisting(true)
      await syncable.startIndexedDBSync('test-persistence-id')

      expect(syncable.isOffline).toBe(true)
    })
  })

  describe('Backward Compatibility - Existing Events', () => {
    test('should still emit flushed event', async () => {
      const flushedHandler = jest.fn()
      syncable.on('flushed', flushedHandler)

      // Trigger a local update - syncable is permanent so updates are tracked
      yDoc.getText('content').insert(0, 'test')

      // Wait a tick for the update listener to process
      await new Promise(resolve => setTimeout(resolve, 10))

      // Force flush
      await syncable.flushPendingUpdates()

      expect(flushedHandler).toHaveBeenCalled()
    })

    test('should still emit synced event', async () => {
      const syncedHandler = jest.fn()
      syncable.on('synced', syncedHandler)

      const syncPromise = syncable.syncWithServer()

      syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

      await syncPromise

      expect(syncedHandler).toHaveBeenCalledTimes(1)
      expect(syncedHandler).toHaveBeenCalledWith('test-hash')
    })

    test('should still emit file-flushed event', async () => {
      const fileFlushedHandler = jest.fn()
      syncable.on('file-flushed', fileFlushedHandler)
      yDoc.getText('content').insert(0, 'changed content')

      await syncable.flushToFile()

      expect(fileFlushedHandler).toHaveBeenCalledTimes(1)
    })

    test('should still emit reconciled event when content differs', async () => {
      const reconciledHandler = jest.fn()
      syncable.on('reconciled', reconciledHandler)

      yDoc.getText('content').insert(0, 'original content')
      ;(mockFileIO.getMTime as jest.Mock).mockReturnValue(Date.now() - 1000)

      await syncable.reconcileWithFileContent('different content')

      expect(reconciledHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('Avoid unchanged-file writes during synchronization', () => {
    test('cache replay and repeated flushes preserve unchanged contents and mtime', async () => {
      const text = 'Already on disk\n'
      ;(mockFileIO.read as jest.Mock).mockResolvedValue(text)
      ;(mockFileIO.getMTime as jest.Mock).mockReturnValue(123)
      const fileFlushed = jest.fn()
      syncable.on('file-flushed', fileFlushed)
      yDoc.transact(() => yDoc.getText('content').insert(0, text), 'cached update')

      await syncable.flushToFile()
      await syncable.flushToFile()

      expect(mockFileIO.modify).not.toHaveBeenCalled()
      expect(mockFileIO.getMTime()).toBe(123)
      expect(mockClock.now).not.toHaveBeenCalled()
      expect(fileFlushed).not.toHaveBeenCalled()
    })

    test('does not reread an unchanged file immediately after local reconciliation', async () => {
      ;(mockFileIO.read as jest.Mock).mockResolvedValue('Already on disk')
      yDoc.getText('content').insert(0, 'Already on disk')
      await syncable.reconcileWithFile()
      expect(mockFileIO.read).toHaveBeenCalledTimes(1)

      await syncable.flushToFile()
      expect(mockFileIO.read).toHaveBeenCalledTimes(1)
      expect(mockFileIO.modify).not.toHaveBeenCalled()
    })

    test('still reads and writes a remote edit arriving after reconciliation', async () => {
      ;(mockFileIO.read as jest.Mock).mockResolvedValue('Already on disk')
      yDoc.getText('content').insert(0, 'Already on disk')
      await syncable.reconcileWithFile()
      yDoc.getText('content').insert(yDoc.getText('content').length, ' plus remote edit')

      await syncable.flushToFile()
      expect(mockFileIO.read).toHaveBeenCalledTimes(2)
      expect(mockFileIO.modify).toHaveBeenCalledWith('Already on disk plus remote edit', expect.anything())
    })

    test('writes changed remote content once, then skips an equal repeated flush', async () => {
      let diskContent = 'Old content'
      let mtime = 123
      ;(mockFileIO.read as jest.Mock).mockImplementation(async () => diskContent)
      ;(mockClock.now as jest.Mock).mockReturnValue(456)
      ;(mockFileIO.modify as jest.Mock).mockImplementation(async (content: string, opts: { mtime: number }) => {
        diskContent = content
        mtime = opts.mtime
      })
      const fileFlushed = jest.fn()
      syncable.on('file-flushed', fileFlushed)
      yDoc.transact(() => yDoc.getText('content').insert(0, 'Remote content'), 'server update')

      await syncable.flushToFile()
      await syncable.flushToFile()

      expect(diskContent).toBe('Remote content')
      expect(mtime).toBe(456)
      expect(mockFileIO.modify).toHaveBeenCalledTimes(1)
      expect(fileFlushed).toHaveBeenCalledTimes(1)
      expect(fileFlushed).toHaveBeenCalledWith(456)
    })

    test('uses the latest document when it changes during the file read', async () => {
      let finishRead: (content: string) => void = () => {}
      ;(mockFileIO.read as jest.Mock).mockReturnValue(new Promise<string>(resolve => { finishRead = resolve }))
      yDoc.getText('content').insert(0, 'First version')
      const pending = syncable.flushToFile()
      await Promise.resolve()
      yDoc.getText('content').insert(yDoc.getText('content').length, ' plus new changes')
      finishRead('Old disk content')
      await pending

      expect(mockFileIO.modify).toHaveBeenCalledWith('First version plus new changes', expect.anything())
    })

    test('skips a stale adapter replaced while its read is in flight', async () => {
      let finishRead: (content: string) => void = () => {}
      ;(mockFileIO.read as jest.Mock).mockReturnValue(new Promise<string>(resolve => { finishRead = resolve }))
      yDoc.getText('content').insert(0, 'Remote content')
      const pending = syncable.flushToFile()
      await Promise.resolve()
      const currentFileIO: SyncableFileIO = {
        read: jest.fn().mockResolvedValue('Old disk content'),
        modify: jest.fn().mockResolvedValue(undefined),
        getMTime: () => 123,
      }
      syncable.setFileIO(currentFileIO)
      finishRead('Old disk content')
      await pending
      expect(mockFileIO.modify).not.toHaveBeenCalled()
      expect(currentFileIO.modify).not.toHaveBeenCalled()

      await syncable.flushToFile()
      expect(currentFileIO.modify).toHaveBeenCalledWith('Remote content', expect.anything())
    })

    test('does not write if file syncing is removed during the read', async () => {
      let finishRead: (content: string) => void = () => {}
      ;(mockFileIO.read as jest.Mock).mockReturnValue(new Promise<string>(resolve => { finishRead = resolve }))
      yDoc.getText('content').insert(0, 'Remote content')
      const pending = syncable.flushToFile()
      await Promise.resolve()
      syncable.setFileIO(undefined)
      finishRead('Old disk content')
      await pending
      expect(mockFileIO.modify).not.toHaveBeenCalled()
    })

    test('preserves a local edit that arrives during an asynchronous flush read', async () => {
      let diskContent = 'Previous file'
      let mtime = 123
      let finishRead: (content: string) => void = () => {}
      ;(mockFileIO.getMTime as jest.Mock).mockImplementation(() => mtime)
      ;(mockFileIO.read as jest.Mock)
        .mockReturnValueOnce(new Promise<string>(resolve => { finishRead = resolve }))
        .mockImplementation(async () => diskContent)
      yDoc.getText('content').insert(0, 'Remote text')
      const flushing = syncable.flushToFile()
      await Promise.resolve()
      diskContent = 'Local edit during the read'
      mtime = 124
      finishRead('Previous file')
      await flushing
      for (let i = 0; i < 10; i++) await Promise.resolve()

      expect(mockFileIO.modify).not.toHaveBeenCalled()
      expect(yDoc.getText('content').toString()).toBe('Local edit during the read')
    })

    test('does not overwrite or emit a successful flush after a read failure', async () => {
      const error = new Error('Read failed')
      ;(mockFileIO.read as jest.Mock).mockRejectedValue(error)
      const fileFlushed = jest.fn()
      syncable.on('file-flushed', fileFlushed)

      await expect(syncable.flushToFile()).rejects.toBe(error)
      expect(mockFileIO.modify).not.toHaveBeenCalled()
      expect(fileFlushed).not.toHaveBeenCalled()
    })
  })

  describe('Initial local-content protection', () => {
    const createGated = (canWriteFile: () => boolean): void => {
      syncable.destroy()
      syncable = new SyncableDocument({
        yDoc, shareId: 'test-share-id', isPermanent: true, serverSync: mockServerSync,
        fileIO: mockFileIO, clock: mockClock, canWriteFile,
      })
    }

    test('cache replay cannot overwrite offline local edits before reconciliation', async () => {
      jest.useFakeTimers()
      let ready = false
      createGated(() => ready)
      ;(mockFileIO.read as jest.Mock).mockResolvedValue('Offline local edits')
      try {
        yDoc.transact(() => yDoc.getText('content').insert(0, 'Cached old text'), 'cache')
        await jest.advanceTimersByTimeAsync(1000)
        expect(mockFileIO.modify).not.toHaveBeenCalled()

        await syncable.reconcileWithFile()
        ready = true
        await syncable.flushToFile()

        expect(yDoc.getText('content').toString()).toBe('Offline local edits')
        expect(mockFileIO.modify).not.toHaveBeenCalled()
      } finally { jest.useRealTimers() }
    })

    test('initial read and reconciliation finish before a queued flush can write', async () => {
      let finishRead: (content: string) => void = () => {}
      ;(mockFileIO.read as jest.Mock)
        .mockReturnValueOnce(new Promise<string>(resolve => { finishRead = resolve }))
        .mockResolvedValue('Local edit')
      yDoc.getText('content').insert(0, 'Cached text')
      const reconcile = syncable.reconcileWithFile()
      await Promise.resolve()
      const flush = syncable.flushToFile()
      await Promise.resolve()
      expect(mockFileIO.modify).not.toHaveBeenCalled()
      finishRead('Local edit')
      await Promise.all([reconcile, flush])

      expect(yDoc.getText('content').toString()).toBe('Local edit')
      expect(mockFileIO.modify).not.toHaveBeenCalled()
    })

    test('initial reconciliation reports incomplete when its file adapter changes during the read', async () => {
      let finishRead: (content: string) => void = () => {}
      ;(mockFileIO.read as jest.Mock).mockReturnValue(new Promise<string>(resolve => { finishRead = resolve }))
      const pending = syncable.reconcileWithFile()
      await Promise.resolve()
      const currentFileIO: SyncableFileIO = {
        read: jest.fn().mockResolvedValue('Replacement local edits'),
        modify: jest.fn(), getMTime: () => 456,
      }
      syncable.setFileIO(currentFileIO)
      finishRead('Old file')
      await expect(pending).resolves.toBe(false)
      expect(currentFileIO.modify).not.toHaveBeenCalled()
      await expect(syncable.reconcileWithFile()).resolves.toBe(true)
      expect(yDoc.getText('content').toString()).toBe('Replacement local edits')
    })

    test('keeps an intentional empty editor edit instead of repairing it from cached text', async () => {
      yDoc.getText('content').insert(0, 'Cached text')
      ;(mockFileIO.read as jest.Mock).mockResolvedValue('Cached text')
      await syncable.reconcileWithFile(() => '')
      expect(yDoc.getText('content').toString()).toBe('')
    })

    test('retains saved local text for a closed file when its cache is unavailable', async () => {
      yDoc.getText('content').insert(0, 'Server text')
      ;(mockFileIO.read as jest.Mock).mockResolvedValue('Saved local changes')
      await syncable.reconcileWithFile(undefined, { initialState: 'server' })
      expect(yDoc.getText('content').toString()).toBe('Saved local changes')
      expect(mockFileIO.modify).not.toHaveBeenCalled()
    })

    test('a queued self-write echo cannot restore a stale snapshot over a newer update', async () => {
      let diskContent = 'Old disk text'
      let mtime = 123
      let echo: Promise<boolean> | undefined
      ;(mockFileIO.read as jest.Mock).mockImplementation(async () => diskContent)
      ;(mockFileIO.getMTime as jest.Mock).mockImplementation(() => mtime)
      ;(mockClock.now as jest.Mock).mockReturnValue(456)
      ;(mockFileIO.modify as jest.Mock).mockImplementation(async (content: string) => {
        diskContent = content
        mtime = 456
        // Obsidian can notify listeners before vault.modify() resolves.
        echo = syncable.reconcileWithFile()
        yDoc.getText('content').insert(yDoc.getText('content').length, ' + newer remote edit')
      })
      yDoc.getText('content').insert(0, 'Shared text')
      await syncable.flushToFile()
      await echo
      expect(yDoc.getText('content').toString()).toBe('Shared text + newer remote edit')
    })
  })

  describe('Data-loss guard: empty file vs non-empty Y.Doc', () => {
    test('should not delete Y.Doc content when file is empty', async () => {
      yDoc.getText('content').insert(0, 'real collaborative content')
      ;(mockFileIO.getMTime as jest.Mock).mockReturnValue(Date.now() - 1000)

      await syncable.reconcileWithFileContent('')

      expect(yDoc.getText('content').toString()).toBe('real collaborative content')
    })

    test('should write the Y.Doc content back into the empty file', async () => {
      yDoc.getText('content').insert(0, 'real collaborative content')
      ;(mockFileIO.getMTime as jest.Mock).mockReturnValue(Date.now() - 1000)

      await syncable.reconcileWithFileContent('')

      expect(mockFileIO.modify).toHaveBeenCalledWith('real collaborative content', expect.anything())
    })

    test('should still reconcile normally when both file and Y.Doc are empty', async () => {
      ;(mockFileIO.getMTime as jest.Mock).mockReturnValue(Date.now() - 1000)

      await syncable.reconcileWithFileContent('')

      expect(mockFileIO.modify).not.toHaveBeenCalled()
      expect(yDoc.getText('content').toString()).toBe('')
    })

    test('should still emit reconciled when repairing an empty file', async () => {
      const reconciledHandler = jest.fn()
      syncable.on('reconciled', reconciledHandler)

      yDoc.getText('content').insert(0, 'real collaborative content')
      ;(mockFileIO.getMTime as jest.Mock).mockReturnValue(Date.now() - 1000)

      await syncable.reconcileWithFileContent('')

      expect(reconciledHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('State Reset on Lifecycle Transitions', () => {
    test('should reset state flags on stopIndexedDBSync', async () => {
      setIndexedDBExisting(true)
      const syncStateChangedHandler = jest.fn()
      syncable.on('syncStateChanged', syncStateChangedHandler)

      // Start IndexedDB sync
      await syncable.startIndexedDBSync('test-persistence-id')

      expect(syncable.indexedDBLoaded).toBe(true)

      // Stop IndexedDB sync
      await syncable.stopIndexedDBSync()

      // State should be reset
      expect(syncable.indexedDBLoaded).toBe(false)
      expect(syncable.indexedDBWasEmpty).toBe(false)
      expect(syncStateChangedHandler).toHaveBeenCalledTimes(2) // load + reset
    })

    test('should clean up deferred IndexedDB on stopIndexedDBSync', async () => {
      setIndexedDBExisting(false)
      const syncStateChangedHandler = jest.fn()
      syncable.on('syncStateChanged', syncStateChangedHandler)

      // Start IndexedDB sync - should be deferred
      await syncable.startIndexedDBSync('test-persistence-id')
      expect(syncable.indexedDBLoaded).toBe(false)

      // Stop should clean up deferred state without error
      await syncable.stopIndexedDBSync()
      expect(syncable.indexedDBLoaded).toBe(false)
    })

    test('should reset state flags on destroy', async () => {
      setIndexedDBExisting(true)
      // Start IndexedDB sync
      await syncable.startIndexedDBSync('test-persistence-id')

      expect(syncable.indexedDBLoaded).toBe(true)

      // Destroy syncable
      syncable.destroy()

      // State should be reset
      expect(syncable.indexedDBLoaded).toBe(false)
      expect(syncable.indexedDBWasEmpty).toBe(false)
      expect(syncable.serverSyncing).toBe(false)
      expect(syncable.serverSynced).toBe(false)
    })

    test('should clean up deferred IndexedDB on destroy', async () => {
      setIndexedDBExisting(false)
      // Start IndexedDB sync - should be deferred
      await syncable.startIndexedDBSync('test-persistence-id')
      expect(syncable.indexedDBLoaded).toBe(false)

      // Destroy should clean up deferred state without error
      syncable.destroy()
      expect(syncable.indexedDBLoaded).toBe(false)
      expect(syncable.serverSynced).toBe(false)
    })

    test('should reset server sync state on setShareId change', () => {
      // Simulate successful sync
      void syncable.syncWithServer()
      syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

      expect(syncable.serverSynced).toBe(true)

      // Change shareId
      syncable.setShareId('new-share-id')

      // Server sync state should be reset for new shareId
      expect(syncable.serverSyncing).toBe(false)
      expect(syncable.serverSynced).toBe(false)
    })

    describe('Initialization Guard Condition', () => {
      test('guard condition passes when serverSynced is true', () => {
        void syncable.syncWithServer()
        syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

        expect(syncable.serverSynced).toBe(true)
        expect(syncable.indexedDBLoaded).toBe(false)
        // Guard should pass: serverSynced === true
        const guardPasses = syncable.serverSynced || (syncable.indexedDBLoaded && !syncable.indexedDBWasEmpty)
        expect(guardPasses).toBe(true)
      })

      test('guard condition passes when IndexedDB loads with content', async () => {
        // Mock checkIndexedDBAlreadyExists to return true (data exists)
        const { checkIndexedDBAlreadyExists } = require('../tools')
        checkIndexedDBAlreadyExists.mockResolvedValue(true)

        await syncable.startIndexedDBSync('test-persistence-id')

        expect(syncable.indexedDBLoaded).toBe(true)
        expect(syncable.indexedDBWasEmpty).toBe(false)
        expect(syncable.serverSynced).toBe(false)
        // Guard should pass: indexedDBLoaded === true && indexedDBWasEmpty === false
        const guardPasses = syncable.serverSynced || (syncable.indexedDBLoaded && !syncable.indexedDBWasEmpty)
        expect(guardPasses).toBe(true)
      })

      test('guard condition does not pass when IndexedDB is deferred (no existing data, server not synced)', async () => {
        // Mock checkIndexedDBAlreadyExists to return false (no data)
        const { checkIndexedDBAlreadyExists } = require('../tools')
        checkIndexedDBAlreadyExists.mockResolvedValue(false)

        await syncable.startIndexedDBSync('test-persistence-id')

        // IndexedDB creation is deferred - not loaded yet
        expect(syncable.indexedDBLoaded).toBe(false)
        expect(syncable.indexedDBWasEmpty).toBe(false)
        expect(syncable.serverSynced).toBe(false)
        // Guard should not pass
        const guardPasses = syncable.serverSynced || (syncable.indexedDBLoaded && !syncable.indexedDBWasEmpty)
        expect(guardPasses).toBe(false)
      })

      test('guard condition passes when both conditions are met simultaneously', async () => {
        // Mock checkIndexedDBAlreadyExists to return true
        const { checkIndexedDBAlreadyExists } = require('../tools')
        checkIndexedDBAlreadyExists.mockResolvedValue(true)

        await syncable.startIndexedDBSync('test-persistence-id')
        void syncable.syncWithServer()
        syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

        expect(syncable.indexedDBLoaded).toBe(true)
        expect(syncable.indexedDBWasEmpty).toBe(false)
        expect(syncable.serverSynced).toBe(true)
        // Guard should pass
        const guardPasses = syncable.serverSynced || (syncable.indexedDBLoaded && !syncable.indexedDBWasEmpty)
        expect(guardPasses).toBe(true)
      })

      describe('Integration Tests', () => {
        test('guard listeners registered before startIndexedDBSync', async () => {
          // Verify that listeners can be registered before sync starts
          const indexedDBLoadedHandler = jest.fn()
          syncable.on('indexedDBLoaded', indexedDBLoadedHandler)

          const { checkIndexedDBAlreadyExists } = require('../tools')
          checkIndexedDBAlreadyExists.mockResolvedValue(true)

          await syncable.startIndexedDBSync('test-persistence-id')

          // Handler should have been called since listener was registered before sync
          expect(indexedDBLoadedHandler).toHaveBeenCalled()
        })

        test('guard listeners registered before syncWithServer', () => {
          const serverSyncedHandler = jest.fn()
          syncable.on('serverSynced', serverSyncedHandler)

          void syncable.syncWithServer()
          syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

          // Handler should have been called since listener was registered before sync
          expect(serverSyncedHandler).toHaveBeenCalled()
        })
      })
    })
  })
})
