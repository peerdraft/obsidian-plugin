import * as Y from 'yjs'

export interface SyncProof {
  checkpoint: string
  stateHash: string
}

export interface CheckpointManifest {
  supported: boolean
  checkpoints: Record<string, string | null>
}

export interface RestartRecord extends SyncProof {
  schema: 1
  scope: string
  persistenceId: string
  contentHash: string
}

export interface FastRestartDocument {
  shareId: string
  persistenceId: string
  yDoc: Y.Doc
  readFile(): Promise<string>
  getMTime(): number
  content(): string
  isEligible(): boolean
  checksum(): string
}

export interface FastRestartOptions {
  scope: string
  records: Record<string, RestartRecord>
  transport: { requestCheckpoints(ids: string[]): Promise<CheckpointManifest> }
  getDocument(id: string): FastRestartDocument | undefined
  persist(records: Record<string, RestartRecord>): Promise<void>
  requestResync(id: string): void
  isStopped?: () => boolean
}

const SHA256 = /^[0-9a-f]{64}$/
const MAX_BATCH = 2000

export function isSyncProof(value: unknown): value is SyncProof {
  if (!value || typeof value !== 'object') return false
  const proof = value as Partial<SyncProof>
  return typeof proof.checkpoint === 'string' && proof.checkpoint.length > 0 && proof.checkpoint.length <= 256 &&
    typeof proof.stateHash === 'string' && SHA256.test(proof.stateHash)
}

/** Hash the encoded state, including metadata and deletion history, rather than text alone. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function textSha256(text: string): Promise<string> {
  return sha256(new TextEncoder().encode(text))
}

/** UndoManager keeps deleted payloads locally; proofs compare the same GC-normalized state as the server. */
export function canonicalStateUpdate(document: Y.Doc): Uint8Array {
  const normalized = new Y.Doc({ gc: true })
  try {
    Y.applyUpdate(normalized, Y.encodeStateAsUpdate(document))
    return Y.encodeStateAsUpdate(normalized)
  } finally { normalized.destroy() }
}

/**
 * A checkpoint verifies a previously proven complete cache; it never replaces
 * loading/reconciling that cache. Every asynchronous proof is generation guarded.
 */
export class FastRestartManager {
  private readonly records: Record<string, RestartRecord> = Object.create(null)
  private readonly checkpoints = new Map<string, string | null>()
  private readonly generations = new Map<string, number>()
  private readonly watches = new Map<string, { doc: Y.Doc; update: () => void }>()
  private epoch = 0
  private available = false
  private verificationInterrupted = false
  private destroyed = false
  private preparation: Promise<void> = Promise.resolve()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private persistence: Promise<void> = Promise.resolve()
  private dirty = false
  private persistenceFailed = false

  constructor(private readonly options: FastRestartOptions) {
    if (options.records && typeof options.records === 'object') {
      for (const [id, record] of Object.entries(options.records)) {
        if (this.validRecord(record)) this.records[id] = { ...record }
      }
    }
  }

  private validRecord(value: unknown): value is RestartRecord {
    if (!isSyncProof(value)) return false
    const record = value as Partial<RestartRecord>
    return record.schema === 1 && record.scope === this.options.scope &&
      typeof record.persistenceId === 'string' && record.persistenceId.length > 0 &&
      typeof record.contentHash === 'string' && SHA256.test(record.contentHash)
  }

  private stopped(): boolean { return this.destroyed || !!this.options.isStopped?.() }
  private generation(id: string): number { return this.generations.get(id) ?? 0 }
  private bump(id: string): void { this.generations.set(id, this.generation(id) + 1) }

  private watch(document: FastRestartDocument): void {
    const previous = this.watches.get(document.shareId)
    if (previous?.doc === document.yDoc) return
    if (previous) previous.doc.off('update', previous.update)
    const update = (): void => { this.bump(document.shareId) }
    document.yDoc.on('update', update)
    this.watches.set(document.shareId, { doc: document.yDoc, update })
    this.bump(document.shareId)
  }

  private unchanged(document: FastRestartDocument, generation: number, epoch: number, mtime: number): boolean {
    const current = this.options.getDocument(document.shareId)
    return !this.stopped() && epoch === this.epoch && generation === this.generation(document.shareId) &&
      document.isEligible() && document.getMTime() === mtime && current?.yDoc === document.yDoc &&
      current.persistenceId === document.persistenceId
  }

