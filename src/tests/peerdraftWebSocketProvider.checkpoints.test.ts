import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { canonicalStateUpdate, sha256 } from '../fastRestart'
import {
  CHECKPOINT_CHANGED, CHECKPOINTS_REQUEST, CHECKPOINTS_RESPONSE,
  MESSAGE_MULTIPLEX_SYNC, PeerdraftWebsocketProvider, SYNC_STEP_1, SYNC_STEP_2,
} from '../peerdraftWebSocketProvider'
import { SyncableDocument } from '../sharedEntities/syncableDocument'

let mockRequestId = 0
jest.mock('../tools', () => ({
  ...jest.requireActual('../tools'), createRandomId: () => 'request-' + (++mockRequestId),
}))

class Socket {
  static readonly OPEN = 1
  readyState = Socket.OPEN
  binaryType = ''
  sent: Uint8Array[] = []
  onopen: (() => Promise<void>) | null = null
  onclose: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(data: Uint8Array): void { this.sent.push(data) }
  close(): void { this.onclose?.({}) }
}

function frame(type: number, write: (encoder: encoding.Encoder) => void): ArrayBuffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
  encoding.writeVarUint(encoder, type)
  write(encoder)
  return Uint8Array.from(encoding.toUint8Array(encoder)).buffer
}

function request(socket: Socket): { id: string; ids: string[] } {
  const decoder = decoding.createDecoder(socket.sent[socket.sent.length - 1])
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_MULTIPLEX_SYNC)
  expect(decoding.readVarUint(decoder)).toBe(CHECKPOINTS_REQUEST)
  return { id: decoding.readVarString(decoder), ids: JSON.parse(decoding.readVarString(decoder)) }
}

