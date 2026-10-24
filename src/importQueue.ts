interface ImportTask {
  key: string
  promise: Promise<unknown>
  start(): void
  reject(error: unknown): void
}

export class ImportQueueDestroyedError extends Error {
  constructor() {
    super('The import queue has been destroyed')
    this.name = 'ImportQueueDestroyedError'
  }
}

/** Bound document imports and share one result for duplicate in-flight requests. */
export class ImportQueue {
  private readonly tasks = new Map<string, ImportTask>()
  private readonly waiting: ImportTask[] = []
  private readonly idleWaiters: Array<() => void> = []
  private running = 0
  private destroyed = false

  constructor(private readonly concurrency = 8) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Import concurrency must be a positive integer')
    }
  }

  get activeCount(): number { return this.running }
  get pendingCount(): number { return this.waiting.length }

  schedule<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.destroyed) return Promise.reject(new ImportQueueDestroyedError())
    const existing = this.tasks.get(key)
    if (existing) return existing.promise as Promise<T>

    let resolveTask!: (value: T | PromiseLike<T>) => void
    let rejectTask!: (error: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
      resolveTask = resolve
      rejectTask = reject
    })
    const task: ImportTask = {
      key,
      promise,
      reject: rejectTask,
      start: () => {
        // Invoke work as the slot is assigned, so destroy never starts more
        // callbacks later. Normalize synchronous errors to the same result path.
        let result: Promise<T>
        try { result = work() }
        catch (error) { result = Promise.reject(error) }
        // Both handlers return normally: no discarded rejecting cleanup promise.
        void Promise.resolve(result).then(value => {
          this.finish(task)
          resolveTask(value)
        }, (error: unknown) => {
          this.finish(task)
          rejectTask(error)
        })
      },
    }
    this.tasks.set(key, task)
    this.waiting.push(task)
    this.drain()
    return promise
  }

  idle(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.push(resolve) })
  }

  /** Running imports finish under their owner's lifecycle guards. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const task of this.waiting.splice(0)) {
      this.tasks.delete(task.key)
      task.reject(new ImportQueueDestroyedError())
    }
    this.resolveIdle()
  }

  private drain(): void {
    while (!this.destroyed && this.running < this.concurrency && this.waiting.length > 0) {
      const task = this.waiting.shift()!
      this.running++
      task.start()
    }
  }

  private finish(task: ImportTask): void {
    this.tasks.delete(task.key)
    this.running--
    this.drain()
    this.resolveIdle()
  }

  private resolveIdle(): void {
    if (this.running !== 0 || this.waiting.length !== 0) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}
