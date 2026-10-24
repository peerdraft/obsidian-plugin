import { Mutex } from 'async-mutex'
import { ObservableV2 } from 'lib0/observable'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { diff, diffCleanupEfficiency } from 'diff-match-patch-es'

import { calculateHash, checkIndexedDBAlreadyExists } from '../tools'

export interface SyncableFileIO {
  read(): Promise<string>
  modify(content: string, opts?: { mtime?: number }): Promise<void>
  getMTime(): number
}

export interface SyncableClock {
  now(): number
}

export type SyncableHash = string

export const SYNCABLE_DB_PERSISTENCE_PREFIX = 'peerdraft_persistence_'

export interface SyncableServerSync {
  on(event: 'synced', handler: (id: string, hash: string) => void): unknown
  off(event: 'synced', handler: (id: string, hash: string) => void): unknown
  sendSyncStep1(entity: SyncableEntity): void
  sendUpdate(entity: SyncableEntity, update: Uint8Array): void
}

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
  // Prevent disk flushes until initial local text has been reconciled. Defaults to true.
  canWriteFile?: () => boolean
  // Reconnects must not interrupt the factory's initial local reconciliation.
  canStartServerSync?: () => boolean
  // Optional verified restart shortcut; null keeps the ordinary handshake.
  tryFastRestart?: (document: SyncableDocument) => Promise<SyncableHash | null>
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
  private readonly persistenceWaiters = new Set<(error: Error) => void>()

  private _deferredIndexedDBId?: string
  private _deferredIndexedDBHandler?: () => void

  private _indexedDBLoaded = false
  private _indexedDBWasEmpty = false
  private _serverSyncing = false
  private _serverSynced = false
  private _newDocConfirmed = false
  private _isNewDocument = false

  get isIndexedDBDeferred(): boolean {
    return this._deferredIndexedDBId !== undefined
  }

  private getStateSnapshot(): { indexedDBLoaded: boolean, indexedDBWasEmpty: boolean, serverSyncing: boolean, serverSynced: boolean, newDocConfirmed: boolean } {
    return {
      indexedDBLoaded: this._indexedDBLoaded,
      indexedDBWasEmpty: this._indexedDBWasEmpty,
      serverSyncing: this._serverSyncing,
      serverSynced: this._serverSynced,
      newDocConfirmed: this._newDocConfirmed,
    }
  }

  private logEvent(event: keyof Events, payload?: unknown): void {
  }

  private pendingUpdates: Uint8Array[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private readonly updateListener: (
    update: Uint8Array,
    origin: unknown,
    doc: Y.Doc,
    tx: Y.Transaction
  ) => void

  private fileIO?: SyncableFileIO
  private readonly clock: SyncableClock
  private readonly editorAttachedCount: () => number
  private readonly canWriteFile: () => boolean
  private readonly serverSyncReady: () => boolean
  private readonly tryFastRestart?: (document: SyncableDocument) => Promise<SyncableHash | null>
  private fastSyncPromise?: Promise<SyncableHash>
  private syncLifecycle = 0
  private destroyed = false
  private resyncPromise?: Promise<SyncableHash>
  private resyncRequested = false
  private readonly fileFlushIntervalMs: number
  private fileFlushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly fileMutex = new Mutex()
  private contentObserver?: () => void
  private lastRead?: { fileIO: SyncableFileIO; content: string; mtime: number }

  private readonly registry: Map<string, SyncableDocument>

  private _lastUpdateTriggeredByDocChange = 0

  setFileIO(fileIO: SyncableFileIO | undefined): void {
    if (this.fileIO === fileIO) return
    if (this.contentObserver) {
      this.yDoc.getText('content').unobserve(this.contentObserver)
      this.contentObserver = undefined
    }
    this.fileIO = fileIO
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
    this.canWriteFile = opts.canWriteFile ?? (() => true)
    this.serverSyncReady = opts.canStartServerSync ?? (() => true)
    this.tryFastRestart = opts.tryFastRestart
    this.fileFlushIntervalMs = opts.fileFlushIntervalMs ?? 1000
    this.registry = opts.registry ?? SyncableDocument._registry

    this.updateListener = (update, _origin, _doc, tx) => {
      if (tx.local && this._isPermanent) {
        this.pendingUpdates.push(update)
        this.scheduleFlush()
      }
    }
    this.yDoc.on('update', this.updateListener)

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
      const result = this.startIndexedDBSync(opts.persistenceId)
      if (!this.indexedDBSyncPromise && result) {
        this.indexedDBSyncPromise = result.then(() => undefined)
      }
    }
  }

  static findById(id: string): SyncableDocument | undefined {
    return this._registry.get(id)
  }

  static getAll(): SyncableDocument[] {
    return Array.from(this._registry.values())
  }

  get shareId(): string {
    return this._shareId
  }

  get isPermanent(): boolean {
    return this._isPermanent
  }

  get indexedDBProvider(): IndexeddbPersistence | undefined {
    return this._indexedDBProvider
  }

  get indexedDBLoaded(): boolean {
    return this._indexedDBLoaded
  }

  get indexedDBWasEmpty(): boolean {
    return this._indexedDBWasEmpty
  }

  get serverSyncing(): boolean {
    return this._serverSyncing
  }

  /** Whether reconnect work may start before factory-owned local initialization finishes. */
  get canStartServerSync(): boolean {
    return this.serverSyncReady()
  }

  get serverSynced(): boolean {
    return this._serverSynced
  }

  get newDocConfirmed(): boolean {
    return this._newDocConfirmed
  }

  get isNewDocument(): boolean {
    return this._isNewDocument
  }

  _setNewDocConfirmed(value: boolean): void {
    this._newDocConfirmed = value
    if (value) {
      this._isNewDocument = false
    }
    this.logEvent('syncStateChanged', this.getStateSnapshot())
    this.emit('syncStateChanged', [this.getStateSnapshot()])
  }

  _setServerSynced(value: boolean): void {
    this._serverSynced = value
    if (value) {
      this._isNewDocument = false
    }
    this.logEvent('syncStateChanged', this.getStateSnapshot())
    this.emit('syncStateChanged', [this.getStateSnapshot()])
  }

  _setIsNewDocument(value: boolean): void {
    this._isNewDocument = value
  }

  get isFullyInitialized(): boolean {
    return this._indexedDBLoaded && this._serverSynced
  }

  get isOffline(): boolean {
    return this._indexedDBLoaded && !this._serverSynced
  }

  setShareId(id: string): void {
    if (this._shareId === id) return
    this.syncLifecycle++
    this.cancelPersistenceWaiters(new Error('Document identity changed before persistence committed'))
    if (this._shareId) {
      this.registry.delete(this._shareId)
    }
    this._shareId = id
    if (id) {
      this.registry.set(id, this)
      this._serverSyncing = false
      this._serverSynced = false
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])
    }
  }

  setPermanent(value: boolean): void {
    this._isPermanent = value
  }

  calculateHash(): SyncableHash {
    return calculateHash(this.yDoc.getText('content').toString())
  }

  syncWithServer(timeoutMs?: number): Promise<SyncableHash> {
    if (!this.tryFastRestart) return this.syncNormally(timeoutMs)
    if (this.fastSyncPromise) return this.fastSyncPromise
    const lifecycle = this.syncLifecycle
    this._serverSyncing = true
    this.emit('serverSyncing', [])
    this.emit('syncStateChanged', [this.getStateSnapshot()])
    const task = (async (): Promise<SyncableHash> => {
      let verified: SyncableHash | null = null
      try { verified = await this.tryFastRestart!(this) } catch { /* Verification is optional. */ }
      if (this.destroyed || lifecycle !== this.syncLifecycle) return this.calculateHash()
      if (verified === null) return this.syncNormally(timeoutMs)
      this._serverSyncing = false
      this._setServerSynced(true)
      this.emit('synced', [verified])
      this.emit('serverSynced', [verified])
      return verified
    })()
    this.fastSyncPromise = task
    const clear = (): void => { if (this.fastSyncPromise === task) this.fastSyncPromise = undefined }
    void task.then(clear, clear)
    return task
  }

  /**
   * Complete initial sync only after the factory verified the complete imported
   * state and established cache/file safety. The guard must still validate its
   * socket, checkpoint, document identity and initialization lifecycle.
   */
  acceptServerSnapshot(checksum: SyncableHash, isCurrent: () => boolean): boolean {
    if (this.destroyed || this._serverSyncing || !isCurrent() || this.calculateHash() !== checksum) return false
    this._serverSyncing = false
    this._setServerSynced(true)
    this.emit('synced', [checksum])
    this.logEvent('serverSynced', checksum)
    this.emit('serverSynced', [checksum])
    this.logger.log('synced ' + this._shareId)
    return true
  }

  /** Changes arriving during a handshake require one fresh exchange afterward. */
  resyncAfterCurrent(): Promise<SyncableHash> {
    this.resyncRequested = true
    if (this.resyncPromise) return this.resyncPromise
    const task = (async (): Promise<SyncableHash> => {
      let result = this.calculateHash()
      while (this.resyncRequested && !this.destroyed) {
        const current = this.fastSyncPromise
        if (current) {
          try { await current } catch { /* A fresh exchange can recover. */ }
        }
        if (this.destroyed) break
        // Consume all invalidations preceding this fresh request; an invalidation
        // during the new request sets the flag again and requires another pass.
        this.resyncRequested = false
        result = await this.syncWithServer()
      }
      return result
    })()
    this.resyncPromise = task
    const clear = (): void => { if (this.resyncPromise === task) this.resyncPromise = undefined }
    void task.then(clear, clear)
    return task
  }

  /** A lost socket must permit reconnect to send a fresh request rather than join a lost flight. */
  resetServerSyncFlight(): void {
    this.syncLifecycle++
    this.fastSyncPromise = undefined
    this._serverSyncing = false
  }

  private syncNormally(timeoutMs?: number): Promise<SyncableHash> {
    const lifecycle = this.syncLifecycle
    return new Promise<SyncableHash>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const handler = (id: string, hash: string) => {
        if (id !== this._shareId) return
        this.serverSync.off('synced', handler)
        if (timer) clearTimeout(timer)
        if (this.destroyed || lifecycle !== this.syncLifecycle) {
          resolve(hash)
          return
        }

        this._serverSyncing = false
        this._setServerSynced(true)
        this.emit('synced', [hash])
        this.logEvent('serverSynced', hash)
        this.emit('serverSynced', [hash])
        this.logger.log('synced ' + this._shareId)
        resolve(hash)
      }
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.serverSync.off('synced', handler)
          if (this.destroyed || lifecycle !== this.syncLifecycle) {
            resolve(this.calculateHash())
            return
          }

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
    if (this._deferredIndexedDBId) return undefined

    const dbName = SyncableDocument.DB_PERSISTENCE_PREFIX + persistenceId

    try {
      const hadExistingData = await checkIndexedDBAlreadyExists(dbName)

      if (!hadExistingData && !this._serverSynced) {
        this._deferredIndexedDBId = persistenceId
        this._setupDeferredIndexedDBCreation()
        return undefined
      }

      const provider = new IndexeddbPersistence(dbName, this.yDoc)
      this._indexedDBProvider = provider
      if (!provider.synced) await provider.whenSynced

      this._indexedDBLoaded = true
      this._indexedDBWasEmpty = !hadExistingData
      const indexedPayload = { wasEmpty: this._indexedDBWasEmpty }
      this.logEvent('indexedDBLoaded', indexedPayload)
      this.emit('indexedDBLoaded', [indexedPayload])
      this.logEvent('syncStateChanged', this.getStateSnapshot())
      this.emit('syncStateChanged', [this.getStateSnapshot()])

      return provider
    } catch (error) {
      this._indexedDBProvider = undefined
      this._indexedDBLoaded = false
      this._indexedDBWasEmpty = false
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
    if (this._deferredIndexedDBHandler) {
      this.off('serverSynced', this._deferredIndexedDBHandler)
      this._deferredIndexedDBHandler = undefined
    }
    let resolveSyncPromise: () => void
    this.indexedDBSyncPromise = new Promise<void>(resolve => {
      resolveSyncPromise = resolve
    })
    const handler = () => {
      this._cleanupDeferredIndexedDBCreation()
      try {
        this.startIndexedDBSync(id).then(
          () => resolveSyncPromise(),
          () => resolveSyncPromise()
        ).catch(() => {
        })
      } catch (e) {
        resolveSyncPromise()
      }
    }
    this._deferredIndexedDBHandler = handler
    this.on('serverSynced', handler)
  }

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

  /** Commit a complete state snapshot, even if an earlier persistence write failed. */
  whenPersistenceSettled(): Promise<void> {
    const shareId = this._shareId
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let transaction: IDBTransaction | undefined
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        this.persistenceWaiters.delete(cancel)
        if (transaction) {
          transaction.oncomplete = null
          transaction.onerror = null
          transaction.onabort = null
        }
        if (error) reject(error)
        else resolve()
      }
      const cancel = (error: Error): void => {
        finish(error)
        try { transaction?.abort() } catch { /* A completed transaction needs no cancellation. */ }
      }
      this.persistenceWaiters.add(cancel)
      void this.whenIndexedDBSynced().then(() => {
        if (settled) return
        const provider = this._indexedDBProvider
        if (this.destroyed || this._shareId !== shareId || !this._indexedDBLoaded || !provider?.db) {
          finish(new Error('Document persistence is not available'))
          return
        }
        try {
          // A read barrier cannot detect an earlier aborted seed transaction.
          // Persist current complete state in our own transaction and require
          // its actual commit before reporting a durable import.
          transaction = provider.db.transaction('updates', 'readwrite')
          transaction.oncomplete = () => {
            if (this.destroyed || this._shareId !== shareId || this._indexedDBProvider !== provider || !this._indexedDBLoaded) {
              finish(new Error('Document persistence changed before commit'))
            } else finish()
          }
          transaction.onerror = () => cancel(transaction?.error ?? new Error('Document persistence commit failed'))
          transaction.onabort = () => finish(transaction?.error ?? new Error('Document persistence commit aborted'))
          transaction.objectStore('updates').add(Y.encodeStateAsUpdate(this.yDoc))
        } catch (error) {
          cancel(error instanceof Error ? error : new Error('Document persistence commit failed'))
        }
      }, error => finish(error instanceof Error ? error : new Error('Document persistence initialization failed')))
    })
  }

  private cancelPersistenceWaiters(error: Error): void {
    for (const cancel of Array.from(this.persistenceWaiters)) cancel(error)
  }

  async stopIndexedDBSync(): Promise<void> {
    this.cancelPersistenceWaiters(new Error('Document persistence stopped before commit'))
    this._cleanupDeferredIndexedDBCreation()
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.destroy()
      this._indexedDBProvider = undefined
    }

    this._indexedDBLoaded = false
    this._indexedDBWasEmpty = false
    this.logEvent('syncStateChanged', this.getStateSnapshot())
    this.emit('syncStateChanged', [this.getStateSnapshot()])
  }

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

  get pendingUpdateCount(): number {
    return this.pendingUpdates.length
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushPendingUpdates()
    }, this.flushIntervalMs)
  }

  async flushToFile(): Promise<void> {
    const fileIO = this.fileIO
    if (!fileIO || !this.canWriteFile()) return
    if (this.fileFlushTimer) {
      clearTimeout(this.fileFlushTimer)
      this.fileFlushTimer = null
    }
    let reconcileLocalChange = false
    await this.fileMutex.runExclusive(async () => {
      if (this.fileIO !== fileIO || !this.canWriteFile() || this.editorAttachedCount() > 0) return
      const previousMtime = fileIO.getMTime()
      // Reconciliation just read this exact text. If the document has not
      // changed, no write is needed; skipping preserves even a concurrent edit.
      if (this.lastRead?.fileIO === fileIO && this.lastRead.mtime === previousMtime &&
        this.lastRead.content === this.yDoc.getText('content').toString()) return
      const fileContent = await fileIO.read()
      if (this.fileIO !== fileIO || !this.canWriteFile() || this.editorAttachedCount() > 0) return
      if (fileIO.getMTime() !== previousMtime) {
        reconcileLocalChange = true
        return
      }
      this.lastRead = { fileIO, content: fileContent, mtime: previousMtime }
      // Read the latest document after disk I/O; cache replay or a remote
      // update need not touch the file when its text already matches.
      const content = this.yDoc.getText('content').toString()
      if (fileContent === content) return
      const mtime = this.clock.now()
      await fileIO.modify(content, { mtime })
      this._lastUpdateTriggeredByDocChange = mtime
      this.lastRead = { fileIO, content, mtime }
      this.emit('file-flushed', [mtime])
    })
    // A vault edit observed during the read takes priority over this flush.
    // Acquire a fresh read only after releasing the write lock.
    if (reconcileLocalChange && this.fileIO === fileIO) await this.reconcileWithFile()
  }

  /**
   * Reconcile fresh local text under the file-write lock. Returns false if the
   * adapter or file changed during the read, so initialization can retry safely.
   */
  reconcileWithFile(
    readEditorContent?: () => string | undefined,
    options: { initialState?: 'cached' | 'server' | 'imported' } = {},
  ): Promise<boolean> {
    const fileIO = this.fileIO
    if (!fileIO) return Promise.resolve(false)
    return this.fileMutex.runExclusive(async () => {
      if (this.fileIO !== fileIO) return false
      if (this.editorAttachedCount() > 0) return true
      const previousMtime = fileIO.getMTime()
      const isSelfEcho = previousMtime === this._lastUpdateTriggeredByDocChange
      if (!options.initialState && isSelfEcho) return true
      const fileContent = await fileIO.read()
      if (this.fileIO !== fileIO || fileIO.getMTime() !== previousMtime) return false
      const previouslyRead = this.lastRead
      this.lastRead = { fileIO, content: fileContent, mtime: previousMtime }
      if (this.editorAttachedCount() > 0) return true
      const editorContent = readEditorContent?.()
      const dirtyEditor = editorContent !== undefined && editorContent !== fileContent
      if (options.initialState === 'server' && editorContent !== undefined && !dirtyEditor) return true
      // A complete imported file unchanged since reconciliation is no longer a
      // source of local edits. Preserve a newer remote update while the guard
      // or cache initialization finishes; its text will be flushed afterward.
      if (options.initialState === 'imported' && !dirtyEditor && previouslyRead?.fileIO === fileIO &&
        previouslyRead.mtime === previousMtime && previouslyRead.content === fileContent) return true
      if (!dirtyEditor && isSelfEcho) return true
      await this.reconcileFileContentUnlocked(
        fileIO,
        dirtyEditor ? editorContent : fileContent,
        dirtyEditor,
        options.initialState === 'imported',
      )
      return this.fileIO === fileIO
    })
  }

  reconcileWithFileContent(fileContent: string): Promise<void> {
    const fileIO = this.fileIO
    if (!fileIO) return Promise.resolve()
    return this.fileMutex.runExclusive(async () => {
      if (this.fileIO !== fileIO || this.editorAttachedCount() > 0) return
      if (fileIO.getMTime() === this._lastUpdateTriggeredByDocChange) return
      await this.reconcileFileContentUnlocked(fileIO, fileContent)
    })
  }

  private async reconcileFileContentUnlocked(
    fileIO: SyncableFileIO,
    fileContent: string,
    isEditorContent = false,
    preserveEmptyFile = false,
  ): Promise<void> {
    const yDocContent = this.yDoc.getText('content').toString()
    if (yDocContent === fileContent) return

    // Empty disk files can be placeholders; an explicitly emptied editor is an edit.
    if (!isEditorContent && !preserveEmptyFile && fileContent === '' && yDocContent !== '') {
      const mtime = this.clock.now()
      await fileIO.modify(yDocContent, { mtime })
      this._lastUpdateTriggeredByDocChange = mtime
      this.emit('reconciled', [this.calculateHash()])
      return
    }

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
  }

  private scheduleFileFlush(): void {
    if (this.fileFlushTimer) clearTimeout(this.fileFlushTimer)
    this.fileFlushTimer = setTimeout(() => {
      this.fileFlushTimer = null
      void this.flushToFile()
    }, this.fileFlushIntervalMs)
  }

  destroy(): void {
    this.destroyed = true
    this.cancelPersistenceWaiters(new Error('Document destroyed before persistence committed'))
    this.syncLifecycle++
    this.fileIO = undefined
    if (this.contentObserver) {
      this.yDoc.getText('content').unobserve(this.contentObserver)
      this.contentObserver = undefined
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

    this._cleanupDeferredIndexedDBCreation()

    if (this._indexedDBProvider) {
      void this._indexedDBProvider.destroy()
      this._indexedDBProvider = undefined
    }
    this._indexedDBLoaded = false
    this._indexedDBWasEmpty = false
    this._serverSyncing = false
    this._serverSynced = false

    super.destroy()
  }
}