  /** Subscribe/read every requested checkpoint in bounded batches, with race invalidation. */
  prepare(ids: Iterable<string>): Promise<void> {
    const epoch = this.epoch
    const unique = Array.from(new Set(ids))
    const work = async (): Promise<void> => {
      try {
        for (let offset = 0; offset < unique.length; offset += MAX_BATCH) {
          if (this.stopped() || epoch !== this.epoch) return
          const batch = unique.slice(offset, offset + MAX_BATCH)
          const generations = new Map(batch.map(id => [id, this.generation(id)]))
          const manifest = await this.options.transport.requestCheckpoints(batch)
          if (this.stopped() || epoch !== this.epoch) return
          if (!manifest.supported) {
            this.available = false
            this.verificationInterrupted = true
            return
          }
          this.available = true
          for (const id of batch) {
            if (generations.get(id) !== this.generation(id)) continue
            const checkpoint = manifest.checkpoints[id] ?? null
            const previous = this.checkpoints.has(id) ? this.checkpoints.get(id) : this.records[id]?.checkpoint
            this.checkpoints.set(id, checkpoint)
            if ((previous !== undefined && previous !== checkpoint) ||
              (previous === undefined && this.verificationInterrupted && this.options.getDocument(id))) {
              this.invalidate(id, checkpoint)
            }
          }
        }
        this.verificationInterrupted = false
      } catch {
        if (epoch === this.epoch) {
          this.available = false
          this.verificationInterrupted = true
        }
      }
    }
    this.preparation = this.preparation.then(work, work)
    return this.preparation
  }

  /** Return the existing sync checksum only when cache, file and server state all match. */
  async tryVerify(document: FastRestartDocument): Promise<string | null> {
    await this.preparation
    if (this.stopped() || !this.available || this.persistenceFailed || !document.isEligible()) return null
    const record = this.records[document.shareId]
    const checkpoint = this.checkpoints.get(document.shareId)
    if (!this.validRecord(record) || record.persistenceId !== document.persistenceId || !checkpoint || record.checkpoint !== checkpoint) return null
    this.watch(document)
    const generation = this.generation(document.shareId)
    const epoch = this.epoch
    const mtime = document.getMTime()
    try {
      const state = canonicalStateUpdate(document.yDoc)
      const content = await document.readFile()
      const [stateHash, contentHash] = await Promise.all([sha256(state), textSha256(content)])
      if (!this.unchanged(document, generation, epoch, mtime) || this.checkpoints.get(document.shareId) !== checkpoint) return null
      if (stateHash !== record.stateHash || contentHash !== record.contentHash || content !== document.content()) return null
      return document.checksum()
    } catch { return null }
  }

  /** A normal handshake can establish a durable clean record only with full-state proof. */
  async captureProof(id: string, proof: SyncProof): Promise<void> {
    if (this.stopped() || !this.available || !isSyncProof(proof) || this.checkpoints.get(id) !== proof.checkpoint) return
    const document = this.options.getDocument(id)
    if (!document?.isEligible()) return
    this.watch(document)
    const generation = this.generation(id)
    const epoch = this.epoch
    const mtime = document.getMTime()
    try {
      const state = canonicalStateUpdate(document.yDoc)
      const content = await document.readFile()
      const [stateHash, contentHash] = await Promise.all([sha256(state), textSha256(content)])
      if (!this.unchanged(document, generation, epoch, mtime) || this.checkpoints.get(id) !== proof.checkpoint) return
      if (stateHash !== proof.stateHash || content !== document.content()) return
      this.records[id] = {
        schema: 1, scope: this.options.scope, persistenceId: document.persistenceId,
        checkpoint: proof.checkpoint, stateHash, contentHash,
      }
      this.schedulePersistence()
    } catch { /* An unreadable or unsettled file remains on the normal sync path. */ }
  }

  /** Committed changes invalidate even proofs/reads currently awaiting asynchronous work. */
  invalidate(id: string, checkpoint: string | null): void {
    if (this.stopped()) return
    this.bump(id)
    this.checkpoints.set(id, checkpoint)
    if (this.records[id]) {
      delete this.records[id]
      this.schedulePersistence()
    }
    this.options.requestResync(id)
  }

  /** Vault edits invalidate in-flight file hashes without recursively requesting a sync. */
  invalidateLocal(id: string): void {
    if (this.stopped()) return
    this.bump(id)
    if (this.records[id]) {
      delete this.records[id]
      this.schedulePersistence()
    }
  }

  resetConnection(): void {
    this.epoch++
    this.available = false
    this.checkpoints.clear()
  }

  private schedulePersistence(): void {
    this.dirty = true
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.flushPersistence()
    }, 250)
  }

  /** Serialize debounced snapshots; failed persistence disables the optional fast path. */
  flushPersistence(): Promise<void> {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    if (!this.dirty) return this.persistence
    this.dirty = false
    const snapshot: Record<string, RestartRecord> = Object.fromEntries(
      Object.entries(this.records).map(([id, record]) => [id, { ...record }]),
    )
    this.persistence = this.persistence.then(async () => {
      try {
        await this.options.persist(snapshot)
        this.persistenceFailed = false
      } catch (error) {
        this.persistenceFailed = true
        console.error('[Peerdraft] Could not save restart verification records', error)
      }
    })
    return this.persistence
  }

  destroy(): void {
    this.destroyed = true
    this.epoch++
    for (const { doc, update } of this.watches.values()) doc.off('update', update)
    this.watches.clear()
    void this.flushPersistence()
  }
}
