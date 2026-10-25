import { TFile } from 'obsidian'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type PeerdraftPlugin from '../peerdraftPlugin'
import { canonicalStateUpdate, sha256, type SyncProof } from '../fastRestart'
import { SharedDocument } from '../sharedEntities/sharedDocument'
import { SharedFolder } from '../sharedEntities/sharedFolder'
import { addCanvasToYDoc, yDocToCanvasJSON } from '../sharedEntities/canvas'
import { SyncableDocument } from '../sharedEntities/syncableDocument'
import { checkIndexedDBAlreadyExists } from '../tools'
import { add } from '../permanentShareStoreFS'
import { showNotice } from '../ui'

function mockCommitDatabase(autoComplete = true): { db: IDBDatabase; transaction: IDBTransaction; request: IDBRequest<number> } {
  const request = { onsuccess: null, onerror: null } as unknown as IDBRequest<number>
  const transaction = {
    oncomplete: null, onerror: null, onabort: null, error: null,
    objectStore: jest.fn(() => ({ add: jest.fn((_state: Uint8Array) => {
      if (autoComplete) queueMicrotask(() => transaction.oncomplete?.(new Event('complete')))
      return request
    }) })),
    abort: jest.fn(() => transaction.onabort?.(new Event('abort'))),
  } as unknown as IDBTransaction
  const db = { transaction: jest.fn(() => transaction) } as unknown as IDBDatabase
  return { db, transaction, request }
}

