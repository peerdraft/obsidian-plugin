import { Mutex } from 'async-mutex'
import { ObservableV2 } from 'lib0/observable'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { diff, diffCleanupEfficiency } from 'diff-match-patch-es'

import { calculateHash, checkIndexedDBAlreadyExists } from '../tools'

// File I/O port for SyncableDocument. Abstracts vault read/write operations.
export interface SyncableFileIO {
  read(): Promise<string>
  modify(content: string, opts?: { mtime?: number }): Promise<void>
  getMTime(): number
}

// Clock port for SyncableDocument. Abstracts time access for testing.
export interface SyncableClock {
  now(): number
}

// Sync-engine logic extracted from SharedDocument. Owns Y.Doc, IndexedDB persistence,
// local-update batcher, syncWithServer, and static registry for provider reconnect.
// Has no Obsidian imports for testability.

// xxhash hex string of the doc's content text fragment.
export type SyncableHash = string

export const SYNCABLE_DB_PERSISTENCE_PREFIX = 'peerdraft_persistence_'

// Subset of PeerdraftWebsocketProvider that SyncableDocument depends on.
export interface SyncableServerSync {
  on(event: 'synced', handler: (id: string, hash: string) => void): unknown
  off(event: 'synced', handler: (id: string, hash: string) => void): unknown
  sendSyncStep1(entity: SyncableEntity): void
  sendUpdate(entity: SyncableEntity, update: Uint8Array): void
}

// Minimal entity shape the provider's send methods consume.
export interface SyncableEntity {
  shareId: string
  yDoc: Y.Doc
  calculateHash(): SyncableHash
}

export interface SyncableLogger {
  log(...args: unknown[]): void
}

export interface SyncableDocumentOptions {
  yDoc: Y.Doc
  shareId?: string
  isPermanent?: boolean
  serverSync: SyncableServerSync
  logger?: SyncableLogger
  // If provided, IndexedDB persistence is started on construction.
  persistenceId?: string
  // Default 1000 ms.
  flushIntervalMs?: number
  // File I/O adapter. If provided, syncable installs content observer for file flushes.
  fileIO?: SyncableFileIO
  // Clock for the self-echo guard. Defaults to Date.now().
  clock?: SyncableClock
  // Predicate returning how many CodeMirror editor extensions are attached.
  editorAttachedCount?: () => number
  // Default 1000 ms. Debounce for yDoc → file flushes.
  fileFlushIntervalMs?: number
  // Optional custom registry for this syncable. Used by test harnesses.
  registry?: Map<string, SyncableDocument>
}

type Events = {
  flushed: (count: number) => void
  synced: (hash: SyncableHash) => void
  'file-flushed': (mtime: number) => void
  reconciled: (hash: SyncableHash) => void
  indexedDBLoaded: (payload: { wasEmpty: boolean }) => void
  indexedDBLoadFailed: (error: Error) => void
  serverSyncing: () => void
  serverSynced: (hash: SyncableHash) => void
  serverSyncFailed: (error: Error) => void
  syncStateChanged: (payload: { indexedDBLoaded: boolean, indexedDBWasEmpty: boolean, serverSyncing: boolean, serverSynced: boolean }) => void
}

export class SyncableDocument extends ObservableV2<Events> implements SyncableEntity {
  static readonly DB_PERSISTENCE_PREFIX = SYNCABLE_DB_PERSISTENCE_PREFIX

  // Registry for provider reconnect/lookup paths.
  private static _registry = new Map<string, SyncableDocument>()

  readonly yDoc: Y.Doc

  private _shareId: string
  private _isPermanent: boolean
  private readonly serverSync: SyncableServerSync
  private readonly logger: SyncableLogger
  private readonly mutex = new Mutex()
  private readonly flushIntervalMs: number

  private _indexedDBProvider?: IndexeddbPersistence
  private indexedDBSyncPromise?: Promise<void>

  // Sync state tracking

  private _indexedDBLoaded = false
  private _indexedDBWasEmpty = false
  private _serverSyncing = false
  private _serverSynced = false

  // Helper to build aggregate state snapshot for syncStateChanged events
  private getStateSnapshot(): { indexedDBLoaded: boolean, indexedDBWasEmpty: boolean, serverSyncing: boolean, serverSynced: boolean } {
    return {
      indexedDBLoaded: this._indexedDBLoaded,
      indexedDBWasEmpty: this._indexedDBWasEmpty,
      serverSyncing: this._serverSyncing,
      serverSynced: this._serverSynced,
    }
  }

  private logEvent(event: keyof Events, payload?: unknown): void {
    console.log(`[SyncableDocument] event`, event, payload)
  }

