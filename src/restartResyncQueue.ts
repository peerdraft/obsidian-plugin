interface ResyncDocument {
  readonly shareId: string
  readonly syncable: {
    readonly canStartServerSync: boolean
    on(event: 'syncStateChanged', listener: () => void): unknown
    off(event: 'syncStateChanged', listener: () => void): unknown
    resyncAfterCurrent(): Promise<unknown>
  }
}

interface PendingResync {
  document: ResyncDocument
  check: () => void
  scheduled: boolean
}

/** A checkpoint notification cannot interrupt cache loading or local reconciliation. */
export class RestartResyncQueue {
  private readonly pending = new Map<string, PendingResync>()
  private closed = false

  constructor(
    private readonly find: (id: string) => ResyncDocument | undefined,
    private readonly stopped: () => boolean,
    private readonly reportError: (id: string, error: unknown) => void,
  ) {}

  request(id: string): void {
    if (this.closed || this.stopped()) return
    const document = this.find(id)
    if (!document) return
    const previous = this.pending.get(id)
    if (previous?.document === document) return
    if (previous) this.remove(id, previous)
    const entry: PendingResync = { document, scheduled: false, check: () => {} }
    entry.check = () => {
      if (this.closed || this.stopped() || this.find(id) !== document) {
        this.remove(id, entry)
        return
      }
      if (!document.syncable.canStartServerSync || entry.scheduled) return
      entry.scheduled = true
      // The readiness event can fire while its factory is installing a sync
      // promise; let that call finish before queuing a fresh exchange.
      queueMicrotask(() => {
        entry.scheduled = false
        if (this.closed || this.stopped() || this.find(id) !== document) {
          this.remove(id, entry)
          return
        }
        if (!document.syncable.canStartServerSync) return
        this.remove(id, entry)
        void document.syncable.resyncAfterCurrent().catch(error => {
          if (!this.closed && !this.stopped()) this.reportError(id, error)
        })
      })
    }
    this.pending.set(id, entry)
    document.syncable.on('syncStateChanged', entry.check)
    entry.check()
  }

  private remove(id: string, entry: PendingResync): void {
    entry.document.syncable.off('syncStateChanged', entry.check)
    if (this.pending.get(id) === entry) this.pending.delete(id)
  }

  destroy(): void {
    this.closed = true
    for (const [id, entry] of this.pending) this.remove(id, entry)
  }
}