describe('checkpoint wire protocol', () => {
  const originalWebSocket = global.WebSocket
  let provider: PeerdraftWebsocketProvider
  let socket: Socket
  let entities: SyncableDocument[]
  beforeEach(async () => {
    global.WebSocket = Socket as unknown as typeof WebSocket
    entities = []
    provider = new PeerdraftWebsocketProvider('ws://checkpoint-test', { connect: false })
    provider.connect()
    socket = provider.ws as unknown as Socket
    await socket.onopen?.()
  })
  afterEach(() => {
    for (const entity of entities) { entity.destroy(); entity.yDoc.destroy() }
    provider.destroy()
    global.WebSocket = originalWebSocket
  })

  test('correlates a bounded manifest and ignores unrequested response IDs', async () => {
    const pending = provider.requestCheckpoints(['doc', 'doc'])
    const sent = request(socket)
    expect(sent.ids).toEqual(['doc'])
    socket.onmessage?.({ data: frame(CHECKPOINTS_RESPONSE, encoder => {
      encoding.writeVarString(encoder, sent.id)
      encoding.writeVarString(encoder, JSON.stringify({ supported: true, checkpoints: { doc: 'token', extra: 'ignored' } }))
    }) })
    await expect(pending).resolves.toEqual({ supported: true, checkpoints: { doc: 'token' } })
  })

  test.each(['malformed', 'disconnect', 'timeout'])('rejects %s verification so callers can fall back', async kind => {
    const pending = provider.requestCheckpoints(['doc'], 5)
    const expected = expect(pending).rejects.toBeInstanceOf(Error)
    if (kind === 'malformed') {
      const sent = request(socket)
      provider.receiveCheckpointManifest(sent.id, JSON.stringify({ supported: true, checkpoints: { doc: 42 } }))
    } else if (kind === 'disconnect') socket.close()
    await expected
  })

  test('forwards invalidations only for IDs subscribed by this socket', async () => {
    const changed = jest.fn()
    provider.on('checkpoint-changed', changed)
    const pending = provider.requestCheckpoints(['doc'])
    const sent = request(socket)
    provider.receiveCheckpointManifest(sent.id, JSON.stringify({ supported: true, checkpoints: { doc: 'token' } }))
    await pending
    for (const [id, checkpoint] of [['unrequested', 'token'], ['doc', '']]) {
      socket.onmessage?.({ data: frame(CHECKPOINT_CHANGED, encoder => {
        encoding.writeVarString(encoder, id)
        encoding.writeVarString(encoder, checkpoint)
      }) })
    }
    expect(changed.mock.calls).toEqual([['doc', null]])
  })

  test('unsupported manifests retain ordinary equal-content sync behavior without empty updates', async () => {
    const entity = new SyncableDocument({ yDoc: new Y.Doc(), shareId: 'doc', isPermanent: true, serverSync: provider })
    entities.push(entity)
    const pending = provider.requestCheckpoints(['doc'])
    provider.receiveCheckpointManifest(request(socket).id, JSON.stringify({ supported: false, checkpoints: {} }))
    await pending
    const before = socket.sent.length
    await provider.handleSyncStep1(entity, Y.encodeStateVector(entity.yDoc), entity.calculateHash())
    expect(socket.sent).toHaveLength(before)
  })

  test('matching complete-state proof suppresses an unnecessary empty update', async () => {
    const entity = new SyncableDocument({ yDoc: new Y.Doc(), shareId: 'doc', isPermanent: true, serverSync: provider })
    entities.push(entity)
    const pending = provider.requestCheckpoints(['doc'])
    provider.receiveCheckpointManifest(request(socket).id, JSON.stringify({ supported: true, checkpoints: { doc: 'token' } }))
    await pending
    provider.receiveSyncProof('doc', { checkpoint: 'token', stateHash: await sha256(Y.encodeStateAsUpdate(entity.yDoc)) })
    const before = socket.sent.length
    await provider.handleSyncStep1(entity, Y.encodeStateVector(entity.yDoc), entity.calculateHash())
    expect(socket.sent).toHaveLength(before)
  })

  test('ordinary sync repairs cached causal state even when the content checksum matches', async () => {
    const server = new Y.Doc()
    server.getText('content').insert(0, 'Unchanged text')
    const local = new Y.Doc()
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server))
    local.getArray('fileExtensions').push(['md', 'png'])
    const entity = new SyncableDocument({ yDoc: local, shareId: 'doc', isPermanent: true, serverSync: provider })
    entities.push(entity)

    try {
      const before = socket.sent.length
      await provider.handleSyncStep1(entity, Y.encodeStateVector(server), entity.calculateHash())
      expect(socket.sent).toHaveLength(before + 1)
      const decoder = decoding.createDecoder(socket.sent[before])
      expect(decoding.readVarUint(decoder)).toBe(MESSAGE_MULTIPLEX_SYNC)
      expect(decoding.readVarUint(decoder)).toBe(SYNC_STEP_2)
      expect(decoding.readVarString(decoder)).toBe('doc')
      Y.applyUpdate(server, decoding.readVarUint8Array(decoder))

      // Later deltas depend on the earlier metadata clocks, even though that
      // metadata did not affect the content checksum used by the handshake.
      const vector = Y.encodeStateVector(server)
      local.getMap('documents').set('new', 'New.md')
      Y.applyUpdate(server, Y.encodeStateAsUpdate(local, vector))
      expect(server.getArray('fileExtensions').toArray()).toEqual(['md', 'png'])
      expect(server.getMap('documents').get('new')).toBe('New.md')
    } finally { server.destroy() }
  })

  test('ordinary sync still replies with an empty update to repair a stale remote checksum', async () => {
    const entity = new SyncableDocument({ yDoc: new Y.Doc(), shareId: 'doc', isPermanent: true, serverSync: provider })
    entities.push(entity)
    const before = socket.sent.length
    await provider.handleSyncStep1(entity, Y.encodeStateVector(entity.yDoc), 'stale-checksum')
    expect(socket.sent).toHaveLength(before + 1)
    const decoder = decoding.createDecoder(socket.sent[before])
    decoding.readVarUint(decoder)
    decoding.readVarUint(decoder)
    decoding.readVarString(decoder)
    expect(Array.from(decoding.readVarUint8Array(decoder))).toEqual([0, 0])
    expect(decoding.readVarString(decoder)).toBe(entity.calculateHash())
  })

  test('proof-capable sync transmits metadata changes even when visible text hashes match', async () => {
    const serverDoc = new Y.Doc()
    serverDoc.getText('content').insert(0, 'Unchanged text')
    const localDoc = new Y.Doc()
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(serverDoc))
    localDoc.getMap('metadata').set('local-only', 'must reach server')
    const entity = new SyncableDocument({ yDoc: localDoc, shareId: 'doc', isPermanent: true, serverSync: provider })
    entities.push(entity)
    const pending = provider.requestCheckpoints(['doc'])
    provider.receiveCheckpointManifest(request(socket).id, JSON.stringify({ supported: true, checkpoints: { doc: 'token' } }))
    await pending
    const proof = { checkpoint: 'token', stateHash: await sha256(Y.encodeStateAsUpdate(serverDoc)) }
    const received = jest.fn()
    provider.on('sync-proof', received)
    socket.onmessage?.({ data: frame(SYNC_STEP_2, encoder => {
      encoding.writeVarString(encoder, 'doc')
      encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(serverDoc, Y.encodeStateVector(localDoc)))
      encoding.writeVarString(encoder, entity.calculateHash())
      encoding.writeVarString(encoder, JSON.stringify(proof))
    }) })
    expect(received).toHaveBeenCalledWith('doc', proof)
    const before = socket.sent.length
    const originalSend = provider.sendSyncStep2.bind(provider)
    let finish: () => void = () => {}
    const transmitted = new Promise<void>(resolve => { finish = resolve })
    jest.spyOn(provider, 'sendSyncStep2').mockImplementation((document, vector) => {
      originalSend(document, vector)
      finish()
    })
    socket.onmessage?.({ data: frame(SYNC_STEP_1, encoder => {
      encoding.writeVarString(encoder, 'doc')
      encoding.writeVarUint8Array(encoder, Y.encodeStateVector(serverDoc))
      encoding.writeVarString(encoder, entity.calculateHash())
    }) })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([transmitted, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Metadata update was not transmitted')), 2000)
      })])
    } finally { if (deadline !== undefined) clearTimeout(deadline) }
    const updates = socket.sent.slice(before)
    expect(updates).toHaveLength(1)
    const decoder = decoding.createDecoder(updates[0])
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_MULTIPLEX_SYNC)
    expect(decoding.readVarUint(decoder)).toBe(SYNC_STEP_2)
    expect(decoding.readVarString(decoder)).toBe('doc')
    Y.applyUpdate(serverDoc, decoding.readVarUint8Array(decoder))
    expect(serverDoc.getMap('metadata').get('local-only')).toBe('must reach server')
    serverDoc.destroy()
  })

  test('an UndoManager deletion uploads once, then the server proof prevents a self-resync loop', async () => {
    const local = new Y.Doc()
    const content = local.getText('content')
    content.insert(0, 'Content with an obsolete ending')
    const server = new Y.Doc({ gc: true })
    Y.applyUpdate(server, Y.encodeStateAsUpdate(local))
    const undo = new Y.UndoManager(content)
    const entity = new SyncableDocument({ yDoc: local, shareId: 'doc', isPermanent: true, serverSync: provider })
    entities.push(entity)
    try {
      const pending = provider.requestCheckpoints(['doc'])
      provider.receiveCheckpointManifest(request(socket).id, JSON.stringify({ supported: true, checkpoints: { doc: 'before' } }))
      await pending
      provider.receiveSyncProof('doc', { checkpoint: 'before', stateHash: await sha256(Y.encodeStateAsUpdate(server)) })
      content.delete(7, content.length - 7)
      const beforeUpload = socket.sent.length
      await provider.handleSyncStep1(entity, Y.encodeStateVector(server), entity.calculateHash())
      const updates = socket.sent.slice(beforeUpload)
      expect(updates).toHaveLength(1)
      const decoder = decoding.createDecoder(updates[0])
      expect(decoding.readVarUint(decoder)).toBe(MESSAGE_MULTIPLEX_SYNC)
      expect(decoding.readVarUint(decoder)).toBe(SYNC_STEP_2)
      expect(decoding.readVarString(decoder)).toBe('doc')
      Y.applyUpdate(server, decoding.readVarUint8Array(decoder))
      const proof = { checkpoint: 'after', stateHash: await sha256(Y.encodeStateAsUpdate(server)) }
      expect(await sha256(Y.encodeStateAsUpdate(local))).not.toBe(proof.stateHash)
      expect(await sha256(canonicalStateUpdate(local))).toBe(proof.stateHash)
      // A commit notification triggers a fresh handshake with the merged proof.
      provider.receiveCheckpointChange('doc', 'after')
      provider.receiveSyncProof('doc', proof)
      const afterMerge = socket.sent.length
      for (let attempt = 0; attempt < 3; attempt++) {
        await provider.handleSyncStep1(entity, Y.encodeStateVector(server), entity.calculateHash())
      }
      expect(socket.sent).toHaveLength(afterMerge)
      // Canonicalization still detects an actual same-text metadata edit.
      local.getMap('metadata').set('changed', true)
      await provider.handleSyncStep1(entity, Y.encodeStateVector(server), entity.calculateHash())
      expect(socket.sent).toHaveLength(afterMerge + 1)
    } finally { undo.destroy(); server.destroy() }
  })
})
