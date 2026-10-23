/**
 * peerdraftPlugin.ts used to call `this.serverSync.connected()` without
 * awaiting it, so restored folders/docs began syncing before the websocket
 * had actually opened — every sendSyncStep1/sendNewDocument in that window
 * gets silently dropped by sendMessage()'s wsconnected gate. This tests the
 * extracted sequencing in isolation: restoring files/folders must not start
 * until the connection promise resolves.
 */

import { runStartupSync } from '../startupSync'

describe('runStartupSync', () => {
  test('does not restore files/folders until connected() resolves', async () => {
    let resolveConnected: () => void = () => {}
    const connected = jest.fn(() => new Promise<void>(resolve => {
      resolveConnected = resolve
    }))
    const connect = jest.fn()
    const restoreFiles = jest.fn().mockResolvedValue(undefined)
    const restoreFolders = jest.fn().mockResolvedValue(undefined)

    const done = runStartupSync({ connect, connected, restoreFiles, restoreFolders })

    // Let any already-queued microtasks run without resolving the connection.
    await Promise.resolve()
    await Promise.resolve()

    expect(restoreFiles).not.toHaveBeenCalled()
    expect(restoreFolders).not.toHaveBeenCalled()

    resolveConnected()
    await done

    expect(restoreFiles).toHaveBeenCalled()
    expect(restoreFolders).toHaveBeenCalled()
  })

  test('calls connect() before waiting on connected()', async () => {
    const order: string[] = []
    const connect = jest.fn(() => order.push('connect'))
    const connected = jest.fn(() => {
      order.push('connected')
      return Promise.resolve()
    })
    const restoreFiles = jest.fn(async () => { order.push('restoreFiles') })
    const restoreFolders = jest.fn(async () => { order.push('restoreFolders') })

    await runStartupSync({ connect, connected, restoreFiles, restoreFolders })

    expect(order).toEqual(['connect', 'connected', 'restoreFiles', 'restoreFolders'])
  })
})