jest.mock('../main', () => ({ __esModule: true, default: class {} }))
jest.mock('../sharedEntities/sharedFolder', () => ({ SharedFolder: class { static async getOrCreatePath(): Promise<void> {} } }))
jest.mock('../sharedEntities/canvas', () => {
  Object.assign(jest.requireMock('obsidian'), { debounce: (callback: unknown) => callback })
  return jest.requireActual('../sharedEntities/canvas')
})
jest.mock('../permanentShareStoreFS', () => ({
  getDocByPath: (path: string, plugin: PeerdraftPlugin) => plugin.settings.serverShares.files.get(path),
  add: jest.fn(async (doc: SharedDocument, plugin: PeerdraftPlugin) => {
    plugin.settings.serverShares.files.set(doc.path, { shareId: doc.shareId, persistenceId: 'new-cache' })
  }),
}))
jest.mock('../ui/login', () => ({}))
jest.mock('../ui/enterText', () => ({}))
jest.mock('../ui/canvas', () => ({}))
jest.mock('../peerdraftWebSocketProvider', () => ({ StopSessionError: class extends Error {} }))
jest.mock('../workspace/peerdraftWorkspace', () => ({ getLeafIdsByPath: () => [] }))
jest.mock('../workspace/explorerView', () => ({
  setStatusClass: jest.fn().mockResolvedValue(undefined), removeStatusClass: jest.fn().mockResolvedValue(undefined),
  removeIsSharedClass: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../ui', () => ({ usercolors: [{ dark: '#000', light: '#fff' }], showNotice: jest.fn() }))
jest.mock('y-codemirror.next', () => ({ yCollab: jest.fn(() => []) }))
jest.mock('y-webrtc', () => ({ WebrtcProvider: class {} }))
jest.mock('tiny-jsonc', () => ({ __esModule: true, default: { parse: JSON.parse } }))
jest.mock('../tools', () => ({ ...jest.requireActual('../tools'), checkIndexedDBAlreadyExists: jest.fn() }))
jest.mock('y-indexeddb', () => ({
  IndexeddbPersistence: jest.fn().mockImplementation(() => ({
    synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: mockCommitDatabase().db,
  })),
}))

async function fixture(content = 'Complete downloaded text') {
  const source = new Y.Doc()
  if (content) source.getText('content').insert(0, content)
  source.getMap('metadata').set('important', 'preserved')
  const downloaded = new Y.Doc()
  Y.applyUpdate(downloaded, Y.encodeStateAsUpdate(source))
  const proof: SyncProof = { checkpoint: 'token', stateHash: await sha256(canonicalStateUpdate(downloaded)) }
  const files = new Map<string, TFile>()
  const contents = new Map<TFile, string>()
  const handlers = new Set<(id: string, checksum: string) => void>()
  const read = jest.fn(async (file: TFile): Promise<string> => contents.get(file) ?? '')
  const create = jest.fn(async (path: string, initial: string): Promise<TFile> => {
    const file = Object.assign(new TFile(), { path, extension: 'md', stat: { mtime: 100, size: initial.length } })
    files.set(path, file)
    contents.set(file, initial)
    return file
  })
  const modify = jest.fn(async (file: TFile, text: string): Promise<void> => { contents.set(file, text); file.stat.mtime++ })
  const { calculateHash } = jest.requireActual('../tools') as typeof import('../tools')
  const server = {
    wsconnected: true,
    on: jest.fn((event: string, handler: (id: string, checksum: string) => void) => { if (event === 'synced') handlers.add(handler) }),
    off: jest.fn((event: string, handler: (id: string, checksum: string) => void) => { if (event === 'synced') handlers.delete(handler) }),
    requestDocumentSnapshot: jest.fn(async () => ({
      doc: downloaded, checksum: calculateHash(source.getText('content').toString()), proof,
      isCurrent: () => true,
    })),
    sendSyncStep1: jest.fn((entity: SyncableDocument) => {
      queueMicrotask(() => { for (const handler of Array.from(handlers)) handler(entity.shareId, entity.calculateHash()) })
    }),
    sendUpdate: jest.fn(), receiveSyncProof: jest.fn(),
  }
  const plugin = {
    settings: { name: 'Test', debug: false, serverShares: { files: new Map() } },
    log: jest.fn(), registerEvent: jest.fn(), activeStreamClient: { add: jest.fn() }, serverSync: server,
    fastRestart: { matchesCheckpoint: jest.fn(() => true), captureProof: jest.fn().mockResolvedValue(undefined) },
    getFastRestartDocument: jest.fn(), captureRestartProof: jest.fn(),
    pws: { markdown: { get: jest.fn() } },
    app: { vault: { getAbstractFileByPath: (path: string) => files.get(path) ?? null, read, create, modify, on: jest.fn() },
      workspace: { getLeavesOfType: () => [] } },
  } as unknown as PeerdraftPlugin
  return { source, downloaded, proof, files, contents, plugin, server, read, create, modify,
    cleanup: async () => {
      for (const doc of SharedDocument.getAll()) await doc.destroy()
      downloaded.destroy(); source.destroy()
    } }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(false)
  jest.spyOn(SharedDocument.prototype, 'startWebRTCSyncWithCatchUp').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

test.each(['Complete downloaded text', ''])('creates a complete file and durably adopts proven state (%s) without a handshake', async content => {
  const f = await fixture(content)
  try {
    const doc = await SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin, { quiet: true })
    expect(f.create).toHaveBeenCalledWith('folder/note.md', content)
    expect(f.modify).not.toHaveBeenCalled()
    expect(doc.initializationGuardPassed).toBe(true)
    expect(doc.syncable.indexedDBLoaded).toBe(true)
    expect(doc.syncable.serverSynced).toBe(true)
    expect(f.plugin.settings.serverShares.files.get(doc.path)?.importedComplete).toBe(true)
    expect(doc.yDoc.getMap('metadata').get('important')).toBe('preserved')
    expect(f.server.sendSyncStep1).not.toHaveBeenCalled()
    expect(f.server.receiveSyncProof).toHaveBeenCalledWith('doc', f.proof)
    expect(f.plugin.fastRestart?.captureProof).toHaveBeenCalledWith('doc', f.proof)
    expect(showNotice).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

test.each(['no-proof', 'stale-checkpoint', 'metadata-change', 'mtime-change'])('uses ordinary synchronization when %s prevents complete verification', async cause => {
  const f = await fixture()
  try {
    if (cause === 'no-proof') f.server.requestDocumentSnapshot.mockResolvedValue({ doc: f.downloaded, checksum: '', proof: undefined as unknown as SyncProof, isCurrent: () => true })
    if (cause === 'stale-checkpoint') jest.mocked(f.plugin.fastRestart!.matchesCheckpoint).mockReturnValue(false)
    if (cause === 'metadata-change' || cause === 'mtime-change') {
      const original = f.read.getMockImplementation()!
      let reads = 0
      f.read.mockImplementation(async file => {
        reads++
        const text = await original(file)
        if (reads === 2) {
          if (cause === 'metadata-change') SharedDocument.findById('doc')!.yDoc.getMap('metadata').set('new', true)
          else file.stat.mtime++
        }
        return text
      })
    }
    const doc = await SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
    expect(doc.syncable.indexedDBLoaded).toBe(true)
    expect(f.server.receiveSyncProof).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

test('keeps an intentional empty edit made after the full file was created', async () => {
  const f = await fixture()
  try {
    const original = f.create.getMockImplementation()!
    f.create.mockImplementation(async (path, content) => {
      const file = await original(path, content)
      f.contents.set(file, '')
      file.stat.mtime++
      return file
    })
    const doc = await SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)
    expect(f.contents.get(doc.file)).toBe('')
    expect(doc.getValue()).toBe('')
    expect(f.modify).not.toHaveBeenCalled()
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
  } finally { await f.cleanup() }
})

test('restores the same-ID persistence entry and preserves owned offline text', async () => {
  const f = await fixture()
  try {
    const file = await f.create('folder/note.md', 'Offline owned text')
    f.create.mockClear()
    f.plugin.settings.serverShares.files.set(file.path, { shareId: 'doc', persistenceId: 'existing-cache' })
    jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(true)
    const doc = await SharedDocument.fromIdAndPath('doc', file.path, f.plugin)
    expect(f.create).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(f.plugin.settings.serverShares.files.get(file.path)?.persistenceId).toBe('existing-cache')
    expect(IndexeddbPersistence).toHaveBeenCalledWith('peerdraft_persistence_existing-cache', doc.yDoc)
    expect(doc.getValue()).toBe('Offline owned text')
    expect(f.contents.get(file)).toBe('Offline owned text')
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
  } finally { await f.cleanup() }
})

test('never overwrites an unrelated local file', async () => {
  const f = await fixture()
  try {
    const file = await f.create('folder/note.md', 'Unrelated notes')
    f.create.mockClear()
    await expect(SharedDocument.fromIdAndPath('doc', file.path, f.plugin)).rejects.toThrow('unrelated')
    expect(f.contents.get(file)).toBe('Unrelated notes')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.modify).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

test.each([false, true])('rejects an unavailable server document before changing local data (file exists: %s)', async existing => {
  const f = await fixture()
  const empty = new Y.Doc()
  try {
    const target = 'folder/note.md'
    const file = existing ? await f.create(target, 'Preserved local text') : undefined
    f.create.mockClear()
    f.server.requestDocumentSnapshot.mockResolvedValue({ doc: empty, checksum: '', proof: undefined as unknown as SyncProof, isCurrent: () => true })
    await expect(SharedDocument.fromIdAndPath('doc', target, f.plugin)).rejects.toThrow('no saved state')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.modify).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(SharedDocument.findById('doc')).toBeUndefined()
    expect(f.server.sendSyncStep1).not.toHaveBeenCalled()
    if (file) expect(f.contents.get(file)).toBe('Preserved local text')
  } finally { empty.destroy(); await f.cleanup() }
})

test('does not create a file when membership changed while downloading', async () => {
  const f = await fixture()
  try {
    let current = true
    const snapshot = await f.server.requestDocumentSnapshot()
    f.server.requestDocumentSnapshot.mockImplementation(async () => { current = false; return snapshot })
    await expect(SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin, { isCurrent: () => current })).rejects.toThrow('changed')
    expect(f.create).not.toHaveBeenCalled()
    expect(SharedDocument.findById('doc')).toBeUndefined()
  } finally { await f.cleanup() }
})

test('cache failure leaves a complete resumable file but does not report completion', async () => {
  const f = await fixture()
  try {
    jest.mocked(IndexeddbPersistence).mockImplementationOnce(() => { throw new Error('Quota exceeded') })
    await expect(SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)).rejects.toThrow('persist')
    const file = f.files.get('folder/note.md')!
    expect(f.contents.get(file)).toBe('Complete downloaded text')
    expect(f.plugin.settings.serverShares.files.get(file.path)?.shareId).toBe('doc')
    expect(SharedDocument.findById('doc')).toBeUndefined()
    expect(f.server.receiveSyncProof).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})


test('recreates a missing owned file from its preserved cache state before reconciliation', async () => {
  const f = await fixture()
  const cached = new Y.Doc()
  try {
    Y.applyUpdate(cached, Y.encodeStateAsUpdate(f.source))
    cached.getText('content').delete(0, cached.getText('content').length)
    cached.getText('content').insert(0, 'Offline cached text')
    f.plugin.settings.serverShares.files.set('folder/note.md', { shareId: 'doc', persistenceId: 'existing-cache' })
    jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(true)
    jest.mocked(IndexeddbPersistence).mockImplementationOnce((_name, yDoc) => {
      Y.applyUpdate(yDoc!, Y.encodeStateAsUpdate(cached))
      return { synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: mockCommitDatabase().db } as unknown as IndexeddbPersistence
    })
    const doc = await SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)
    expect(f.create).toHaveBeenCalledWith('folder/note.md', 'Offline cached text')
    expect(doc.getValue()).toBe('Offline cached text')
    expect(f.plugin.settings.serverShares.files.get(doc.path)?.persistenceId).toBe('existing-cache')
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
  } finally { cached.destroy(); await f.cleanup() }
})

test('a membership change after materialization cannot accept or capture the downloaded proof', async () => {
  const f = await fixture()
  try {
    let current = true
    const original = f.read.getMockImplementation()!
    f.read.mockImplementation(async file => {
      const text = await original(file)
      current = false
      return text
    })
    await expect(SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin, { isCurrent: () => current })).rejects.toThrow('changed')
    expect(f.server.receiveSyncProof).not.toHaveBeenCalled()
    expect(f.server.sendSyncStep1).not.toHaveBeenCalled()
    expect(SharedDocument.findById('doc')).toBeUndefined()
    expect(f.plugin.settings.serverShares.files.get('folder/note.md')?.shareId).toBe('doc')
  } finally { await f.cleanup() }
})

test('durable creation hooks bracket the full-content file write', async () => {
  const f = await fixture()
  const order: string[] = []
  try {
    const create = f.create.getMockImplementation()!
    f.create.mockImplementation(async (path, content) => { order.push('create:' + content); return create(path, content) })
    await SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin, {
      beforeCreate: async content => { order.push('before:' + content); expect(f.files.size).toBe(0) },
      afterCreate: async () => { order.push('after'); expect(f.files.size).toBe(1) },
    })
    expect(order).toEqual(['before:Complete downloaded text', 'create:Complete downloaded text', 'after'])
  } finally { await f.cleanup() }
})

test('journal-authorized existing files preserve edits and skip creation hooks', async () => {
  const f = await fixture()
  try {
    const file = await f.create('folder/note.md', 'Edited after interrupted import')
    f.create.mockClear()
    const beforeCreate = jest.fn()
    const afterCreate = jest.fn()
    const doc = await SharedDocument.fromIdAndPath('doc', file.path, f.plugin, {
      allowExistingFile: true, beforeCreate, afterCreate,
    })
    expect(doc.getValue()).toBe('Edited after interrupted import')
    expect(f.contents.get(file)).toBe('Edited after interrupted import')
    expect(beforeCreate).not.toHaveBeenCalled()
    expect(afterCreate).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
  } finally { await f.cleanup() }
})

test('staleness during the durable ownership hook prevents file creation', async () => {
  const f = await fixture()
  try {
    let current = true
    await expect(SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin, {
      isCurrent: () => current, beforeCreate: async () => { current = false },
    })).rejects.toThrow('changed')
    expect(f.create).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

test('a newer remote update during accepted-state initialization is preserved over unchanged imported disk text', async () => {
  const f = await fixture()
  const remote = new Y.Doc()
  try {
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.downloaded))
    remote.getText('content').delete(0, remote.getText('content').length)
    remote.getText('content').insert(0, 'Newer remote text')
    const original = f.read.getMockImplementation()!
    let reads = 0
    f.read.mockImplementation(async file => {
      const text = await original(file)
      if (++reads === 3) Y.applyUpdate(SharedDocument.findById('doc')!.yDoc, Y.encodeStateAsUpdate(remote), f.server)
      return text
    })
    const doc = await SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(doc.getValue()).toBe('Newer remote text')
    expect(f.contents.get(doc.file)).toBe('Newer remote text')
  } finally { remote.destroy(); await f.cleanup() }
})


test('two folders racing the same ID after directory creation create only one file', async () => {
  const f = await fixture()
  const secondDownload = new Y.Doc()
  try {
    Y.applyUpdate(secondDownload, Y.encodeStateAsUpdate(f.downloaded))
    const response = await f.server.requestDocumentSnapshot()
    f.server.requestDocumentSnapshot.mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response, doc: secondDownload })
    const releasePaths: Array<() => void> = []
    jest.spyOn(SharedFolder, 'getOrCreatePath').mockImplementation(() => new Promise(resolve => {
      releasePaths.push(() => resolve(undefined as never))
    }))
    let finishCreation: () => void = () => {}
    const creationGate = new Promise<void>(resolve => { finishCreation = resolve })
    const first = SharedDocument.fromIdAndPath('doc', 'first/note.md', f.plugin, { beforeCreate: () => creationGate })
    const second = SharedDocument.fromIdAndPath('doc', 'second/note.md', f.plugin)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(releasePaths).toHaveLength(2)
    releasePaths[0]()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const pending = SharedDocument.findById('doc')!
    expect(pending.initialImportInProgress).toBe(true)
    expect(pending.initialImportCompletion).toBeDefined()
    releasePaths[1]()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(f.create).not.toHaveBeenCalled()
    finishCreation()
    const [firstDoc, secondDoc] = await Promise.all([first, second])
    expect(firstDoc).toBe(secondDoc)
    expect(firstDoc.path).toBe('first/note.md')
    expect(firstDoc.initialImportInProgress).toBe(false)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.files.has('second/note.md')).toBe(false)
  } finally { secondDownload.destroy(); await f.cleanup() }
})

test('Canvas imports use ordinary sync and retain bidirectional Canvas JSON bindings', async () => {
  const f = await fixture('')
  const remote = new Y.Doc()
  try {
    const canvas = { nodes: [{ id: 'n1', type: 'text', text: 'Initial Canvas text', x: 0, y: 0, width: 200, height: 100 }], edges: [] }
    addCanvasToYDoc(canvas, f.downloaded)
    const doc = await SharedDocument.fromIdAndPath('doc', 'folder/diagram.canvas', f.plugin)
    expect(doc.isCanvas).toBe(true)
    expect(doc.initializationGuardPassed).toBe(true)
    expect(JSON.parse(f.contents.get(doc.file)!)).toEqual(canvas)
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
    expect(f.server.receiveSyncProof).not.toHaveBeenCalled()
    expect(doc.getContentFragment().toString()).toBe('')
    // Apply an actual Yjs remote Canvas update and verify its disk binding.
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc.yDoc))
    const nodes = remote.getMap('canvas').get('nodes') as Y.Map<Y.Map<unknown>>
    nodes.get('n1')!.set('text', 'Remote Canvas text')
    Y.applyUpdate(doc.yDoc, Y.encodeStateAsUpdate(remote), f.server)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(JSON.parse(f.contents.get(doc.file)!).nodes[0].text).toBe('Remote Canvas text')
    // The registered vault observer also applies local JSON edits into Yjs.
    const local = JSON.parse(f.contents.get(doc.file)!)
    local.nodes[0].text = 'Local Canvas text'
    f.contents.set(doc.file, JSON.stringify(local))
    doc.file.stat.mtime++
    const calls = (f.plugin.app.vault.on as jest.Mock).mock.calls as Array<[string, (file: TFile) => Promise<void>]>
    await calls.find(([event]) => event === 'modify')![1](doc.file)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(yDocToCanvasJSON(doc.yDoc).nodes[0].text).toBe('Local Canvas text')
    expect(doc.getContentFragment().toString()).toBe('')
  } finally { remote.destroy(); await f.cleanup() }
})

