import { Mutex } from 'async-mutex'
import { ObservableV2 } from 'lib0/observable'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { diff, diffCleanupEfficiency } from 'diff-match-patch-es'

import { calculateHash } from '../tools'

/**
 * File I/O port for SyncableDocument. Abstracts vault read/write operations
 * so the syncable can work with real vault I/O in production and fake I/O
 * in tests.
 */
export interface SyncableFileIO {
  read(): Promise<string>
  modify(content: string, opts?: { mtime?: number }): Promise<void>
  getMTime(): number
}

/**
 * Clock port for SyncableDocument. Abstracts time access so the syncable
 * can use real time in production and fake time in tests (for mtime-dependent
 * logic like the self-echo guard).
 */
export interface SyncableClock {
  now(): number
}

/**
 * Sync-engine logic extracted from `SharedDocument`. Owns:
 *   - the `Y.Doc` and its registered shareId,
 *   - IndexedDB persistence lifecycle,
 *   - the local-update batcher / debounced flush to the sync WS,
 *   - `syncWithServer()` (`SYNC_STEP_1` ping-pong wrapper),
 *   - the static registry the plugin's `PeerdraftWebsocketProvider`
 *     uses on reconnect to re-sync every permanent doc.
 *
 * Deliberately has no imports from `obsidian`, `@codemirror/*`,
 * `y-codemirror.next`, `src/ui/*`, `src/workspace/*`, or
 * `src/permanentShareStore*`. That import-purity is what enables
 * Phase B of the sync-harness (see
 * `app/features/sync-engine-testability/implementation-plan.md`).
 *
 * `SharedDocument` composes one of these and wires Obsidian-specific
 * concerns (status bar, leaf extensions, vault.on("modify") listener,
 * canvas extension) around it.
 *
 * NOTE on flush semantics: matches the previous SharedDocument
 * behavior of `debounce(fn, 1000, true)` — the timer is reset on
 * every local edit, so flush happens 1 s after the LAST edit.
 * Continuous typing therefore delays flush until the user pauses;
 * this is preserved deliberately so this refactor is behavior-neutral.
 */

/** xxhash hex string of the doc's "content" text fragment. */
export type SyncableHash = string

export const SYNCABLE_DB_PERSISTENCE_PREFIX = 'peerdraft_persistence_'

/**
 * The subset of `PeerdraftWebsocketProvider` that `SyncableDocument`
 * depends on. Typed structurally so the harness can swap in a fake.
 */
export interface SyncableServerSync {
  on(event: 'synced', handler: (id: string, hash: string) => void): unknown
  off(event: 'synced', handler: (id: string, hash: string) => void): unknown
  sendSyncStep1(entity: SyncableEntity): void
  sendUpdate(entity: SyncableEntity, update: Uint8Array): void
}

/**
 * The minimal entity shape the provider's send methods consume. Both
 * `SyncableDocument` and (eventually) `SyncableFolder` satisfy this.
 */
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
  /**
   * If provided, IndexedDB persistence is started on construction
   * (`startIndexedDBSync` is fire-and-forget; await
   * `whenIndexedDBSynced()` to know it finished).
   */
  persistenceId?: string
  /** Default 1000 ms. */
  flushIntervalMs?: number
  /**
   * File I/O adapter. If provided, the syncable installs a
   * `content` observer that schedules debounced flushes to the file
   * and exposes `reconcileWithFileContent()` for the vault-modify
   * path. Absent in pure server-sync harnesses (S1/S2/S3).
   */
  fileIO?: SyncableFileIO
  /** Clock for the self-echo guard. Defaults to `Date.now()`. */
  clock?: SyncableClock
  /**
   * Predicate returning how many CodeMirror editor extensions are
   * attached. When > 0, the editor owns vault writes and the syncable
   * skips its own file flush / reconcile work (matches the existing
   * `_extensions.size === 0` guard in `SharedDocument`).
   *
   * Defaults to "no editor attached" so harnesses don't need to
   * supply one.
   */
  editorAttachedCount?: () => number
  /** Default 1000 ms. Debounce for yDoc → file flushes. */
  fileFlushIntervalMs?: number
  /**
   * Optional custom registry for this syncable. If provided, this
   * syncable will register itself in the custom registry instead of
   * the static `SyncableDocument._registry`. Used by test harnesses
   * to avoid registry conflicts when running multiple clients in the
   * same process.
   */
  registry?: Map<string, SyncableDocument>
}