  private pendingUpdates: Uint8Array[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private readonly updateListener: (
    update: Uint8Array,
    origin: unknown,
    doc: Y.Doc,
    tx: Y.Transaction
  ) => void

  // File-sync state (only installed when fileIO is supplied)

  private fileIO?: SyncableFileIO
  private readonly clock: SyncableClock
  private readonly editorAttachedCount: () => number
  private readonly fileFlushIntervalMs: number
  private fileFlushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly fileMutex = new Mutex()
  private contentObserver?: () => void

  private readonly registry: Map<string, SyncableDocument>

  // mtime of most recent write through fileIO.modify(). Used for self-echo guard.
  private _lastUpdateTriggeredByDocChange = 0

  // Set or update FileIO adapter after construction.
  setFileIO(fileIO: SyncableFileIO | undefined): void {
    if (this.fileIO === fileIO) return
    // Uninstall old observer if present
    if (this.contentObserver) {
      this.yDoc.getText('content').unobserve(this.contentObserver)
      this.contentObserver = undefined
    }
    this.fileIO = fileIO
    // Install new observer if fileIO is now available
    if (fileIO) {
      this.contentObserver = () => {
        if (this.editorAttachedCount() === 0) {
          this.scheduleFileFlush()
        }
      }
      this.yDoc.getText('content').observe(this.contentObserver)
    }
  }

  constructor(opts: SyncableDocumentOptions) {
    super()
    this.yDoc = opts.yDoc
    this._shareId = opts.shareId ?? ''
    this._isPermanent = opts.isPermanent ?? false
    this.serverSync = opts.serverSync
    this.logger = opts.logger ?? { log: () => undefined }
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000
    this.fileIO = opts.fileIO
    this.clock = opts.clock ?? { now: () => Date.now() }
    this.editorAttachedCount = opts.editorAttachedCount ?? (() => 0)
    this.fileFlushIntervalMs = opts.fileFlushIntervalMs ?? 1000
    this.registry = opts.registry ?? SyncableDocument._registry

    this.updateListener = (update, _origin, _doc, tx) => {
      // Only forward local edits when this share is persistent.
      if (tx.local && this._isPermanent) {
        this.pendingUpdates.push(update)
        this.scheduleFlush()
      }
    }
    this.yDoc.on('update', this.updateListener)

    // Install content observer if fileIO is provided
    if (this.fileIO) {
      this.contentObserver = () => {
        if (this.editorAttachedCount() === 0) {
          this.scheduleFileFlush()
        }
      }
      this.yDoc.getText('content').observe(this.contentObserver)
    }

    if (this._shareId) {
      this.registry.set(this._shareId, this)
    }

    if (opts.persistenceId) {
      // Fire-and-forget; callers can await whenIndexedDBSynced().
      this.indexedDBSyncPromise = this.startIndexedDBSync(opts.persistenceId).then(
        () => undefined
      )
    }
  }

  // Static registry — used by PeerdraftWebsocketProvider's onopen loop

  static findById(id: string): SyncableDocument | undefined {
    return this._registry.get(id)
  }

  static getAll(): SyncableDocument[] {
    return Array.from(this._registry.values())
  }

  // SyncableEntity surface

  get shareId(): string {
    return this._shareId
  }

  get isPermanent(): boolean {
    return this._isPermanent
  }

  get indexedDBProvider(): IndexeddbPersistence | undefined {
    return this._indexedDBProvider
  }

  // ---- Sync state tracking ----

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

  // Set or update the shareId.
  setShareId(id: string): void {
    if (this._shareId === id) return
    if (this._shareId) {
      this.registry.delete(this._shareId)
    }
    this._shareId = id
    if (id) {
      this.registry.set(id, this)
      // Reset server sync state for new shareId
      this._serverSyncing = false
      this._serverSynced = false
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])
    }
  }

  setPermanent(value: boolean): void {
    this._isPermanent = value
  }

  // Hash of the content Y.Text. Matches SharedDocument.calculateHash byte-for-byte.
  calculateHash(): SyncableHash {
    return calculateHash(this.yDoc.getText('content').toString())
  }

  // Server sync

  // Send SYNC_STEP_1 and resolve when matching SYNC_STEP_2 arrives.
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

  // IndexedDB persistence

  // Start y-indexeddb persistence for this Y.Doc. Idempotent.
  async startIndexedDBSync(persistenceId: string): Promise<IndexeddbPersistence> {
    if (this._indexedDBProvider) return this._indexedDBProvider

    const dbName = SyncableDocument.DB_PERSISTENCE_PREFIX + persistenceId

    try {
      // Check if IndexedDB already existed before instantiation
      const hadExistingData = await checkIndexedDBAlreadyExists(dbName)

      const provider = new IndexeddbPersistence(dbName, this.yDoc)
      this._indexedDBProvider = provider
      if (!provider.synced) await provider.whenSynced

      // Track IndexedDB state after sync completes
      this._indexedDBLoaded = true
      // Use pre-load check to determine if IndexedDB was empty
      this._indexedDBWasEmpty = !hadExistingData
      const indexedPayload = { wasEmpty: this._indexedDBWasEmpty }
      this.logEvent('indexedDBLoaded', indexedPayload)
      this.emit('indexedDBLoaded', [indexedPayload])
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

  // Resolve when IndexedDB sync has finished. No-op if not configured.
  whenIndexedDBSynced(): Promise<void> {
    return this.indexedDBSyncPromise ?? Promise.resolve()
  }

  async stopIndexedDBSync(): Promise<void> {
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.destroy()
      this._indexedDBProvider = undefined

      // Reset state tracking
      this._indexedDBLoaded = false
      this._indexedDBWasEmpty = false
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])
    }
  }

  // Local-update batcher

  // Force-flush pending local updates to the server.
  flushPendingUpdates(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pendingUpdates.length === 0) return Promise.resolve()
    return this.mutex.runExclusive(() => {
      const merged = Y.mergeUpdates(this.pendingUpdates)
      const count = this.pendingUpdates.length
      this.pendingUpdates = []
      this.serverSync.sendUpdate(this, merged)
      this.emit('flushed', [count])
    })
  }

  // Number of local updates currently buffered. Test-introspection only.
  get pendingUpdateCount(): number {
    return this.pendingUpdates.length
  }

  private scheduleFlush(): void {
    // Reset timer on every edit so flush happens after the last edit.
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPendingUpdates()
    }, this.flushIntervalMs)
  }

  // File sync (only active when fileIO is provided)

  // Write current Y.Doc content to file via FileIO port.
  async flushToFile(): Promise<void> {
    if (!this.fileIO) return
    if (this.fileFlushTimer) {
      clearTimeout(this.fileFlushTimer)
      this.fileFlushTimer = null
    }
    return this.fileMutex.runExclusive(async () => {
      const content = this.yDoc.getText('content').toString()
      const mtime = this.clock.now()
      await this.fileIO!.modify(content, { mtime })
      this._lastUpdateTriggeredByDocChange = mtime
      this.emit('file-flushed', [mtime])
    })
  }

  // Merge external file content into Y.Doc using diff-match-patch.
  reconcileWithFileContent(fileContent: string): Promise<void> {
    const fileIO = this.fileIO
    if (!fileIO) return Promise.resolve()
    if (this.editorAttachedCount() > 0) return Promise.resolve()
    if (fileIO.getMTime() === this._lastUpdateTriggeredByDocChange) {
      return Promise.resolve()
    }
    return this.fileMutex.runExclusive(() => {
      const yDocContent = this.yDoc.getText('content').toString()
      if (yDocContent === fileContent) return
      const diffs = diff(yDocContent, fileContent)
      diffCleanupEfficiency(diffs)
      const content = this.yDoc.getText('content')
      let pos = 0
      this.yDoc.transact(() => {
        for (const d of diffs) {
          const text = d[1] as string
          const length = text.length
          switch (d[0]) {
            case 0:
              pos += length
              break
            case -1:
              content.delete(pos, length)
              break
            case 1:
              content.insert(pos, text)
              pos += length
              break
          }
        }
      })
      this.emit('reconciled', [this.calculateHash()])
    })
  }

  private scheduleFileFlush(): void {
    if (this.fileFlushTimer) clearTimeout(this.fileFlushTimer)
    this.fileFlushTimer = setTimeout(() => {
      this.fileFlushTimer = null
      this.flushToFile()
    }, this.fileFlushIntervalMs)
  }

  // Lifecycle

  destroy(): void {
    if (this.contentObserver) {
      this.yDoc.getText('content').unobserve(this.contentObserver)
    }
    if (this.fileFlushTimer) {
      clearTimeout(this.fileFlushTimer)
      this.fileFlushTimer = null
    }
    this.yDoc.off('update', this.updateListener)
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this._shareId) {
      this.registry.delete(this._shareId)
    }

    // Reset sync state tracking
    this._indexedDBLoaded = false
    this._indexedDBWasEmpty = false
    this._serverSyncing = false
    this._serverSynced = false

    super.destroy()
  }
}
