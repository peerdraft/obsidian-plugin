import { ObservableV2 } from 'lib0/observable'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { calculateHash, serialize } from '../tools'
import {
  SYNCABLE_DB_PERSISTENCE_PREFIX,
  type SyncableEntity,
  type SyncableHash,
  type SyncableLogger,
  type SyncableServerSync,
} from './syncableDocument'

/**
 * Folder counterpart of `SyncableDocument`. Owns the folder-level
 * Y.Doc, its IndexedDB persistence, `syncWithServer`, and the registry
 * the plugin's `PeerdraftWebsocketProvider` consults on reconnect.
 *
 * Deliberately has no imports from `obsidian`, `@codemirror/*`,
 * `src/ui/*`, `src/workspace/*`, `src/permanentShareStore*`, or
 * `./sharedDocument` / `./sharedFolder`. Only pure-TS deps, so the
 * sync-harness can instantiate folder-sync in tests without mocking
 * the plugin's Obsidian-side glue.
 *
 * Simpler than `SyncableDocument` because:
 *   - folders are always permanent, so there is no `isPermanent` gate
 *     on local-update forwarding,
 *   - folder updates are sent immediately (no debounced batcher) —
 *     matching the previous inline listener at
 *     `sharedFolder.ts:296-300` pre-refactor,
 *   - the hash is a deterministic serialization of the document map,
 *     not the content text.
 *
 * `SharedFolder` composes one of these and wires Obsidian-specific
 * concerns (vault file/folder mutations driven by the docs-map
 * `observe` callback, WebRTC lifecycle, etc.) around it.
 */
export class SyncableFolder extends ObservableV2<{
  flushed: (count: number) => void
  synced: (hash: SyncableHash) => void
}> implements SyncableEntity {
  static readonly DB_PERSISTENCE_PREFIX = SYNCABLE_DB_PERSISTENCE_PREFIX

  private static _registry = new Map<string, SyncableFolder>()

  readonly yDoc: Y.Doc

  private _shareId: string
  private readonly serverSync: SyncableServerSync
  private readonly logger: SyncableLogger

  private _indexedDBProvider?: IndexeddbPersistence
  private indexedDBSyncPromise?: Promise<void>

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
      // Matches the previous SharedFolder inline listener: forward every
      // local update immediately (no debounce), gated on having a
      // shareId. Folders are always permanent so no extra gate.
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
      this.indexedDBSyncPromise = this.startIndexedDBSync(opts.persistenceId).then(
        () => undefined
      )
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

  setShareId(id: string): void {
    if (this._shareId === id) return
    if (this._shareId) {
      SyncableFolder._registry.delete(this._shareId)
    }
    this._shareId = id
    if (id) {
      SyncableFolder._registry.set(id, this)
    }
  }

  /**
   * Hash over the serialized `documents` Y.Map. Matches the previous
   * `SharedFolder.calculateHash` byte-for-byte so server-side checksum
   * comparisons keep working during the rollout.
   */
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

  async startIndexedDBSync(persistenceId: string): Promise<IndexeddbPersistence> {
    if (this._indexedDBProvider) return this._indexedDBProvider
    const provider = new IndexeddbPersistence(
      SyncableFolder.DB_PERSISTENCE_PREFIX + persistenceId,
      this.yDoc
    )
    this._indexedDBProvider = provider
    if (!provider.synced) await provider.whenSynced
    return provider
  }

  whenIndexedDBSynced(): Promise<void> {
    return this.indexedDBSyncPromise ?? Promise.resolve()
  }

  async stopIndexedDBSync(): Promise<void> {
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.destroy()
      this._indexedDBProvider = undefined
    }
  }

  destroy(): void {
    this.yDoc.off('update', this.updateListener)
    if (this._shareId) {
      SyncableFolder._registry.delete(this._shareId)
    }
    super.destroy()
  }
}