type Events = {
  /** Pending local updates were merged + sent (or attempted; the WS
   *  may have been closed, in which case the merged update is dropped
   *  and the next `syncWithServer` reconciles via `SYNC_STEP_1`). */
  flushed: (count: number) => void
  /** A `SYNC_STEP_2` for our shareId arrived from the server. */
  synced: (hash: SyncableHash) => void
  /** The syncable wrote its current content out to the `FileIO`
   *  port. Emitted AFTER the write resolves, with the mtime that was
   *  recorded on the write so callers can correlate with
   *  `getMTime()`. */
  'file-flushed': (mtime: number) => void
  /** `reconcileWithFileContent` merged an external diff into the
   *  content fragment. Emitted ONLY when a transaction actually
   *  happened (content differed and the echo guard cleared). */
  reconciled: (hash: SyncableHash) => void
}

export class SyncableDocument extends ObservableV2<Events> implements SyncableEntity {
  static readonly DB_PERSISTENCE_PREFIX = SYNCABLE_DB_PERSISTENCE_PREFIX

  /**
   * Registry the provider's reconnect / lookup paths consult instead of
   * importing `SharedDocument` directly. Entries appear when a `shareId`
   * is set and disappear on `destroy()`.
   */
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

  private pendingUpdates: Uint8Array[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private readonly updateListener: (
    update: Uint8Array,
    origin: unknown,
    doc: Y.Doc,
    tx: Y.Transaction
  ) => void

  // ---- File-sync state (only installed when `fileIO` is supplied) ----

  private fileIO?: SyncableFileIO
  private readonly clock: SyncableClock
  private readonly editorAttachedCount: () => number
  private readonly fileFlushIntervalMs: number
  private fileFlushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly fileMutex = new Mutex()
  private contentObserver?: () => void

  private readonly registry: Map<string, SyncableDocument>

  /**
   * mtime of the most recent write this syncable performed through
   * `fileIO.modify(...)`. The `reconcileWithFileContent` path
   * compares this against `fileIO.getMTime()` to detect and skip
   * its own echoes (same semantics as the legacy
   * `SharedDocument.lastUpdateTriggeredByDocChange` guard).
   */
  private _lastUpdateTriggeredByDocChange = 0

  /**
   * Set or update the FileIO adapter after construction. This is needed
   * when the file becomes available after the SyncableDocument is created
   * (e.g., in `fromShareURL` where the file is created after syncable
   * construction). Reinstalls the content observer if fileIO transitions
   * from undefined to defined.
   */
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
      // Only forward local edits, and only when this share is persistent.
      // Remote updates (origin === provider) have tx.local === false.
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

  // -------------------------------------------------------------------
  // Static registry — used by PeerdraftWebsocketProvider's onopen loop
  // and SYNC_STEP_1 / SYNC_STEP_2 lookup, instead of importing the full
  // SharedDocument class.
  // -------------------------------------------------------------------

  static findById(id: string): SyncableDocument | undefined {
    return this._registry.get(id)
  }

  static getAll(): SyncableDocument[] {
    return Array.from(this._registry.values())
  }

  // -------------------------------------------------------------------
  // SyncableEntity surface
  // -------------------------------------------------------------------

  get shareId(): string {
    return this._shareId
  }

  get isPermanent(): boolean {
    return this._isPermanent
  }

  get indexedDBProvider(): IndexeddbPersistence | undefined {
    return this._indexedDBProvider
  }

  /**
   * Set or update the shareId. Used after `NEW_DOCUMENT_CONFIRMED` /
   * `NEW_SESSION_CONFIRMED` allocates the server-side id.
   */
  setShareId(id: string): void {
    if (this._shareId === id) return
    if (this._shareId) {
      this.registry.delete(this._shareId)
    }
    this._shareId = id
    if (id) {
      this.registry.set(id, this)
    }
  }

  setPermanent(value: boolean): void {
    this._isPermanent = value
  }

  /**
   * Hash of the "content" Y.Text. Matches the previous
   * `SharedDocument.calculateHash` implementation byte-for-byte so that
   * server-side checksum comparisons keep working during the rollout.
   */
  calculateHash(): SyncableHash {
    return calculateHash(this.yDoc.getText('content').toString())
  }

  // -------------------------------------------------------------------
  // Server sync
  // -------------------------------------------------------------------

  /**
   * Send `SYNC_STEP_1` and resolve when the matching `SYNC_STEP_2`
   * arrives (the provider emits `synced` for our id). Mirrors
   * `SharedEntity.syncWithServer`.
   */
  syncWithServer(timeoutMs?: number): Promise<SyncableHash> {
    return new Promise<SyncableHash>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const handler = (id: string, hash: string) => {
        if (id !== this._shareId) return
        this.serverSync.off('synced', handler)
        if (timer) clearTimeout(timer)
        this.emit('synced', [hash])
        this.logger.log('synced ' + this._shareId)
        resolve(hash)
      }
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.serverSync.off('synced', handler)
          reject(
            new Error(
              `syncWithServer(${this._shareId}) timed out after ${timeoutMs}ms`
            )
          )
        }, timeoutMs)
      }
      this.serverSync.on('synced', handler)
      this.serverSync.sendSyncStep1(this)
      this.logger.log('syncing ' + this._shareId)
    })
  }

  // -------------------------------------------------------------------
  // IndexedDB persistence
  // -------------------------------------------------------------------

  /**
   * Start `y-indexeddb` persistence for this Y.Doc keyed by
   * `${DB_PERSISTENCE_PREFIX}${persistenceId}`. Idempotent: a second
   * call returns the existing provider.
   */
  async startIndexedDBSync(persistenceId: string): Promise<IndexeddbPersistence> {
    if (this._indexedDBProvider) return this._indexedDBProvider
    const provider = new IndexeddbPersistence(
      SyncableDocument.DB_PERSISTENCE_PREFIX + persistenceId,
      this.yDoc
    )
    this._indexedDBProvider = provider
    if (!provider.synced) await provider.whenSynced
    return provider
  }

  /**
   * Resolve when IndexedDB sync (started via the constructor's
   * `persistenceId` option) has finished. No-op if IndexedDB is not
   * configured.
   */
  whenIndexedDBSynced(): Promise<void> {
    return this.indexedDBSyncPromise ?? Promise.resolve()
  }

  async stopIndexedDBSync(): Promise<void> {
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.destroy()
      this._indexedDBProvider = undefined
    }
  }

  // -------------------------------------------------------------------
  // Local-update batcher
  // -------------------------------------------------------------------

  /**
   * Force-flush any pending local updates to the server. Returns a
   * promise that resolves once the (mutex-serialised) send completes.
   * Safe to call when there are no pending updates.
   */
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

  /** Number of local updates currently buffered. Test-introspection only. */
  get pendingUpdateCount(): number {
    return this.pendingUpdates.length
  }

  private scheduleFlush(): void {
    // Match the previous `debounce(fn, 1000, true)` behavior: every
    // edit resets the timer so flush happens 1 s AFTER the last edit.
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPendingUpdates()
    }, this.flushIntervalMs)
  }

  // -------------------------------------------------------------------
  // File sync (only active when fileIO is provided)
  // -------------------------------------------------------------------

  /**
   * Write the current Y.Doc content to the file via the FileIO port.
   * Debounced via scheduleFileFlush; call directly for deterministic
   * behavior in tests.
   */
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

  /**
   * Merge external file content into the Y.Doc using diff-match-patch.
   * Implements the self-echo guard to avoid re-ingesting the syncable's
   * own writes by comparing file mtime with `_lastUpdateTriggeredByDocChange`.
   */
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

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

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
    super.destroy()
  }
}
