import { restoreSharesInParallel, runStartupSync } from '../startupSync'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('runStartupSync', () => {
  test('shows all pending shares before connecting and keeps restoration behind the connection', async () => {
    const connection = deferred()
    const order: string[] = []
    const restoreFiles = jest.fn().mockResolvedValue(undefined)
    const restoreFolders = jest.fn().mockResolvedValue(undefined)
    const done = runStartupSync({
      showPendingShares: async () => { order.push('indicators') },
      connect: () => { order.push('connect') },
      connected: () => { order.push('connected'); return connection.promise },
      restoreFiles,
      restoreFolders,
    })

    await flushMicrotasks()
    expect(order).toEqual(['indicators', 'connect', 'connected'])
    expect(restoreFiles).not.toHaveBeenCalled()
    expect(restoreFolders).not.toHaveBeenCalled()

    connection.resolve()
    await done
    expect(restoreFiles).toHaveBeenCalledTimes(1)
    expect(restoreFolders).toHaveBeenCalledTimes(1)
  })

  test('keeps files before folders while restoring peers in parallel', async () => {
    const slowFile = deferred()
    const started: string[] = []
    const restoreFiles = () => restoreSharesInParallel(['slow.md', 'fast.md'], async path => {
      started.push(path)
      if (path === 'slow.md') await slowFile.promise
    }, jest.fn())
    const done = runStartupSync({
      showPendingShares: async () => {},
      connect: () => {},
      connected: async () => {},
      restoreFiles,
      restoreFolders: async () => { started.push('folder') },
    })

    await flushMicrotasks()
    expect(started).toEqual(['slow.md', 'fast.md'])
    slowFile.resolve()
    await done
    expect(started).toEqual(['slow.md', 'fast.md', 'folder'])
  })

  test('does not make synchronization wait for deferred explorer painting', async () => {
    const indicators = deferred()
    const connect = jest.fn()
    const restoreFolders = jest.fn().mockResolvedValue(undefined)
    await runStartupSync({
      showPendingShares: () => indicators.promise,
      connect,
      connected: async () => {},
      restoreFiles: async () => {},
      restoreFolders,
    })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(restoreFolders).toHaveBeenCalledTimes(1)
    indicators.resolve()
  })

  test.each(['throw', 'reject'])('continues syncing if indicator painting fails (%s)', async failureMode => {
    const error = new Error('Explorer was replaced')
    const report = jest.spyOn(console, 'error').mockImplementation(() => {})
    const restoreFolders = jest.fn().mockResolvedValue(undefined)
    try {
      await runStartupSync({
        showPendingShares: () => {
          if (failureMode === 'throw') throw error
          return Promise.reject(error)
        },
        connect: () => {},
        connected: async () => {},
        restoreFiles: async () => {},
        restoreFolders,
      })
      expect(restoreFolders).toHaveBeenCalledTimes(1)
      expect(report).toHaveBeenCalledWith('[Peerdraft] Could not display startup sync status', error)
    } finally {
      report.mockRestore()
    }
  })

  test('does not paint or connect when already unloaded', async () => {
    const connect = jest.fn()
    const showPendingShares = jest.fn()
    await runStartupSync({
      showPendingShares,
      connect,
      connected: async () => {},
      restoreFiles: async () => {},
      restoreFolders: async () => {},
      isStopped: () => true,
    })
    expect(connect).not.toHaveBeenCalled()
    expect(showPendingShares).not.toHaveBeenCalled()
  })

  test('does not restore shares when unloaded during the connection wait', async () => {
    const connection = deferred()
    let stopped = false
    const restoreFiles = jest.fn()
    const restoreFolders = jest.fn()
    const done = runStartupSync({
      showPendingShares: async () => {},
      connect: () => {},
      connected: () => connection.promise,
      restoreFiles,
      restoreFolders,
      isStopped: () => stopped,
    })
    await flushMicrotasks()
    stopped = true
    connection.resolve()
    await done
    expect(restoreFiles).not.toHaveBeenCalled()
    expect(restoreFolders).not.toHaveBeenCalled()
  })

  test('does not start folders when unloaded while restoring files', async () => {
    const files = deferred()
    let stopped = false
    const restoreFolders = jest.fn()
    const done = runStartupSync({
      showPendingShares: async () => {},
      connect: () => {},
      connected: async () => {},
      restoreFiles: () => files.promise,
      restoreFolders,
      isStopped: () => stopped,
    })
    await flushMicrotasks()
    stopped = true
    files.resolve()
    await done
    expect(restoreFolders).not.toHaveBeenCalled()
  })
})

describe('restoreSharesInParallel', () => {
  test('a slow folder does not prevent later folders from starting or completing', async () => {
    const slow = deferred()
    const completed: string[] = []
    const done = restoreSharesInParallel(new Set(['slow', 'fast']), async path => {
      if (path === 'slow') await slow.promise
      completed.push(path)
    }, jest.fn())
    await flushMicrotasks()
    expect(completed).toEqual(['fast'])
    slow.resolve()
    await done
    expect(completed).toEqual(['fast', 'slow'])
  })

  test('reports individual failures and still waits for healthy shares', async () => {
    const healthy = deferred()
    const error = new Error('Cannot read cache')
    const reportError = jest.fn()
    let healthyCompleted = false
    let completed = false
    const done = restoreSharesInParallel(['broken', 'healthy'], async path => {
      if (path === 'broken') throw error
      await healthy.promise
      healthyCompleted = true
    }, reportError).then(() => { completed = true })
    await flushMicrotasks()
    expect(reportError).toHaveBeenCalledWith('broken', error)
    expect(completed).toBe(false)
    healthy.resolve()
    await done
    expect(healthyCompleted).toBe(true)
  })
})