test('destruction during proof persistence rejects initialization and cannot restart WebRTC or remove another document', async () => {
  const f = await fixture()
  const other = await fixture('Another document')
  let releaseProof: () => void = () => {}
  const proofGate = new Promise<void>(resolve => { releaseProof = resolve })
  try {
    jest.mocked(f.plugin.fastRestart!.captureProof).mockReturnValue(proofGate)
    const initializing = SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)
    const rejected = expect(initializing).rejects.toThrow('lifecycle changed')
    for (let i = 0; i < 100 && !jest.mocked(f.plugin.fastRestart!.captureProof).mock.calls.length; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    const doc = SharedDocument.findById('doc')!
    expect(doc.initialImportInProgress).toBe(true)
    const secondDoc = await SharedDocument.fromIdAndPath('other', 'second/note.md', other.plugin)
    await doc.destroy()
    await doc.destroy()
    expect(SharedDocument.findById('other')).toBe(secondDoc)
    releaseProof()
    await rejected
    expect(SharedDocument.findById('other')).toBe(secondDoc)
    expect(jest.mocked(SharedDocument.prototype.startWebRTCSyncWithCatchUp).mock.contexts).not.toContain(doc)
  } finally { releaseProof(); await f.cleanup(); await other.cleanup() }
})

test('an intentional empty save through the vault event is preserved while proof persistence is pending', async () => {
  const f = await fixture()
  let releaseProof: () => void = () => {}
  const proofGate = new Promise<void>(resolve => { releaseProof = resolve })
  try {
    jest.mocked(f.plugin.fastRestart!.captureProof).mockReturnValue(proofGate)
    const initializing = SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)
    for (let i = 0; i < 100 && !jest.mocked(f.plugin.fastRestart!.captureProof).mock.calls.length; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    const doc = SharedDocument.findById('doc')!
    expect(doc.initialImportInProgress).toBe(true)
    f.contents.set(doc.file, '')
    doc.file.stat.mtime++
    const calls = (f.plugin.app.vault.on as jest.Mock).mock.calls as Array<[string, (file: TFile) => Promise<void>]>
    await calls.find(([event]) => event === 'modify')![1](doc.file)
    expect(doc.getValue()).toBe('')
    expect(f.contents.get(doc.file)).toBe('')
    releaseProof()
    await initializing
    expect(doc.getValue()).toBe('')
    expect(f.contents.get(doc.file)).toBe('')
    expect(doc.initialImportInProgress).toBe(false)
  } finally { releaseProof(); await f.cleanup() }
})


