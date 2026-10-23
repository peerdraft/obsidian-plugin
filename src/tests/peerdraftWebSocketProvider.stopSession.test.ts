/**
 * Reproduces the "delete hangs forever" bug: stopSession() used to resolve
 * only on a matching stop-session-confirmed and had no failure answer, no
 * timeout and no retry — a STOP_SESSION dropped before auth or answered with
 * the new STOP_SESSION_FAILED left the caller pending forever. These tests
 * drive real wire messages through a fake socket: confirmed resolves, failed
 * rejects with its reason (deterministic reasons immediately, 'unauthenticated'
 * via the retry path), and a silent server is retried once on the next
 * 'authenticated' inside a bounded ~40 s window.
 */

import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { PeerdraftWebsocketProvider } from '../peerdraftWebSocketProvider'

const MESSAGE_MULTIPLEX_SYNC = 4
const STOP_SESSION = 10
const STOP_SESSION_CONFIRMED = 11
const STOP_SESSION_FAILED = 13
const MESSAGE_AUTHENTICATION_RESPONSE = 6

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeWebSocket.OPEN
  binaryType = ''
  onopen: (() => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  sent: Uint8Array[] = []

  send(buf: Uint8Array): void {
    this.sent.push(buf)
  }

  close(): void {
    this.onclose?.({})
  }
}

const multiplexed = (subtype: number, fields: string[]): ArrayBuffer => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
  encoding.writeVarUint(encoder, subtype)
  for (const field of fields) encoding.writeVarString(encoder, field)
  return encoding.toUint8Array(encoder).buffer as ArrayBuffer
}

const authResponse = (): ArrayBuffer => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AUTHENTICATION_RESPONSE)
  encoding.writeVarString(encoder, JSON.stringify({ plan: { type: 'Free' } }))
  return encoding.toUint8Array(encoder).buffer as ArrayBuffer
}

const sentStopSessionIds = (fakeWs: FakeWebSocket): string[] =>
  fakeWs.sent
    .map((buf) => {
      const d = decoding.createDecoder(buf)
      const outer = decoding.readVarUint(d)
      const subtype = decoding.readVarUint(d)
      return outer === MESSAGE_MULTIPLEX_SYNC && subtype === STOP_SESSION
        ? decoding.readVarString(d)
        : null
    })
    .filter((id): id is string => id !== null)

