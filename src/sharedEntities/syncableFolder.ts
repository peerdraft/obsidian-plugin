import { ObservableV2 } from 'lib0/observable'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { calculateHash, serialize, checkIndexedDBAlreadyExists } from '../tools'
import {
  SYNCABLE_DB_PERSISTENCE_PREFIX,
  type SyncableEntity,
  type SyncableHash,
  type SyncableLogger,
  type SyncableServerSync,
} from './syncableDocument'

export class SyncableFolder extends ObservableV2<{
  flushed: (count: number) => void
  synced: (hash: SyncableHash) => void
  indexedDBLoaded: (payload: { wasEmpty: boolean }) => void
  indexedDBLoadFailed: (error: Error) => void
  serverSyncing: () => void
  serverSynced: (hash: SyncableHash) => void
  serverSyncFailed: (error: Error) => void
  syncStateChanged: (payload: { indexedDBLoaded: boolean, indexedDBWasEmpty: boolean, serverSyncing: boolean, serverSynced: boolean }) => void
}> implements SyncableEntity {
  static readonly DB_PERSISTENCE_PREFIX = SYNCABLE_DB_PERSISTENCE_PREFIX

  private static _registry = new Map<string, SyncableFolder>()

  readonly yDoc: Y.Doc

  private _shareId: string
  private readonly serverSync: SyncableServerSync
  private readonly logger: SyncableLogger

  private _indexedDBProvider?: IndexeddbPersistence
  private indexedDBSyncPromise?: Promise<void>

  private _deferredIndexedDBId?: string
  private _deferredIndexedDBHandler?: () => void

  // Sync state tracking

  private _indexedDBLoaded = false
  private _indexedDBWasEmpty = false
  private _serverSyncing = false
  private _serverSynced = false

  get isIndexedDBDeferred(): boolean {
    return this._deferredIndexedDBId !== undefined
  }

  // Helper to build aggregate state snapshot for syncStateChanged events
  private getStateSnapshot(): { indexedDBLoaded: boolean, indexedDBWasEmpty: boolean, serverSyncing: boolean, serverSynced: boolean } {
    return {
      indexedDBLoaded: this._indexedDBLoaded,
      indexedDBWasEmpty: this._indexedDBWasEmpty,
      serverSyncing: this._serverSyncing,
      serverSynced: this._serverSynced,
    }
  }

  private logEvent(event: 'indexedDBLoaded' | 'indexedDBLoadFailed' | 'serverSyncing' | 'serverSynced' | 'serverSyncFailed' | 'syncStateChanged', payload?: unknown): void {
    console.log(`[SyncableFolder] event`, event, payload)
  }

  private readonly updateListener: (
    update: Uint8Array,
    origin: unknown,
    doc: Y.Doc,
    tx: Y.Transaction
  ) => void

  constructor(opts: {
    yDoc: Y.Doc
    shareId?: string
    serverSync: SyncableServerSync
    logger?: SyncableLogger
    persistenceId?: string
  }) {
    super()
    this.yDoc = opts.yDoc
    this._shareId = opts.shareId ?? ''
    this.serverSync = opts.serverSync
    this.logger = opts.logger ?? { log: () => undefined }

    this.updateListener = (update, _origin, _doc, tx) => {
      // Forward every local update immediately (no debounce), gated on having a shareId.
      if (tx.local && this._shareId) {
        this.serverSync.sendUpdate(this, update)
        this.emit('flushed', [1])
      }
    }
    this.yDoc.on('update', this.updateListener)

    if (this._shareId) {
      SyncableFolder._registry.set(this._shareId, this)
    }

    if (opts.persistenceId) {
      const result = this.startIndexedDBSync(opts.persistenceId)
      if (!this.indexedDBSyncPromise && result) {
        this.indexedDBSyncPromise = result.then(() => undefined)
      }
    }
  }

  static findById(id: string): SyncableFolder | undefined {
    return this._registry.get(id)
  }

  static getAll(): SyncableFolder[] {
    return Array.from(this._registry.values())
  }

  get shareId(): string {
    return this._shareId
  }

  get indexedDBProvider(): IndexeddbPersistence | undefined {
    return this._indexedDBProvider
  }

  // Sync state tracking

  get indexedDBLoaded(): boolean {
    return this._indexedDBLoaded
  }

  get indexedDBWasEmpty(): boolean {
    return this._indexedDBWasEmpty
  }

  get serverSyncing(): boolean {
    return this._serverSyncing
  }

  get serverSynced(): boolean {
    return this._serverSynced
  }

  // True when IndexedDB is loaded AND server has synced at least once.
  get isFullyInitialized(): boolean {
    return this._indexedDBLoaded && this._serverSynced
  }

  // True when IndexedDB is loaded but server has never synced.
  get isOffline(): boolean {
    return this._indexedDBLoaded && !this._serverSynced
  }

  setShareId(id: string): void {
    if (this._shareId === id) return
    if (this._shareId) {
      SyncableFolder._registry.delete(this._shareId)
    }
    this._shareId = id
    if (id) {
      SyncableFolder._registry.set(id, this)
      // Reset server sync state for new shareId
      this._serverSyncing = false
      this._serverSynced = false
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])
    }
  }

  // Hash over serialized documents Y.Map. Matches SharedFolder.calculateHash byte-for-byte.
  calculateHash(): SyncableHash {
    const docsMap = this.yDoc.getMap('documents') as Y.Map<string>
    const serialized = serialize(Array.from(docsMap))
    return calculateHash(serialized)
  }

  syncWithServer(timeoutMs?: number): Promise<SyncableHash> {
    return new Promise<SyncableHash>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const handler = (id: string, hash: string) => {
        if (id !== this._shareId) return
        this.serverSync.off('synced', handler)
        if (timer) clearTimeout(timer)

        // Update sync state on successful sync
        this._serverSyncing = false
        this._serverSynced = true
        this.emit('synced', [hash])
        this.logEvent('serverSynced', hash)
        this.emit('serverSynced', [hash])
        this.logEvent('syncStateChanged', this.getStateSnapshot())
        this.emit('syncStateChanged', [this.getStateSnapshot()])
        this.logger.log('synced ' + this._shareId)
        resolve(hash)
      }
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.serverSync.off('synced', handler)

          // Update sync state on timeout
          this._serverSyncing = false
          const error = new Error(
            `syncWithServer(${this._shareId}) timed out after ${timeoutMs}ms`
          )
          this.logEvent('serverSyncFailed', error)
          this.emit('serverSyncFailed', [error])
          this.logEvent('syncStateChanged', this.getStateSnapshot())
          this.emit('syncStateChanged', [this.getStateSnapshot()])
          reject(error)
        }, timeoutMs)
      }

      // Update sync state before starting sync
      this._serverSyncing = true
      this.logEvent('serverSyncing')
      this.emit('serverSyncing', [])
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])

      this.serverSync.on('synced', handler)
      this.serverSync.sendSyncStep1(this)
      this.logger.log('syncing ' + this._shareId)
    })
  }

  async startIndexedDBSync(persistenceId: string): Promise<IndexeddbPersistence | undefined> {
    if (this._indexedDBProvider) return this._indexedDBProvider
    // If already deferred for this (or another) ID, don't set up another handler
    if (this._deferredIndexedDBId) return undefined

    const dbName = SyncableFolder.DB_PERSISTENCE_PREFIX + persistenceId

    try {
      // Check if IndexedDB already existed before this startup
      const hadExistingData = await checkIndexedDBAlreadyExists(dbName)

      if (!hadExistingData && !this._serverSynced) {
        this._deferredIndexedDBId = persistenceId
        this._setupDeferredIndexedDBCreation()
        return undefined
      }

      const provider = new IndexeddbPersistence(dbName, this.yDoc)
      this._indexedDBProvider = provider
      if (!provider.synced) await provider.whenSynced

      // Track IndexedDB state after sync completes
      this._indexedDBLoaded = true
      // Use pre-load check to determine if IndexedDB was empty
      this._indexedDBWasEmpty = !hadExistingData
      const payload = { wasEmpty: this._indexedDBWasEmpty }
      this.logEvent('indexedDBLoaded', payload)
      this.emit('indexedDBLoaded', [payload])
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])

      return provider
    } catch (error) {
      // Clean up partial state
      this._indexedDBProvider = undefined
      this._indexedDBLoaded = false
      this._indexedDBWasEmpty = false

      // Emit error event so callers know initialization failed
      const failure = error instanceof Error ? error : new Error(String(error))
      this.logEvent('indexedDBLoadFailed', failure)
      this.emit('indexedDBLoadFailed', [failure])
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])

      throw error
    }
  }

  private _setupDeferredIndexedDBCreation(): void {
    const id = this._deferredIndexedDBId!
    // Remove old handler if exists (avoid race condition where cleanup clears _deferredIndexedDBId)
    if (this._deferredIndexedDBHandler) {
      this.off('serverSynced', this._deferredIndexedDBHandler)
      this._deferredIndexedDBHandler = undefined
    }
    let resolveSyncPromise: () => void
    // Replace the prematurely-resolved promise with one that waits for actual creation
    this.indexedDBSyncPromise = new Promise<void>(resolve => {
      resolveSyncPromise = resolve
    })
    const handler = () => {
      this._cleanupDeferredIndexedDBCreation()
      try {
        this.startIndexedDBSync(id).then(
          () => resolveSyncPromise(),
          () => resolveSyncPromise() // Resolve even on error — callers don't expect hang
        ).catch(() => {
          // Error already emitted via indexedDBLoadFailed; swallow unhandled rejection
        })
      } catch (e) {
        // Handle synchronous errors from startIndexedDBSync
        resolveSyncPromise()
      }
    }
    this._deferredIndexedDBHandler = handler
    this.on('serverSynced', handler)
  }

  // Remove deferred IndexedDB listener and reset deferred state.
  private _cleanupDeferredIndexedDBCreation(): void {
    if (this._deferredIndexedDBHandler) {
      this.off('serverSynced', this._deferredIndexedDBHandler)
      this._deferredIndexedDBHandler = undefined
    }
    this._deferredIndexedDBId = undefined
  }

  whenIndexedDBSynced(): Promise<void> {
    return this.indexedDBSyncPromise ?? Promise.resolve()
  }

  async stopIndexedDBSync(): Promise<void> {
    this._cleanupDeferredIndexedDBCreation()
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.destroy()
      this._indexedDBProvider = undefined
    }

    // Always reset state tracking (even when only deferred cleanup occurred)
    this._indexedDBLoaded = false
    this._indexedDBWasEmpty = false
    this.logEvent('syncStateChanged', this.getStateSnapshot())
    this.emit('syncStateChanged', [this.getStateSnapshot()])
  }

  destroy(): void {
    this.yDoc.off('update', this.updateListener)
    if (this._shareId) {
      SyncableFolder._registry.delete(this._shareId)
    }

    // Clean up deferred IndexedDB creation if pending
    this._cleanupDeferredIndexedDBCreation()

    // Destroy IndexedDB provider to release DB connections and observers
    if (this._indexedDBProvider) {
      this._indexedDBProvider.destroy()
      this._indexedDBProvider = undefined
    }

    // Reset sync state tracking
    this._indexedDBLoaded = false
    this._indexedDBWasEmpty = false
    this._serverSyncing = false
    this._serverSynced = false

    super.destroy()
  }
}
