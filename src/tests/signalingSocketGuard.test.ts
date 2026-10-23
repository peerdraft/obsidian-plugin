import { SignalingConn } from 'y-webrtc'

import { installSignalingSocketGuard } from '../signalingSocketGuard'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState: number = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send = jest.fn((data: string): void => {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`Cannot send on socket in state ${this.readyState}: ${data}`)
    }
  })

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  close(): void {
    // Keep the close event pending to reproduce the heartbeat race.
    this.readyState = FakeWebSocket.CLOSING
  }

  finishClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

describe('signaling socket guard with the real y-webrtc heartbeat', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalSend = SignalingConn.prototype.send
  const originalDestroy = SignalingConn.prototype.destroy
  let connection: SignalingConn
  let socket: FakeWebSocket
  let uninstall: () => void

  beforeEach(() => {
    jest.useFakeTimers()
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    uninstall = installSignalingSocketGuard()
    connection = new SignalingConn('wss://example.test/signal')
    socket = FakeWebSocket.instances[0]
  })

  afterEach(() => {
    connection.destroy()
    uninstall()
    jest.clearAllTimers()
    jest.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  test.each([FakeWebSocket.CLOSING, FakeWebSocket.CLOSED])(
    'does not send a scheduled ping in socket state %i before the close event arrives', state => {
      socket.open()
      socket.send.mockClear()
      socket.readyState = state

      expect(() => jest.advanceTimersByTime(15000)).not.toThrow()

      expect(socket.send).not.toHaveBeenCalled()
    },
  )

  test('does not send a pending ping after disconnect', () => {
    socket.open()
    socket.send.mockClear()

    connection.disconnect()
    jest.advanceTimersByTime(15000)

    expect(socket.send).not.toHaveBeenCalled()
  })

  test('does not send a pending ping after destruction and guard removal on unload', () => {
    socket.open()
    socket.send.mockClear()

    connection.destroy()
    uninstall()

    expect(() => jest.advanceTimersByTime(15000)).not.toThrow()
    expect(socket.send).not.toHaveBeenCalled()
  })

  test('skips signaling messages while connecting or without a socket', () => {
    connection.send({ type: 'ping' })
    socket.finishClose()
    connection.send({ type: 'ping' })

    expect(socket.send).not.toHaveBeenCalled()
  })

  test('preserves open-socket subscriptions, messages, and recurring ping/pong', () => {
    socket.open()
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', topics: [] }))

    const message = { type: 'publish', topic: 'shared-note', data: 'signal' }
    connection.send(message)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify(message))
    socket.send.mockClear()

    jest.advanceTimersByTime(15000)
    socket.onmessage?.({ data: JSON.stringify({ type: 'pong' }) })
    jest.advanceTimersByTime(15000)

    expect(socket.send.mock.calls).toEqual([
      [JSON.stringify({ type: 'ping' })],
      [JSON.stringify({ type: 'ping' })],
    ])
  })

  test('resumes subscriptions and heartbeats after reconnecting', () => {
    socket.open()
    socket.finishClose()
    jest.advanceTimersByTime(0)
    const replacement = FakeWebSocket.instances[1]

    replacement.open()
    expect(replacement.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', topics: [] }))
    replacement.send.mockClear()
    jest.advanceTimersByTime(15000)

    expect(replacement.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }))
  })

  test('restores the original signaling send method when uninstalled', () => {
    uninstall()

    expect(SignalingConn.prototype.send).toBe(originalSend)
    expect(SignalingConn.prototype.destroy).toBe(originalDestroy)
  })
})