describe('PeerdraftWebsocketProvider stopSession', () => {
  const originalWebSocket = global.WebSocket
  let provider: PeerdraftWebsocketProvider
  let fakeWs: FakeWebSocket

  beforeEach(async () => {
    jest.useFakeTimers()
    ;(global as any).WebSocket = FakeWebSocket
    provider = new PeerdraftWebsocketProvider('ws://test', { connect: false })
    provider.connect()
    fakeWs = provider.ws as unknown as FakeWebSocket
    await fakeWs.onopen?.()
    provider.authenticated = true
  })

  afterEach(() => {
    provider.destroy()
    ;(global as any).WebSocket = originalWebSocket
    jest.useRealTimers()
  })

  const receive = (data: ArrayBuffer) => fakeWs.onmessage?.({ data })

  test('resolves when the server confirms the stop', async () => {
    const pending = provider.stopSession('share-1')
    expect(sentStopSessionIds(fakeWs)).toEqual(['share-1'])

    receive(multiplexed(STOP_SESSION_CONFIRMED, ['share-1']))

    await expect(pending).resolves.toBe('share-1')
  })

  test('resolves on not_found — the stop is already achieved server-side', async () => {
    const pending = provider.stopSession('share-1')
    const assertion = expect(pending).resolves.toBe('share-1')

    receive(multiplexed(STOP_SESSION_FAILED, ['share-1', 'not_found']))

    await assertion
    expect(sentStopSessionIds(fakeWs)).toEqual(['share-1'])
  })

  test('rejects on not_permitted without waiting for the timeout', async () => {
    const pending = provider.stopSession('share-1')
    const assertion = expect(pending).rejects.toThrow('not_permitted')

    receive(multiplexed(STOP_SESSION_FAILED, ['share-1', 'not_permitted']))

    await assertion
  })

  test('rejects on internal as a terminal failure without retrying', async () => {
    const pending = provider.stopSession('share-1')
    const assertion = expect(pending).rejects.toThrow('internal')

    receive(multiplexed(STOP_SESSION_FAILED, ['share-1', 'internal']))

    await assertion
    expect(sentStopSessionIds(fakeWs)).toEqual(['share-1'])
  })

  test('rejections carry their reason so callers can tell deterministic from transient', async () => {
    const pending = provider.stopSession('share-1')
    receive(multiplexed(STOP_SESSION_FAILED, ['share-1', 'not_permitted']))

    await expect(pending).rejects.toMatchObject({
      name: 'StopSessionError',
      reason: 'not_permitted'
    })
  })

  test('retries on the next authenticated event when the server answers unauthenticated', async () => {
    provider.authenticated = false
    const pending = provider.stopSession('share-1')
    const assertion = expect(pending).resolves.toBe('share-1')

    receive(multiplexed(STOP_SESSION_FAILED, ['share-1', 'unauthenticated']))
    expect(sentStopSessionIds(fakeWs)).toEqual(['share-1'])

    receive(authResponse())
    expect(sentStopSessionIds(fakeWs)).toEqual(['share-1', 'share-1'])

    receive(multiplexed(STOP_SESSION_CONFIRMED, ['share-1']))
    await assertion
  })

  test('retries once after a 20 s silence and resolves on the retried confirm', async () => {
    provider.authenticated = false
    const pending = provider.stopSession('share-1')
    const assertion = expect(pending).resolves.toBe('share-1')

    await jest.advanceTimersByTimeAsync(20_000)
    expect(sentStopSessionIds(fakeWs)).toEqual(['share-1'])

    receive(authResponse())
    expect(sentStopSessionIds(fakeWs)).toEqual(['share-1', 'share-1'])

    receive(multiplexed(STOP_SESSION_CONFIRMED, ['share-1']))
    await assertion
  })

  test('rejects when neither the retry window nor the server produces an answer', async () => {
    provider.authenticated = false
    const pending = provider.stopSession('share-1')
    const assertion = expect(pending).rejects.toThrow()

    await jest.advanceTimersByTimeAsync(40_000)

    await assertion
  })

  test('rejects when the retry is also answered unauthenticated', async () => {
    provider.authenticated = false
    const pending = provider.stopSession('share-1')
    const assertion = expect(pending).rejects.toThrow('unauthenticated')

    receive(multiplexed(STOP_SESSION_FAILED, ['share-1', 'unauthenticated']))
    receive(authResponse())
    receive(multiplexed(STOP_SESSION_FAILED, ['share-1', 'unauthenticated']))

    await assertion
  })

  test('ignores answers for other share ids', async () => {
    const pending = provider.stopSession('share-1')
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true }
    )

    receive(multiplexed(STOP_SESSION_CONFIRMED, ['other-share']))
    receive(multiplexed(STOP_SESSION_FAILED, ['other-share', 'not_found']))
    await jest.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    receive(multiplexed(STOP_SESSION_CONFIRMED, ['share-1']))
    await expect(pending).resolves.toBe('share-1')
  })

  test('removes its listeners and timer once settled', async () => {
    const offSpy = jest.spyOn(provider, 'off')
    const pending = provider.stopSession('share-1')

    receive(multiplexed(STOP_SESSION_CONFIRMED, ['share-1']))
    await expect(pending).resolves.toBe('share-1')

    expect(offSpy).toHaveBeenCalledWith('stop-session-confirmed', expect.any(Function))
    expect(offSpy).toHaveBeenCalledWith('stop-session-failed', expect.any(Function))
    expect(offSpy).toHaveBeenCalledWith('authenticated', expect.any(Function))
  })
})