test('a completed import restores an existing intentionally empty file without cache placeholder repair', async () => {
  const f = await fixture()
  try {
    const file = await f.create('folder/note.md', '')
    f.plugin.settings.serverShares.files.set(file.path, { shareId: 'doc', persistenceId: 'completed-cache', importedComplete: true })
    jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(true)
    jest.mocked(IndexeddbPersistence).mockImplementationOnce((_name, yDoc) => {
      Y.applyUpdate(yDoc!, Y.encodeStateAsUpdate(f.source))
      return { synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: mockCommitDatabase().db } as unknown as IndexeddbPersistence
    })
    const doc = await SharedDocument.fromPermanentShareDocument({
      shareId: 'doc', path: file.path, persistenceId: 'completed-cache', importedComplete: true,
    }, f.plugin)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(doc?.initializationGuardPassed).toBe(true)
    expect(doc?.getValue()).toBe('')
    expect(f.contents.get(file)).toBe('')
    expect(f.modify).not.toHaveBeenCalled()
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
  } finally { await f.cleanup() }
})

test('a missing completed-import file restores cache text rather than interpreting its recreation placeholder as an empty edit', async () => {
  const f = await fixture()
  try {
    f.plugin.settings.serverShares.files.set('folder/note.md', { shareId: 'doc', persistenceId: 'completed-cache', importedComplete: true })
    jest.mocked(checkIndexedDBAlreadyExists).mockResolvedValue(true)
    jest.mocked(IndexeddbPersistence).mockImplementationOnce((_name, yDoc) => {
      Y.applyUpdate(yDoc!, Y.encodeStateAsUpdate(f.source))
      return { synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: mockCommitDatabase().db } as unknown as IndexeddbPersistence
    })
    const doc = await SharedDocument.fromPermanentShareDocument({
      shareId: 'doc', path: 'folder/note.md', persistenceId: 'completed-cache', importedComplete: true,
    }, f.plugin)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(doc?.initializationGuardPassed).toBe(true)
    expect(doc?.getValue()).toBe('Complete downloaded text')
    expect(f.contents.get(doc!.file)).toBe('Complete downloaded text')
  } finally { await f.cleanup() }
})

