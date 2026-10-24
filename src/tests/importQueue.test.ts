import { ImportQueue, ImportQueueDestroyedError } from '../importQueue'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

it('starts at most eight imports by default and fills freed slots in FIFO order', async () => {
  const queue = new ImportQueue()
  const gates = Array.from({ length: 12 }, () => deferred<number>())
  const started: number[] = []
  let active = 0
  let maximum = 0
  const jobs = gates.map((gate, index) => queue.schedule(String(index), async () => {
    started.push(index)
    maximum = Math.max(maximum, ++active)
    try { return await gate.promise }
    finally { active-- }
  }))
  await Promise.resolve()
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(queue.activeCount).toBe(8)
  expect(queue.pendingCount).toBe(4)
  gates[3].resolve(3)
  await jobs[3]
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  expect(queue.activeCount).toBe(8)
  gates.forEach((gate, index) => gate.resolve(index))
  expect(await Promise.all(jobs)).toEqual(gates.map((_gate, index) => index))
  await queue.idle()
  expect(started).toEqual(gates.map((_gate, index) => index))
  expect(maximum).toBe(8)
  expect(queue.activeCount).toBe(0)
  expect(queue.pendingCount).toBe(0)
})

it('coalesces pending and running requests and allows a fresh request after completion', async () => {
  const queue = new ImportQueue(1)
  const first = deferred<string>()
  const work = deferred<string>()
  const events: string[] = []
  const blocker = queue.schedule('blocker', () => first.promise)
  const pending = queue.schedule('same', () => { events.push('original'); return work.promise })
  const duplicate = queue.schedule('same', async () => { events.push('pending duplicate'); return 'wrong' })
  expect(duplicate).toBe(pending)
  first.resolve('released')
  await blocker
  const runningDuplicate = queue.schedule('same', async () => { events.push('running duplicate'); return 'wrong' })
  expect(runningDuplicate).toBe(pending)
  work.resolve('shared result')
  expect(await Promise.all([pending, duplicate, runningDuplicate])).toEqual([
    'shared result', 'shared result', 'shared result',
  ])
  expect(await queue.schedule('same', async () => { events.push('fresh'); return 'new result' })).toBe('new result')
  expect(events).toEqual(['original', 'fresh'])
})

it('releases failed slots and keys so later imports and retries complete', async () => {
  const queue = new ImportQueue(1)
  const failure = new Error('Download failed')
  const failed = queue.schedule('failed', async () => { throw failure })
  const next = queue.schedule('next', async () => 'next downloaded')
  await expect(failed).rejects.toBe(failure)
  await expect(next).resolves.toBe('next downloaded')
  await expect(queue.schedule('failed', async () => 'retry downloaded')).resolves.toBe('retry downloaded')
  await queue.idle()
  expect(queue.activeCount).toBe(0)
})

it('also releases a slot when a work callback throws before returning a promise', async () => {
  const queue = new ImportQueue(1)
  const failure = new Error('Cannot initialize import')
  const failed = queue.schedule('failed', () => { throw failure })
  const next = queue.schedule('next', async () => 'recovered')
  await expect(failed).rejects.toBe(failure)
  await expect(next).resolves.toBe('recovered')
  await queue.idle()
})

it('handles work enqueued while a task completes without losing or reordering it', async () => {
  const queue = new ImportQueue(1)
  const events: string[] = []
  let appended!: Promise<string>
  const first = queue.schedule('first', async () => {
    await Promise.resolve()
    events.push('first')
    appended = queue.schedule('appended', async () => { events.push('appended'); return 'appended' })
    return 'first'
  })
  const second = queue.schedule('second', async () => { events.push('second'); return 'second' })
  await first
  const onCompletion = first.then(() => queue.schedule('completion', async () => {
    events.push('completion')
    return 'completion'
  }))
  expect(await Promise.all([second, appended, onCompletion])).toEqual(['second', 'appended', 'completion'])
  await queue.idle()
  expect(events).toEqual(['first', 'second', 'appended', 'completion'])
})

it('rejects pending and new jobs on destroy and waits for running work before becoming idle', async () => {
  const queue = new ImportQueue(1)
  const gate = deferred<string>()
  const events: string[] = []
  const running = queue.schedule('running', () => { events.push('running'); return gate.promise })
  const pending = queue.schedule('pending', async () => { events.push('pending'); return 'wrong' })
  const rejected = expect(pending).rejects.toBeInstanceOf(ImportQueueDestroyedError)
  let idle = false
  const waiting = queue.idle().then(() => { idle = true })
  await Promise.resolve()
  queue.destroy()
  queue.destroy()
  await rejected
  await expect(queue.schedule('new', async () => { events.push('new'); return 'wrong' })).rejects.toBeInstanceOf(ImportQueueDestroyedError)
  expect(queue.pendingCount).toBe(0)
  expect(queue.activeCount).toBe(1)
  expect(idle).toBe(false)
  gate.resolve('running finished')
  await expect(running).resolves.toBe('running finished')
  await waiting
  await queue.idle()
  expect(events).toEqual(['running'])
  expect(idle).toBe(true)
})

it('keeps every idle waiter pending until queued and running imports finish', async () => {
  const queue = new ImportQueue(1)
  await queue.idle()
  const firstGate = deferred<void>()
  const secondGate = deferred<void>()
  const first = queue.schedule('first', () => firstGate.promise)
  const second = queue.schedule('second', () => secondGate.promise)
  const events: string[] = []
  const one = queue.idle().then(() => { events.push('idle one') })
  const two = queue.idle().then(() => { events.push('idle two') })
  firstGate.resolve()
  await first
  expect(events).toEqual([])
  secondGate.resolve()
  await second
  await Promise.all([one, two])
  expect(events).toEqual(['idle one', 'idle two'])
})

it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid concurrency %s', concurrency => {
  expect(() => new ImportQueue(concurrency)).toThrow('positive integer')
})
