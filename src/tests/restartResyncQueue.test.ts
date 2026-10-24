import { RestartResyncQueue } from '../restartResyncQueue'

function fixture() {
  let ready = false
  let stopped = false
  const listeners = new Set<() => void>()
  const events: string[] = []
  const document = {
    shareId: 'document',
    syncable: {
      get canStartServerSync(): boolean { return ready },
      on: (_event: 'syncStateChanged', listener: () => void): void => { listeners.add(listener) },
      off: (_event: 'syncStateChanged', listener: () => void): void => { listeners.delete(listener) },
      resyncAfterCurrent: async (): Promise<void> => { events.push('server request') },
    },
  }
  let current: typeof document | undefined = document
  const errors: unknown[] = []
  const queue = new RestartResyncQueue(() => current, () => stopped, (_id, error) => errors.push(error))
  return {
    queue, events, errors, listeners,
    reconcileLocal: (): void => {
      events.push('local reconciliation')
      ready = true
      for (const listener of Array.from(listeners)) listener()
    },
    stop: (): void => { stopped = true; queue.destroy() },
    replace: (): void => { current = undefined },
  }
}

it('defers checkpoint-triggered work until local reconciliation and the initiating call finish', async () => {
  const f = fixture()
  f.queue.request('document')
  f.queue.request('document')
  await Promise.resolve()
  expect(f.events).toEqual([])
  f.reconcileLocal()
  f.events.push('factory sync installed')
  await Promise.resolve()
  expect(f.events).toEqual(['local reconciliation', 'factory sync installed', 'server request'])
  expect(f.listeners.size).toBe(0)
  f.queue.destroy()
})

it('does not resume a queued request after plugin shutdown', async () => {
  const f = fixture()
  f.queue.request('document')
  f.reconcileLocal()
  f.stop()
  await Promise.resolve()
  expect(f.events).toEqual(['local reconciliation'])
  expect(f.listeners.size).toBe(0)
})

it('does not synchronize a document that was replaced during initialization', async () => {
  const f = fixture()
  f.queue.request('document')
  f.replace()
  f.reconcileLocal()
  await Promise.resolve()
  expect(f.events).toEqual(['local reconciliation'])
  expect(f.listeners.size).toBe(0)
  f.queue.destroy()
})