test('Canvas edits during a deferred cache check reach Yjs before handshake and survive a later remote merge', async () => {
  const f = await fixture('')
  const remote = new Y.Doc()
  let releaseCache: (exists: boolean) => void = () => {}
  const cacheGate = new Promise<boolean>(resolve => { releaseCache = resolve })
  try {
    const canvas = { nodes: [{ id: 'n1', type: 'text', text: 'Initial text', x: 0, y: 0, width: 200, height: 100 }], edges: [] }
    addCanvasToYDoc(canvas, f.downloaded)
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.downloaded))
    const remoteNodes = remote.getMap('canvas').get('nodes') as Y.Map<Y.Map<unknown>>
    remoteNodes.set('n2', new Y.Map<unknown>([['id', 'n2'], ['type', 'text'], ['text', 'Remote new node']]))
    jest.mocked(checkIndexedDBAlreadyExists).mockReturnValueOnce(cacheGate)
    const send = f.server.sendSyncStep1.getMockImplementation()!
    f.server.sendSyncStep1.mockImplementation(entity => {
      Y.applyUpdate(entity.yDoc, Y.encodeStateAsUpdate(remote), f.server)
      send(entity)
    })
    const importing = SharedDocument.fromIdAndPath('doc', 'folder/diagram.canvas', f.plugin)
    for (let i = 0; i < 30 && !jest.mocked(checkIndexedDBAlreadyExists).mock.calls.length; i++) await Promise.resolve()
    const doc = SharedDocument.findById('doc')!
    expect(doc.initializationGuardPassed).toBe(false)
    expect(f.server.sendSyncStep1).not.toHaveBeenCalled()
    const localCanvas = JSON.parse(f.contents.get(doc.file)!)
    localCanvas.nodes[0].text = 'Early local Canvas edit'
    f.contents.set(doc.file, JSON.stringify(localCanvas))
    doc.file.stat.mtime++
    const calls = (f.plugin.app.vault.on as jest.Mock).mock.calls as Array<[string, (file: TFile) => Promise<void>]>
    await calls.find(([event]) => event === 'modify')![1](doc.file)
    expect(yDocToCanvasJSON(doc.yDoc).nodes[0].text).toBe('Early local Canvas edit')
    releaseCache(false)
    await importing
    const finalCanvas = JSON.parse(f.contents.get(doc.file)!)
    expect(finalCanvas.nodes.find((node: { id: string }) => node.id === 'n1').text).toBe('Early local Canvas edit')
    expect(finalCanvas.nodes.find((node: { id: string }) => node.id === 'n2').text).toBe('Remote new node')
    expect(doc.getContentFragment().toString()).toBe('')
    expect(f.server.sendSyncStep1).toHaveBeenCalledTimes(1)
  } finally { releaseCache(false); remote.destroy(); await f.cleanup() }
})

