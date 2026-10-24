import * as Y from 'yjs'
import {
  canonicalStateUpdate, FastRestartManager, sha256, type FastRestartDocument, type RestartRecord, type SyncProof,
} from '../fastRestart'

function fixture(initialRecords: Record<string, RestartRecord> = {}) {
  const yDoc = new Y.Doc()
  yDoc.getText('content').insert(0, 'Saved content')
  let disk = 'Saved content'
  let mtime = 123
  let eligible = true
  let checkpoint: string | null = 'server-checkpoint'
  let saved: Record<string, RestartRecord> = {}
  const read = jest.fn(async () => disk)
  const document: FastRestartDocument = {
    shareId: 'document', persistenceId: 'cache', yDoc,
    readFile: read, getMTime: () => mtime,
    content: () => yDoc.getText('content').toString(),
    isEligible: () => eligible, checksum: () => 'existing-checksum',
  }
  const requestCheckpoints = jest.fn(async (ids: string[]) => ({
    supported: true,
    checkpoints: Object.fromEntries(ids.map(id => [id, checkpoint])),
  }))
  const persist = jest.fn(async (records: Record<string, RestartRecord>) => { saved = JSON.parse(JSON.stringify(records)) })
  const requestResync = jest.fn()
  const manager = new FastRestartManager({
    scope: 'local-server:vault-identity', records: initialRecords,
    transport: { requestCheckpoints }, getDocument: id => id === 'document' ? document : undefined,
    persist, requestResync,
  })
  return {
    manager, document, yDoc, read, requestCheckpoints, persist, requestResync,
    saved: () => saved,
    disk: (value: string) => { disk = value; mtime++ },
    checkpoint: (value: string | null) => { checkpoint = value },
    eligible: (value: boolean) => { eligible = value },
    destroy: async () => { manager.destroy(); await manager.flushPersistence(); yDoc.destroy() },
  }
}

type Fixture = ReturnType<typeof fixture>
async function establish(f: Fixture): Promise<SyncProof> {
  await f.manager.prepare(['document'])
  const proof = { checkpoint: 'server-checkpoint', stateHash: await sha256(Y.encodeStateAsUpdate(f.yDoc)) }
  await f.manager.captureProof('document', proof)
  await f.manager.flushPersistence()
  return proof
}

