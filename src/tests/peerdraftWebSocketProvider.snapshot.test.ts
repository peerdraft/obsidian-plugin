import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import {
  GET_DOCUMENT_AS_UPDATE, MESSAGE_MULTIPLEX_SYNC, PeerdraftWebsocketProvider,
  SEND_DOCUMENT_AS_UPDATE, UPDATE,
} from '../peerdraftWebSocketProvider'
import { calculateHash, serialize } from '../tools'

class SnapshotSocket {
  static readonly OPEN = 1
  readyState = SnapshotSocket.OPEN
  binaryType = ''
  sent: Uint8Array[] = []
  onopen: (() => Promise<void>) | null = null
  onclose: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(data: Uint8Array): void { this.sent.push(data) }
  close(): void { this.onclose?.({}) }
}

function snapshotFrame(id: string, update: Uint8Array, checksum: string, proof?: string): ArrayBuffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
  encoding.writeVarUint(encoder, SEND_DOCUMENT_AS_UPDATE)
  encoding.writeVarString(encoder, id)
  encoding.writeVarUint8Array(encoder, update)
  encoding.writeVarString(encoder, checksum)
  if (proof !== undefined) encoding.writeVarString(encoder, proof)
  return Uint8Array.from(encoding.toUint8Array(encoder)).buffer
}

function sentTypes(socket: SnapshotSocket): number[] {
  return socket.sent.map(frame => {
    const decoder = decoding.createDecoder(frame)
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_MULTIPLEX_SYNC)
    return decoding.readVarUint(decoder)
  })
}

describe('complete document snapshots', () => {
  const originalWebSocket = global.WebSocket
  let provider: PeerdraftWebsocketProvider
  let socket: SnapshotSocket
  beforeEach(async () => {
    jest.useFakeTimers()
    global.WebSocket = SnapshotSocket as unknown as typeof WebSocket
    provider = new PeerdraftWebsocketProvider('ws://snapshot-test', { connect: false })
    provider.connect()
    socket = provider.ws as unknown as SnapshotSocket
    await socket.onopen?.()
  })
  afterEach(() => {
    provider.destroy()
    global.WebSocket = originalWebSocket
    jest.useRealTimers()
  })

  test.each(['empty', 'metadata'])('returns complete %s state, checksum and optional proof in one download', async kind => {
    const source = new Y.Doc()
    if (kind === 'metadata') source.getMap('metadata').set('title', 'Metadata survives')
    const pending = provider.requestDocumentSnapshot('doc')
    const proof = { checkpoint: 'current-checkpoint', stateHash: 'a'.repeat(64) }
    const legacyHandler = jest.fn((_id: string, _update: Uint8Array, _checksum: string) => undefined)
    provider.on('document-received', legacyHandler)
    socket.onmessage?.({ data: snapshotFrame('doc', Y.encodeStateAsUpdate(source), 'checksum', JSON.stringify(proof)) })
    const snapshot = await pending
    expect(snapshot.doc.getText('content').toString()).toBe('')
    expect(snapshot.doc.getMap('metadata').get('title')).toBe(kind === 'metadata' ? 'Metadata survives' : undefined)
    expect(snapshot.checksum).toBe('checksum')
    expect(snapshot.proof).toEqual(proof)
    expect(snapshot.isCurrent()).toBe(true)
    expect(legacyHandler).toHaveBeenCalledTimes(1)
    expect(sentTypes(socket)).toEqual([GET_DOCUMENT_AS_UPDATE])
    expect(provider._observers.get('document-received')?.size).toBe(1)
    provider.off('document-received', legacyHandler)
    provider.disconnect()
    expect(snapshot.isCurrent()).toBe(false)
    snapshot.doc.destroy()
    source.destroy()
  })

  test.each([undefined, '{bad json', JSON.stringify({ checkpoint: 'valid', stateHash: 'bad' })])('ignores absent/invalid optional proof %s', async proof => {
    const source = new Y.Doc()
    const pending = provider.requestDocumentSnapshot('doc')
    socket.onmessage?.({ data: snapshotFrame('doc', Y.encodeStateAsUpdate(source), 'checksum', proof) })
    const snapshot = await pending
    expect(snapshot.proof).toBeUndefined()
    snapshot.doc.destroy()
    source.destroy()
  })

  test.each(['disconnect', 'destroy', 'timeout', 'invalid-update'])('rejects %s and removes request listeners', async cause => {
    const pending = provider.requestDocumentSnapshot('doc', 10)
    const rejected = expect(pending).rejects.toBeInstanceOf(Error)
    if (cause === 'disconnect') socket.close()
    else if (cause === 'destroy') provider.destroy()
    else if (cause === 'invalid-update') socket.onmessage?.({ data: snapshotFrame('doc', new Uint8Array([255]), 'checksum') })
    else await jest.advanceTimersByTimeAsync(10)
    await rejected
    expect(provider._observers.get('document-received')?.size ?? 0).toBe(0)
    expect(provider._observers.get('connected')?.size ?? 0).toBe(0)
  })

  test('a request waiting for connection has a bounded timeout and cannot send later', async () => {
    provider.disconnect()
    const pending = provider.requestDocumentSnapshot('doc', 10)
    const rejected = expect(pending).rejects.toBeInstanceOf(Error)
    await jest.advanceTimersByTimeAsync(10)
    await rejected
    provider.connect()
    socket = provider.ws as unknown as SnapshotSocket
    await socket.onopen?.()
    expect(socket.sent).toHaveLength(0)
  })

  test('a lost connection invalidates a resolved snapshot and old socket frames cannot finish a new request', async () => {
    const source = new Y.Doc()
    const oldSocket = socket
    const first = provider.requestDocumentSnapshot('doc')
    oldSocket.onmessage?.({ data: snapshotFrame('doc', Y.encodeStateAsUpdate(source), 'old') })
    const snapshot = await first
    oldSocket.close()
    provider.connect()
    socket = provider.ws as unknown as SnapshotSocket
    await socket.onopen?.()
    const pending = provider.requestDocumentSnapshot('doc')
    oldSocket.onmessage?.({ data: snapshotFrame('doc', Y.encodeStateAsUpdate(source), 'stale') })
    expect(provider._observers.get('document-received')?.size).toBe(1)
    socket.onmessage?.({ data: snapshotFrame('doc', Y.encodeStateAsUpdate(source), 'new') })
    const fresh = await pending
    expect(snapshot.isCurrent()).toBe(false)
    expect(fresh.checksum).toBe('new')
    fresh.doc.destroy()
    snapshot.doc.destroy()
    source.destroy()
  })

  test('legacy requestDocument retains folder checksum repair', async () => {
    const source = new Y.Doc()
    source.getMap('documents').set('a', 'document-id')
    const pending = provider.requestDocument('folder')
    socket.onmessage?.({ data: snapshotFrame('folder', Y.encodeStateAsUpdate(source), 'wrong') })
    const document = await pending
    expect(sentTypes(socket)).toEqual([GET_DOCUMENT_AS_UPDATE, UPDATE])
    const decoder = decoding.createDecoder(socket.sent[1])
    decoding.readVarUint(decoder)
    decoding.readVarUint(decoder)
    expect(decoding.readVarString(decoder)).toBe('folder')
    decoding.readVarUint8Array(decoder)
    expect(decoding.readVarString(decoder)).toBe(calculateHash(serialize(Array.from(document.getMap('documents')))))
    document.destroy()
    source.destroy()
  })
})
