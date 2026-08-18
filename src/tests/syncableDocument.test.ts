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
      read: jest.fn(),
      modify: jest.fn().mockResolvedValue(undefined),
      getMTime: jest.fn(() => Date.now()),
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

      syncable.syncWithServer()

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
      syncable.syncWithServer()
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
        syncable.syncWithServer()
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
        syncable.syncWithServer()
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

          syncable.syncWithServer()
          syncedHandlers.forEach(handler => handler('test-share-id', 'test-hash'))

          // Handler should have been called since listener was registered before sync
          expect(serverSyncedHandler).toHaveBeenCalled()
        })
      })
    })
  })
})