describe('verified fast restart', () => {
  test('UndoManager-retained deletion payloads can capture and verify a GC-normalized server proof', async () => {
    const f = fixture()
    const undo = new Y.UndoManager(f.yDoc.getText('content'))
    const server = new Y.Doc({ gc: true })
    try {
      f.yDoc.getText('content').delete(0, 6)
      f.disk(f.document.content())
      Y.applyUpdate(server, Y.encodeStateAsUpdate(f.yDoc))
      expect(await sha256(Y.encodeStateAsUpdate(f.yDoc))).not.toBe(await sha256(Y.encodeStateAsUpdate(server)))
      expect(await sha256(canonicalStateUpdate(f.yDoc))).toBe(await sha256(Y.encodeStateAsUpdate(server)))
      await f.manager.prepare(['document'])
      const proof = { checkpoint: 'server-checkpoint', stateHash: await sha256(Y.encodeStateAsUpdate(server)) }
      await f.manager.captureProof('document', proof)
      await f.manager.flushPersistence()
      expect(f.saved().document.stateHash).toBe(proof.stateHash)
      await expect(f.manager.tryVerify(f.document)).resolves.toBe('existing-checksum')
      // Normalizing for proof must preserve the live editor's undo history.
      undo.undo()
      expect(f.document.content()).toBe('Saved content')
    } finally { undo.destroy(); server.destroy(); await f.destroy() }
  })

  test('a proven unchanged cache and file skip the document handshake after restart', async () => {
    const f = fixture()
    await establish(f)
    const records = f.saved()
    f.manager.destroy()
    const restored = fixture(records)
    // Replayed IndexedDB state preserves original CRDT IDs; matching text from
    // an independently created Y.Doc would intentionally not prove equality.
    restored.yDoc.getText('content').delete(0, restored.yDoc.getText('content').length)
    const cache = new Y.Doc()
    Y.applyUpdate(cache, Y.encodeStateAsUpdate(f.yDoc))
    const doc = { ...restored.document, yDoc: cache, content: () => cache.getText('content').toString() }
    restored.manager.destroy()
    const manager = new FastRestartManager({
      scope: 'local-server:vault-identity', records,
      transport: { requestCheckpoints: restored.requestCheckpoints }, getDocument: () => doc,
      persist: restored.persist, requestResync: restored.requestResync,
    })
    try {
      await manager.prepare(['document'])
      await expect(manager.tryVerify(doc)).resolves.toBe('existing-checksum')
      expect(restored.requestCheckpoints).toHaveBeenCalledTimes(1)
      expect(restored.requestResync).not.toHaveBeenCalled()
    } finally { manager.destroy(); cache.destroy(); await f.destroy(); await restored.destroy() }
  })

  test.each(['request failure', 'unsupported response'])('recovers missed remote content after a periodic %s', async failure => {
    const f = fixture()
    try {
      await establish(f)
      f.requestResync.mockImplementation(() => {
        const content = f.yDoc.getText('content')
        content.delete(0, content.length)
        content.insert(0, 'Remote content after the outage')
        f.disk('Remote content after the outage')
      })
      if (failure === 'request failure') f.requestCheckpoints.mockRejectedValueOnce(new Error('Temporary outage'))
      else f.requestCheckpoints.mockResolvedValueOnce({ supported: false, checkpoints: {} })
      await f.manager.prepare(['document'])
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
      f.checkpoint('new-server-checkpoint')
      await f.manager.prepare(['document'])
      await f.manager.prepare(['document'])

      expect(f.document.content()).toBe('Remote content after the outage')
      await expect(f.document.readFile()).resolves.toBe('Remote content after the outage')
      expect(f.requestResync).toHaveBeenCalledTimes(1)
    } finally { await f.destroy() }
  })

  test('a successful poll after an initial failure rechecks an already-restored document with no history', async () => {
    const f = fixture()
    try {
      f.requestCheckpoints.mockRejectedValueOnce(new Error('Temporary outage'))
      await f.manager.prepare(['document'])
      await f.manager.prepare(['document'])
      await f.manager.prepare(['document'])
      expect(f.requestResync).toHaveBeenCalledTimes(1)
    } finally { await f.destroy() }
  })

  test('same text with unsent metadata/history changes cannot fast-verify', async () => {
    const f = fixture()
    try {
      await establish(f)
      f.yDoc.getMap('metadata').set('owner', 'new owner')
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
      expect(f.document.content()).toBe('Saved content')
    } finally { await f.destroy() }
  })

  test('offline file edits force normal synchronization without changing the file', async () => {
    const f = fixture()
    try {
      await establish(f)
      f.disk('Offline local edits')
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
      expect(await f.read()).toBe('Offline local edits')
    } finally { await f.destroy() }
  })

  test('a proof for an older server state never certifies unacknowledged local updates', async () => {
    const f = fixture()
    try {
      await f.manager.prepare(['document'])
      const proof = { checkpoint: 'server-checkpoint', stateHash: await sha256(Y.encodeStateAsUpdate(f.yDoc)) }
      f.yDoc.getMap('metadata').set('unsent', true)
      await f.manager.captureProof('document', proof)
      await f.manager.flushPersistence()
      expect(f.saved()).toEqual({})
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
    } finally { await f.destroy() }
  })

  test('remote changes and deletion invalidate records and request a fresh sync', async () => {
    const f = fixture()
    try {
      await establish(f)
      f.manager.invalidate('document', 'new-checkpoint')
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
      f.manager.invalidate('document', null)
      await f.manager.flushPersistence()
      expect(f.saved()).toEqual({})
      expect(f.requestResync.mock.calls).toEqual([['document'], ['document']])
    } finally { await f.destroy() }
  })

  test('invalidation arriving before a manifest response wins over its stale token', async () => {
    const f = fixture()
    try {
      await establish(f)
      let finish: (value: { supported: boolean; checkpoints: Record<string, string | null> }) => void = () => {}
      f.requestCheckpoints.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const preparing = f.manager.prepare(['document'])
      await Promise.resolve()
      f.manager.invalidate('document', 'new-checkpoint')
      finish({ supported: true, checkpoints: { document: 'server-checkpoint' } })
      await preparing
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
    } finally { await f.destroy() }
  })

  test.each(['remote invalidation', 'local edit', 'disconnect', 'Yjs update'])('%s during an asynchronous file read cancels verification', async kind => {
    const f = fixture()
    try {
      await establish(f)
      let finish: (value: string) => void = () => {}
      f.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
      const verification = f.manager.tryVerify(f.document)
      await Promise.resolve()
      if (kind === 'remote invalidation') f.manager.invalidate('document', 'new-checkpoint')
      else if (kind === 'local edit') f.manager.invalidateLocal('document')
      else if (kind === 'disconnect') f.manager.resetConnection()
      else f.yDoc.getMap('metadata').set('new', true)
      finish('Saved content')
      await expect(verification).resolves.toBeNull()
    } finally { await f.destroy() }
  })

  test('a stale proof cannot recreate an invalidated newer checkpoint record', async () => {
    const f = fixture()
    try {
      const proof = await establish(f)
      f.manager.invalidate('document', 'new-checkpoint')
      await f.manager.captureProof('document', proof)
      await f.manager.flushPersistence()
      expect(f.saved()).toEqual({})
    } finally { await f.destroy() }
  })

  test('batched periodic verification discovers changes even without notifications', async () => {
    const f = fixture()
    try {
      await establish(f)
      f.checkpoint('changed-remotely')
      await f.manager.prepare(['document'])
      expect(f.requestResync).toHaveBeenCalledWith('document')
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
    } finally { await f.destroy() }
  })

  test('unsupported, unavailable or malformed stored state stays on the normal path', async () => {
    const f = fixture({ document: { schema: 1, scope: 'different-vault', stateHash: 'bad' } as RestartRecord })
    try {
      await f.manager.prepare(['document'])
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
      f.requestCheckpoints.mockRejectedValueOnce(new Error('Network unavailable'))
      await f.manager.prepare(['document'])
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
    } finally { await f.destroy() }
  })

  test('requests are bounded to 2000 IDs and duplicate IDs are removed', async () => {
    const f = fixture()
    try {
      const ids = Array.from({ length: 4001 }, (_, index) => 'id-' + index)
      await f.manager.prepare([...ids, ids[0]])
      expect(f.requestCheckpoints.mock.calls.map(([batch]) => batch.length)).toEqual([2000, 2000, 1])
    } finally { await f.destroy() }
  })

  test('persistence failure disables fast verification while normal synchronization remains possible', async () => {
    const f = fixture()
    const log = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      f.persist.mockRejectedValueOnce(new Error('Disk full'))
      await establish(f)
      await expect(f.manager.tryVerify(f.document)).resolves.toBeNull()
      expect(log).toHaveBeenCalled()
    } finally { await f.destroy(); log.mockRestore() }
  })
})