test('a Canvas file read settling after destruction cannot mutate Yjs or restart disk writes', async () => {
  const f = await fixture('')
  try {
    addCanvasToYDoc({ nodes: [{ id: 'n1', type: 'text', text: 'Original' }], edges: [] }, f.downloaded)
    const doc = await SharedDocument.fromIdAndPath('doc', 'folder/diagram.canvas', f.plugin)
    const calls = (f.plugin.app.vault.on as jest.Mock).mock.calls as Array<[string, (file: TFile) => Promise<void>]>
    const onModify = calls.find(([event]) => event === 'modify')![1]
    let releaseRead: (content: string) => void = () => {}
    f.read.mockReturnValueOnce(new Promise<string>(resolve => { releaseRead = resolve }))
    doc.file.stat.mtime++
    const changing = onModify(doc.file)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await doc.destroy()
    releaseRead(JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Late stale edit' }], edges: [] }))
    await changing
    expect(yDocToCanvasJSON(doc.yDoc).nodes[0].text).toBe('Original')
    const reads = f.read.mock.calls.length
    await onModify(doc.file)
    doc.yDoc.transact(() => doc.yDoc.getMap('canvas').set('late', true), f.server)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(f.read).toHaveBeenCalledTimes(reads)
    expect(f.modify).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

test.each(['complete', 'abort', 'error', 'destroy'])('import completion waits for the real cache transaction barrier: %s', async outcome => {
  const f = await fixture()
  const commit = mockCommitDatabase(false)
  try {
    jest.mocked(IndexeddbPersistence).mockImplementationOnce(() => ({
      synced: true, whenSynced: Promise.resolve(), destroy: jest.fn(), db: commit.db,
    } as unknown as IndexeddbPersistence))
    let completed = false
    const importing = SharedDocument.fromIdAndPath('doc', 'folder/note.md', f.plugin)
    const result = importing.then(() => { completed = true })
    const rejected = outcome === 'complete' ? undefined : expect(result).rejects.toThrow(/persistence|commit/i)
    for (let i = 0; i < 100 && !(commit.db.transaction as jest.Mock).mock.calls.length; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    const doc = SharedDocument.findById('doc')!
    expect(commit.db.transaction).toHaveBeenCalledWith('updates', 'readwrite')
    expect(completed).toBe(false)
    expect(doc.initialImportInProgress).toBe(true)
    expect(doc.getSyncStatus()).toBe('syncing')
    expect(f.plugin.settings.serverShares.files.get(doc.path)?.importedComplete).toBeUndefined()
    // Even a successful snapshot add request must not label the write transaction committed.
    commit.request.onsuccess?.(new Event('success'))
    await Promise.resolve()
    expect(completed).toBe(false)
    if (outcome === 'complete') {
      commit.transaction.oncomplete?.(new Event('complete'))
      await result
      expect(completed).toBe(true)
      expect(doc.getSyncStatus()).toBe('insync')
      expect(f.plugin.settings.serverShares.files.get(doc.path)?.importedComplete).toBe(true)
    } else {
      if (outcome === 'abort') commit.transaction.onabort?.(new Event('abort'))
      else if (outcome === 'error') commit.transaction.onerror?.(new Event('error'))
      else await doc.destroy()
      await rejected
      expect(completed).toBe(false)
      expect(f.plugin.settings.serverShares.files.get(doc.path)?.importedComplete).toBeUndefined()
      expect(SharedDocument.findById('doc')).toBeUndefined()
      expect(jest.mocked(SharedDocument.prototype.startWebRTCSyncWithCatchUp).mock.contexts).not.toContain(doc)
    }
  } finally { await f.cleanup() }
})
