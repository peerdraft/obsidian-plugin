/**
 * Reproduces the "file never appears on the web, even after days" bug:
 * sendMessage() used to silently drop any outgoing buffer (including a
 * NEW_DOCUMENT registration) whenever the socket wasn't connected at that
 * exact instant, with nothing to retry it later. These tests pin down that
 * messages sent while disconnected are queued, and flushed once the
 * connection (re)opens, instead of being lost.
 */

import { PeerdraftWebsocketProvider } from '../peerdraftWebSocketProvider'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeWebSocket.OPEN
  binaryType = ''
  onopen: (() => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  sent: Uint8Array[] = []

  send(buf: Uint8Array): void {
    this.sent.push(buf)
  }

  close(): void {
    this.onclose?.({})
  }
}

describe('PeerdraftWebsocketProvider message queueing', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    ;(global as any).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    ;(global as any).WebSocket = originalWebSocket
  })

  test('queues a message instead of dropping it when not connected', () => {
    const provider = new PeerdraftWebsocketProvider('ws://test', { connect: false })

    provider.sendMessage(new Uint8Array([1, 2, 3]))

    expect(provider.pendingMessageCount).toBe(1)

    provider.destroy()
  })

  test('sends immediately when already connected', () => {
    const provider = new PeerdraftWebsocketProvider('ws://test', { connect: false })
    const fakeWs = new FakeWebSocket()
    provider.ws = fakeWs as unknown as WebSocket
    provider.wsconnected = true

    const buf = new Uint8Array([4, 5, 6])
    provider.sendMessage(buf)

    expect(fakeWs.sent).toEqual([buf])
    expect(provider.pendingMessageCount).toBe(0)

    provider.destroy()
  })

  test('flushes queued messages once the connection opens', async () => {
    const provider = new PeerdraftWebsocketProvider('ws://test', { connect: false })
    const buf = new Uint8Array([9, 9, 9])

    provider.sendMessage(buf)
    expect(provider.pendingMessageCount).toBe(1)

    provider.connect()
    const fakeWs = provider.ws as unknown as FakeWebSocket
    await fakeWs.onopen?.()

    expect(fakeWs.sent).toContainEqual(buf)
    expect(provider.pendingMessageCount).toBe(0)

    provider.destroy()
  })
})
