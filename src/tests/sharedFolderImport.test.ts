import { TFile, TFolder } from 'obsidian'
import * as Y from 'yjs'
import type PeerdraftPlugin from '../peerdraftPlugin'
import type { Settings } from '../settings'
import { saveSettingsNow } from '../settings'
import { importedFilePath, folderImportQueue, importFileOperationActive, withImportFileOperation } from '../folderImport'
import { textSha256 } from '../fastRestart'
import { SharedFolder } from '../sharedEntities/sharedFolder'
import { SharedDocument } from '../sharedEntities/sharedDocument'

jest.mock('../main', () => ({ __esModule: true, default: class {} }))
jest.mock('../permanentShareStoreFS', () => ({ getFolderByPath: jest.fn(), moveFolder: jest.fn(async () => {}) }))
jest.mock('../ui/enterText', () => ({}))
jest.mock('../peerdraftWebSocketProvider', () => ({ StopSessionError: class extends Error {} }))
jest.mock('../ui/login', () => ({}))
jest.mock('../workspace/explorerView', () => ({ setStatusClass: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../tools', () => ({ generateRandomString: () => 'conflict', createRandomId: () => 'cache' }))
jest.mock('../ui', () => ({ showNotice: jest.fn(() => ({ hide: jest.fn(), setMessage: jest.fn() })) }))
jest.mock('../settings', () => ({ saveSettingsNow: jest.fn() }))
jest.mock('../utils/fileTypeDetection', () => ({}))
jest.mock('../sharedEntities/binaryFileSync', () => ({
  BinaryFileSync: class { destroy(): void {} },
}))
jest.mock('../sharedEntities/sharedDocument', () => ({ SharedDocument: {
  getAll: jest.fn(), findById: jest.fn(), findByPath: jest.fn(), fromIdAndPath: jest.fn(),
} }))
jest.mock('../sharedEntities/syncableFolder', () => ({
  SyncableFolder: class {
    indexedDBLoaded = true
    indexedDBWasEmpty = false
    serverSynced = true
    serverSyncing = false
    destroy(): void {}
    setShareId(): void {}
  },
}))
jest.mock('y-webrtc', () => ({ WebrtcProvider: class {} }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function resume(folder: SharedFolder): Promise<void> {
  const run = Reflect.get(folder, 'importMissingDocuments') as () => Promise<void>
  return run.call(folder)
}

function fixture() {
  const files = new Map<string, TFile | TFolder>()
  const contents = new Map<string, string>()
  const documents = new Map<string, SharedDocument>()
  const snapshots: Settings[] = []
  const events: string[] = []
  const cleanups: Array<() => void> = []
  const downloads = new Map<string, ReturnType<typeof deferred>>()
  const materializations = new Map<string, ReturnType<typeof deferred>>()
  const initializations = new Map<string, ReturnType<typeof deferred>>()
  const joinedInitializations = new Map<string, ReturnType<typeof deferred>>()
  const crashes = new Map<string, 'afterFile' | 'afterMaterialized'>()
  const started: string[] = []
  let active = 0
  let maximum = 0
  const settings = { serverShares: { files: new Map(), folders: new Map() }, folderImports: {} } as unknown as Settings
  const transport = {
    wsconnected: true,
    requestDocumentSnapshot: jest.fn(async (id: string): Promise<string> => {
      await downloads.get(id)?.promise
      return 'Remote content for ' + id
    }),
  }
  const create = jest.fn(async (path: string, content: string): Promise<TFile> => {
    if (files.has(path)) throw new Error('File exists')
    events.push('create:' + path)
    const file = Object.assign(new TFile(), { path })
    files.set(path, file)
    contents.set(path, content)
    return file
  })
  const renameFile = jest.fn(async (file: TFile, target: string): Promise<void> => {
    const content = contents.get(file.path)!
    contents.delete(file.path)
    files.delete(file.path)
    file.path = target
    files.set(target, file)
    contents.set(target, content)
  })
  const plugin = {
    settings,
    log: jest.fn(),
    register: (cleanup: () => void): void => { cleanups.push(cleanup) },
    serverSync: transport,
    fastRestart: { prepare: jest.fn(async (): Promise<void> => {}), flushPersistence: jest.fn(async (): Promise<void> => {}) },
    app: {
      vault: {
        getAbstractFileByPath: (path: string): TFile | TFolder | undefined => files.get(path),
        read: async (file: TFile): Promise<string> => contents.get(file.path)!,
        create,
        delete: async (file: TFile): Promise<void> => { files.delete(file.path); contents.delete(file.path) },
        createFolder: async (path: string): Promise<TFolder> => {
          const folder = Object.assign(new TFolder(), { path })
          files.set(path, folder)
          return folder
        },
      },
      fileManager: { renameFile },
    },
  } as unknown as PeerdraftPlugin

  jest.mocked(saveSettingsNow).mockImplementation(async current => {
    snapshots.push(JSON.parse(JSON.stringify(current)) as Settings)
    events.push('persist')
  })
  jest.mocked(SharedDocument.getAll).mockImplementation(() => Array.from(documents.values()))
  jest.mocked(SharedDocument.findById).mockImplementation(id => documents.get(id))
  jest.mocked(SharedDocument.findByPath).mockImplementation(path => Array.from(documents.values()).find(doc => doc.path === path))

  function document(id: string, target: string, initialImportInProgress = false): SharedDocument {
    const model = {
      shareId: id, path: target, file: files.get(target), initialImportInProgress,
      syncable: { on: jest.fn() },
      getSyncStatus: (): string => 'insync',
      updateFileRef(file: TFile): void { this.file = file; this.path = file.path },
      async unshare(): Promise<void> {
        documents.delete(id)
        settings.serverShares.files.delete(this.path)
      },
    }
    const result = model as unknown as SharedDocument
    documents.set(id, result)
    return result
  }
  // The factory models the real factory's transport, durable-create hooks and
  // final initialization barrier. The folder and queue under test are real.
  jest.mocked(SharedDocument.fromIdAndPath).mockImplementation(async (id, target, _plugin, options = {}) => {
    started.push(id)
    maximum = Math.max(maximum, ++active)
    try {
      const existing = documents.get(id)
      if (existing) {
        await joinedInitializations.get(id)?.promise
        Reflect.set(existing, 'initialImportInProgress', false)
        return existing
      }
      const content = await transport.requestDocumentSnapshot(id)
      if (!options.isCurrent?.()) throw new Error('Import lifecycle changed')
      let file = files.get(target)
      if (file) {
        if (!(file instanceof TFile) || (!options.allowExistingFile && !settings.serverShares.files.has(target))) {
          throw new Error('Unrelated file')
        }
      } else {
        await options.beforeCreate?.(content)
        if (!options.isCurrent?.()) throw new Error('Import lifecycle changed')
        file = await create(target, content)
        if (crashes.get(id) === 'afterFile') throw new Error('Process stopped after file creation')
        await options.afterCreate?.()
        if (crashes.get(id) === 'afterMaterialized') throw new Error('Process stopped before cache initialization')
      }
      materializations.get(id)?.resolve()
      await initializations.get(id)?.promise
      if (!options.isCurrent?.()) throw new Error('Import lifecycle changed')
      const doc = document(id, target)
      settings.serverShares.files.set(target, { shareId: id, persistenceId: id + '-db' })
      return doc
    } finally { active-- }
  })

  function folder(id: string, path: string, manifest: Record<string, string>): SharedFolder {
    const root = Object.assign(new TFolder(), { path })
    files.set(path, root)
    const doc = new Y.Doc()
    for (const [key, relative] of Object.entries(manifest)) doc.getMap('documents').set(key, relative)
    const shared = Reflect.construct(SharedFolder, [root, plugin, doc]) as SharedFolder
    const setId = Reflect.get(shared, 'setShareIdInternal') as (id: string) => void
    setId.call(shared, id)
    return shared
  }

  return {
    plugin, settings, folder, files, contents, snapshots, events, create, renameFile,
    downloads, materializations, initializations, joinedInitializations, crashes, started, documents, document,
    maximum: (): number => maximum,
    cleanup: (): void => { for (const cleanup of cleanups) cleanup() },
  }
}

afterEach(() => {
  for (const folder of SharedFolder.getAll()) folder.destroy()
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

it('bounds complete document initialization to eight across folders and coalesces duplicate jobs', async () => {
  const f = fixture()
  const manifest = Object.fromEntries(Array.from({ length: 20 }, (_entry, index) => ['doc-' + index, index + '.md']))
  const a = f.folder('folder-a', 'A', Object.fromEntries(Object.entries(manifest).slice(0, 10)))
  const b = f.folder('folder-b', 'B', Object.fromEntries(Object.entries(manifest).slice(10)))
  for (const id of Object.keys(manifest)) {
    f.initializations.set(id, deferred())
    f.materializations.set(id, deferred())
  }
  const jobs = Object.keys(manifest).map((id, index) => (index < 10 ? a : b).queueDocumentImport(id))
  expect(a.queueDocumentImport('doc-0')).toBe(jobs[0])
  await Promise.all(Object.keys(manifest).slice(0, 8).map(id => f.materializations.get(id)!.promise))
  expect(f.started).toEqual(Object.keys(manifest).slice(0, 8))
  expect(f.create).toHaveBeenCalledTimes(8)
  expect(folderImportQueue(f.plugin).activeCount).toBe(8)
  expect(folderImportQueue(f.plugin).pendingCount).toBe(12)
  // Download and materialization have finished, but the budget is retained
  // until cache/server initialization completes as well.
  f.initializations.get('doc-0')!.resolve()
  await jobs[0]
  expect(f.started).toEqual(Object.keys(manifest).slice(0, 9))
  for (const gate of f.initializations.values()) gate.resolve()
  await Promise.all(jobs)
  expect(f.maximum()).toBe(8)
  expect(f.create).toHaveBeenCalledTimes(20)
  expect(f.documents.size).toBe(20)
  f.cleanup()
})

it('resumes an unchanged cached manifest without requiring new Y.Map add events', async () => {
  const f = fixture()
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: { child: { path: 'Shared/note.md' } } } }
  const folder = f.folder('folder', 'Shared', { child: 'note.md' })
  const changes: unknown[] = []
  folder.getDocsFragment().observe(event => changes.push(event))
  await resume(folder)
  expect(changes).toEqual([])
  expect(f.contents.get('Shared/note.md')).toBe('Remote content for child')
  expect(f.settings.folderImports.folder).toBeUndefined()
  expect(f.snapshots.at(-1)?.folderImports?.folder).toBeUndefined()
  expect(f.plugin.fastRestart?.prepare).toHaveBeenCalledWith(['folder', 'child'])
  f.cleanup()
})

it('waits for the before-create ownership hash to reach disk before materializing content', async () => {
  const f = fixture()
  const folder = f.folder('folder', 'Shared', { child: 'note.md' })
  const enteredWrite = deferred()
  const finishWrite = deferred()
  const persist = jest.mocked(saveSettingsNow).getMockImplementation()!
  jest.mocked(saveSettingsNow).mockImplementationOnce(async (settings, plugin) => {
    enteredWrite.resolve()
    await finishWrite.promise
    await persist(settings, plugin)
  })
  const importing = folder.queueDocumentImport('child')
  await enteredWrite.promise
  expect(f.settings.folderImports?.folder.documents.child).toEqual({
    path: 'Shared/note.md', materialized: false, contentHash: await textSha256('Remote content for child'),
  })
  expect(f.files.has('Shared/note.md')).toBe(false)
  expect(f.snapshots).toEqual([])
  finishWrite.resolve()
  await importing
  expect(f.contents.get('Shared/note.md')).toBe('Remote content for child')
  expect(f.snapshots[0].folderImports?.folder.documents.child?.materialized).toBe(false)
  expect(f.snapshots[1].folderImports?.folder.documents.child?.materialized).toBe(true)
  f.cleanup()
})

it.each(['afterFile', 'afterMaterialized'] as const)('recovers a crash %s using the durable ownership journal', async crash => {
  const f = fixture()
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  f.crashes.set('child', crash)
  const folder = f.folder('folder', 'Shared', { child: 'note.md' })
  await folder.queueDocumentImport('child')
  const hash = await textSha256('Remote content for child')
  const entries = f.snapshots.map(snapshot => snapshot.folderImports?.folder.documents.child).filter(Boolean)
  expect(entries[0]).toEqual({ path: 'Shared/note.md', contentHash: hash, materialized: false })
  expect(f.events.indexOf('persist')).toBeLessThan(f.events.indexOf('create:Shared/note.md'))
  expect(entries.at(-1)?.materialized).toBe(crash === 'afterMaterialized')
  if (crash === 'afterMaterialized') f.contents.set('Shared/note.md', 'Offline edit to owned file')
  folder.destroy()
  f.crashes.clear()
  const restored = f.folder('folder', 'Shared', { child: 'note.md' })
  await resume(restored)
  expect(f.renameFile).not.toHaveBeenCalled()
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.contents.get('Shared/note.md')).toBe(crash === 'afterMaterialized' ? 'Offline edit to owned file' : 'Remote content for child')
  expect(jest.mocked(SharedDocument.fromIdAndPath).mock.calls.at(-1)?.[3]?.allowExistingFile).toBe(true)
  expect(f.settings.folderImports?.folder).toBeUndefined()
  expect(f.documents.get('child')?.path).toBe('Shared/note.md')
  log.mockRestore()
  f.cleanup()
})

it.each(['rename', 'delete'])('recovers hash-owned crash residue when the cached manifest changed by %s before resume', async mode => {
  const f = fixture()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  f.crashes.set('child', 'afterFile')
  const original = f.folder('folder', 'Shared', { child: 'old.md' })
  await original.queueDocumentImport('child')
  expect(f.settings.folderImports?.folder.documents.child.materialized).toBe(false)
  expect(f.contents.get('Shared/old.md')).toBe('Remote content for child')
  original.destroy()
  f.crashes.clear()
  const restored = f.folder('folder', 'Shared', mode === 'rename' ? { child: 'new.md' } : {})
  const begin = Reflect.get(restored, 'beginImportJournal') as () => unknown
  begin.call(restored)
  // The old path and hash remain the ownership evidence until recovery moves
  // or removes the old file. Replacing them with the new target loses it.
  expect(f.settings.folderImports?.folder.documents.child).toEqual({
    path: 'Shared/old.md', contentHash: await textSha256('Remote content for child'), materialized: false,
  })
  await resume(restored)
  expect(f.contents.has('Shared/old.md')).toBe(false)
  expect(f.contents.get('Shared/new.md')).toBe(mode === 'rename' ? 'Remote content for child' : undefined)
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.settings.folderImports?.folder).toBeUndefined()
  if (mode === 'rename') expect(f.documents.get('child')?.path).toBe('Shared/new.md')
  else expect(f.documents.has('child')).toBe(false)
  f.cleanup()
})

it('retains the journal while a registered document factory is still initializing', async () => {
  const f = fixture()
  const folder = f.folder('folder', 'Shared', { child: 'note.md' })
  const file = await f.create('Shared/note.md', 'Owned local content')
  f.settings.serverShares.files.set(file.path, { shareId: 'child', persistenceId: 'child-db' })
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: {
    child: { path: file.path, materialized: true },
  } } }
  const document = f.document('child', file.path, true)
  const initializing = deferred()
  f.joinedInitializations.set('child', initializing)
  let completed = false
  const importing = resume(folder).then(() => { completed = true })
  await nextTurn()
  expect(completed).toBe(false)
  expect(f.settings.folderImports?.folder.documents.child).toBeDefined()
  expect(f.snapshots.every(snapshot => !!snapshot.folderImports?.folder.documents.child)).toBe(true)
  initializing.resolve()
  await importing
  expect(document.initialImportInProgress).toBe(false)
  expect(f.settings.folderImports?.folder).toBeUndefined()
  expect(f.contents.get(file.path)).toBe('Owned local content')
  expect(f.plugin.serverSync.requestDocumentSnapshot).not.toHaveBeenCalled()
  f.cleanup()
})

it('reconciles a cached manifest rename with the owned registered model and saved path before completing', async () => {
  const f = fixture()
  const folder = f.folder('folder', 'Shared', { child: 'new.md' })
  const file = await f.create('Shared/old.md', 'Owned offline edits')
  const document = f.document('child', file.path)
  f.settings.serverShares.files.set(file.path, { shareId: 'child', persistenceId: 'child-db' })
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: {
    child: { path: file.path, materialized: true },
  } } }
  const guards: boolean[][] = []
  const autoCreateEchoes: string[] = []
  const rename = f.renameFile.getMockImplementation()!
  f.renameFile.mockImplementation(async (file, target) => {
    guards.push([importFileOperationActive(f.plugin, file.path), importFileOperationActive(f.plugin, target)])
    await rename(file, target)
    // A vault rename event fires inside this operation. The lifecycle hook
    // would auto-create a new share only when the operation guard is absent.
    if (!importFileOperationActive(f.plugin, target)) autoCreateEchoes.push(target)
  })
  await resume(folder)
  expect(document.path).toBe('Shared/new.md')
  expect(document.file).toBe(file)
  expect(file.path).toBe('Shared/new.md')
  expect(f.contents.has('Shared/old.md')).toBe(false)
  expect(f.contents.get('Shared/new.md')).toBe('Owned offline edits')
  expect(f.settings.serverShares.files.get('Shared/new.md')).toEqual({ shareId: 'child', persistenceId: 'child-db' })
  expect(f.settings.serverShares.files.has('Shared/old.md')).toBe(false)
  expect(f.settings.folderImports?.folder).toBeUndefined()
  expect(f.plugin.serverSync.requestDocumentSnapshot).not.toHaveBeenCalled()
  expect(guards).toEqual([[true, true]])
  expect(autoCreateEchoes).toEqual([])
  expect(importFileOperationActive(f.plugin, 'Shared/old.md')).toBe(false)
  expect(importFileOperationActive(f.plugin, 'Shared/new.md')).toBe(false)
  f.cleanup()
})

it('preserves a separately active same-ID document when resuming a new folder import and keeps the conflict visible', async () => {
  const f = fixture()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  const folder = f.folder('folder', 'Shared', { child: 'note.md' })
  Reflect.set(folder, '_initializationGuardPassed', true)
  const externalFile = await f.create('Other/note.md', 'Independent offline edits')
  const externalDocument = f.document('child', externalFile.path)
  const externalRegistration = { shareId: 'child', persistenceId: 'external-db' }
  f.settings.serverShares.files.set(externalFile.path, externalRegistration)
  expect(f.settings.folderImports?.folder).toBeUndefined()
  jest.useFakeTimers()
  try {
    await resume(folder)
    expect(f.renameFile).not.toHaveBeenCalled()
    expect(f.contents.get('Other/note.md')).toBe('Independent offline edits')
    expect(f.files.get('Other/note.md')).toBe(externalFile)
    expect(externalDocument.path).toBe('Other/note.md')
    expect(externalDocument.file).toBe(externalFile)
    expect(f.documents.get('child')).toBe(externalDocument)
    expect(Array.from(f.settings.serverShares.files.entries())).toEqual([['Other/note.md', externalRegistration]])
    expect(f.contents.has('Shared/note.md')).toBe(false)
    expect(f.files.has('Shared/note.md')).toBe(false)
    expect(f.settings.folderImports?.folder.documents.child).toEqual({ path: 'Shared/note.md' })
    expect(folder.getSyncStatus()).toBe('warning')
    jest.advanceTimersByTime(100)
    const notice = Reflect.get(folder, '_importNotice') as { setMessage: jest.Mock }
    expect(notice.setMessage).toHaveBeenCalledWith(expect.stringContaining('some files need retry'))
    expect(f.plugin.serverSync.requestDocumentSnapshot).not.toHaveBeenCalled()
  } finally { f.cleanup(); jest.useRealTimers() }
})

it.each(['update', 'delete'])('preserves a separately active same-ID document after a remote folder entry %s', async mode => {
  const f = fixture()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  const folder = f.folder('folder', 'Shared', { child: 'old.md' })
  const externalFile = await f.create('Other/note.md', 'Independent offline edits')
  const externalDocument = f.document('child', externalFile.path)
  const externalRegistration = { shareId: 'child', persistenceId: 'external-db' }
  f.settings.serverShares.files.set(externalFile.path, externalRegistration)
  folder.yDoc.transact(() => {
    if (mode === 'update') folder.getDocsFragment().set('child', 'new.md')
    else folder.getDocsFragment().delete('child')
  }, f.plugin.serverSync)
  await nextTurn()
  await folderImportQueue(f.plugin).idle()
  expect(f.renameFile).not.toHaveBeenCalled()
  expect(f.files.get('Other/note.md')).toBe(externalFile)
  expect(f.contents.get('Other/note.md')).toBe('Independent offline edits')
  expect(externalDocument.path).toBe('Other/note.md')
  expect(f.documents.get('child')).toBe(externalDocument)
  expect(Array.from(f.settings.serverShares.files.entries())).toEqual([['Other/note.md', externalRegistration]])
  expect(f.files.has('Shared/old.md')).toBe(false)
  expect(f.files.has('Shared/new.md')).toBe(false)
  expect(f.plugin.serverSync.requestDocumentSnapshot).not.toHaveBeenCalled()
  f.cleanup()
})

it('serializes rapid A to B to C recovery and rechecks the latest manifest after directory creation', async () => {
  const f = fixture()
  const folder = f.folder('folder', 'Shared', { child: 'A/note.md' })
  const file = await f.create('Shared/A/note.md', 'Owned offline edits')
  const document = f.document('child', file.path)
  f.settings.serverShares.files.set(file.path, { shareId: 'child', persistenceId: 'child-db', importedFrom: 'folder' })
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: {
    child: { path: file.path, materialized: true },
  } } }
  const enteredB = deferred()
  const releaseB = deferred()
  const createFolder = f.plugin.app.vault.createFolder.bind(f.plugin.app.vault)
  jest.spyOn(f.plugin.app.vault, 'createFolder').mockImplementation(async path => {
    if (path === 'Shared/B') { enteredB.resolve(); await releaseB.promise }
    return createFolder(path)
  })
  folder.yDoc.transact(() => folder.getDocsFragment().set('child', 'B/note.md'), 'test')
  const recoveringB = folder.recoverChangedImport('child', 'A/note.md', 'B/note.md', false)
  await enteredB.promise
  folder.yDoc.transact(() => folder.getDocsFragment().set('child', 'C/note.md'), 'test')
  const recoveringC = folder.recoverChangedImport('child', 'B/note.md', 'C/note.md', false)
  releaseB.resolve()
  await Promise.all([recoveringB, recoveringC])
  await resume(folder)
  expect(f.renameFile.mock.calls.map(([_file, target]) => target)).toEqual(['Shared/C/note.md'])
  expect(f.contents.get('Shared/C/note.md')).toBe('Owned offline edits')
  expect(f.contents.has('Shared/A/note.md')).toBe(false)
  expect(f.contents.has('Shared/B/note.md')).toBe(false)
  expect(document.path).toBe('Shared/C/note.md')
  expect(Array.from(f.settings.serverShares.files.entries())).toEqual([
    ['Shared/C/note.md', { shareId: 'child', persistenceId: 'child-db', importedFrom: 'folder' }],
  ])
  expect(f.settings.folderImports?.folder).toBeUndefined()
  f.cleanup()
})

it('resuming a parent import retains unrelated and nested shares that are absent from its manifest', async () => {
  const f = fixture()
  const folder = f.folder('parent', 'Shared', { imported: 'imported.md' })
  f.folder('nested-folder', 'Shared/Nested', { nested: 'nested.md' })
  await f.create('Shared/local.md', 'Independent share content')
  await f.create('Shared/Nested/nested.md', 'Nested share content')
  await f.create('Shared/previously-imported.md', 'Deleted parent member')
  const independent = f.document('independent', 'Shared/local.md')
  const nested = f.document('nested', 'Shared/Nested/nested.md')
  const removed = f.document('removed', 'Shared/previously-imported.md')
  f.settings.serverShares.files.set(independent.path, { shareId: 'independent', persistenceId: 'independent-db' })
  f.settings.serverShares.files.set(nested.path, { shareId: 'nested', persistenceId: 'nested-db', importedFrom: 'nested-folder' })
  f.settings.serverShares.files.set(removed.path, { shareId: 'removed', persistenceId: 'removed-db', importedFrom: 'parent' })
  await resume(folder)
  expect(f.contents.get('Shared/local.md')).toBe('Independent share content')
  expect(f.contents.get('Shared/Nested/nested.md')).toBe('Nested share content')
  expect(f.documents.get('independent')).toBe(independent)
  expect(f.documents.get('nested')).toBe(nested)
  expect(f.settings.serverShares.files.get(independent.path)?.shareId).toBe('independent')
  expect(f.settings.serverShares.files.get(nested.path)?.shareId).toBe('nested')
  expect(f.contents.has('Shared/previously-imported.md')).toBe(false)
  expect(f.documents.has('removed')).toBe(false)
  expect(f.settings.serverShares.files.has('Shared/previously-imported.md')).toBe(false)
  expect(f.contents.get('Shared/imported.md')).toBe('Remote content for imported')
  expect(f.settings.folderImports?.parent).toBeUndefined()
  f.cleanup()
})

it('cleans a completed parent import tombstone with an empty manifest and no journal while retaining unrelated shares', async () => {
  const f = fixture()
  const folder = f.folder('parent', 'Shared', {})
  await f.create('Shared/removed.md', 'Previously imported parent member')
  await f.create('Shared/independent.md', 'Independent share')
  await f.create('Shared/Nested/nested.md', 'Nested share')
  f.document('removed', 'Shared/removed.md')
  const independent = f.document('independent', 'Shared/independent.md')
  const nested = f.document('nested', 'Shared/Nested/nested.md')
  f.settings.serverShares.files.set('Shared/removed.md', {
    shareId: 'removed', persistenceId: 'removed-db', importedFrom: 'parent', importedComplete: true,
  })
  f.settings.serverShares.files.set(independent.path, { shareId: 'independent', persistenceId: 'independent-db' })
  f.settings.serverShares.files.set(nested.path, { shareId: 'nested', persistenceId: 'nested-db', importedFrom: 'nested-parent' })
  expect(f.settings.folderImports?.parent).toBeUndefined()

  await resume(folder)

  expect(f.files.has('Shared/removed.md')).toBe(false)
  expect(f.contents.has('Shared/removed.md')).toBe(false)
  expect(f.settings.serverShares.files.has('Shared/removed.md')).toBe(false)
  expect(f.documents.has('removed')).toBe(false)
  expect(f.contents.get(independent.path)).toBe('Independent share')
  expect(f.contents.get(nested.path)).toBe('Nested share')
  expect(f.documents.get('independent')).toBe(independent)
  expect(f.documents.get('nested')).toBe(nested)
  expect(f.settings.serverShares.files.get(independent.path)?.shareId).toBe('independent')
  expect(f.settings.serverShares.files.get(nested.path)?.shareId).toBe('nested')
  expect(f.settings.folderImports?.parent).toBeUndefined()
  expect(f.plugin.serverSync.requestDocumentSnapshot).not.toHaveBeenCalled()
  f.cleanup()
})

it.each(['destroy', 'delete'])('does not move an unrelated local file if the import is cancelled by %s during the ownership read', async mode => {
  const f = fixture()
  const folder = f.folder('folder', 'Shared', { child: 'note.md' })
  const file = await f.create('Shared/note.md', 'Unrelated user content')
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: {
    child: { path: file.path, contentHash: await textSha256('Different previously imported content'), materialized: false },
  } } }
  const enteredRead = deferred()
  const finishRead = deferred()
  jest.spyOn(f.plugin.app.vault, 'read').mockImplementation(async () => {
    enteredRead.resolve()
    await finishRead.promise
    return 'Unrelated user content'
  })
  const importing = folder.queueDocumentImport('child')
  await enteredRead.promise
  if (mode === 'destroy') folder.destroy()
  else folder.yDoc.transact(() => folder.getDocsFragment().delete('child'), 'test')
  finishRead.resolve()
  await importing
  expect(f.renameFile).not.toHaveBeenCalled()
  expect(f.contents.get('Shared/note.md')).toBe('Unrelated user content')
  expect(f.contents.has('Shared/note_conflict.md')).toBe(false)
  expect(f.plugin.serverSync.requestDocumentSnapshot).not.toHaveBeenCalled()
  expect(f.settings.serverShares.files.size).toBe(0)
  f.cleanup()
})

it('resumes cancelled imports at a renamed local root after the original eight downloads finish', async () => {
  const f = fixture()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  const manifest = Object.fromEntries(Array.from({ length: 12 }, (_entry, index) => ['doc-' + index, index + '.md']))
  const folder = f.folder('folder', 'Shared', manifest)
  for (const id of Object.keys(manifest)) f.downloads.set(id, deferred())
  const importing = resume(folder)
  await nextTurn()
  expect(f.started).toHaveLength(8)
  await f.create('Shared/local.md', 'Unshared local note')
  // Obsidian updates the root and every contained TFile path before delivering
  // the folder rename event to setNewFolderLocation.
  for (const [oldPath, file] of Array.from(f.files)) {
    if (oldPath !== 'Shared' && !oldPath.startsWith('Shared/')) continue
    const nextPath = 'Moved' + oldPath.slice('Shared'.length)
    const content = f.contents.get(oldPath)
    f.files.delete(oldPath)
    f.contents.delete(oldPath)
    file.path = nextPath
    f.files.set(nextPath, file)
    if (content !== undefined) f.contents.set(nextPath, content)
  }
  const moving = folder.setNewFolderLocation(folder.root)
  for (const gate of f.downloads.values()) gate.resolve()
  await Promise.all([importing, moving])
  await folderImportQueue(f.plugin).idle()
  expect(folder.path).toBe('Moved')
  expect(f.maximum()).toBe(8)
  for (const [id, relative] of Object.entries(manifest)) {
    expect(f.contents.get('Moved/' + relative)).toBe('Remote content for ' + id)
    expect(f.settings.serverShares.files.get('Moved/' + relative)?.shareId).toBe(id)
    expect(f.contents.has('Shared/' + relative)).toBe(false)
  }
  expect(f.contents.get('Moved/local.md')).toBe('Unshared local note')
  expect(f.settings.folderImports?.folder).toBeUndefined()
  expect(f.documents.size).toBe(12)
  f.cleanup()
})

it('reference-counts nested import file operations and clears only the failed inner scope', async () => {
  const f = fixture()
  const otherPlugin = {} as PeerdraftPlugin
  const failure = new Error('Rename failed')
  const result = await withImportFileOperation(f.plugin, ['old.md', 'shared.md'], async () => {
    expect(importFileOperationActive(f.plugin, 'old.md')).toBe(true)
    expect(importFileOperationActive(f.plugin, 'shared.md')).toBe(true)
    expect(importFileOperationActive(otherPlugin, 'shared.md')).toBe(false)
    await expect(withImportFileOperation(f.plugin, ['shared.md', 'shared.md', 'inner.md'], async () => {
      expect(importFileOperationActive(f.plugin, 'old.md')).toBe(true)
      expect(importFileOperationActive(f.plugin, 'shared.md')).toBe(true)
      expect(importFileOperationActive(f.plugin, 'inner.md')).toBe(true)
      throw failure
    })).rejects.toBe(failure)
    expect(importFileOperationActive(f.plugin, 'inner.md')).toBe(false)
    expect(importFileOperationActive(f.plugin, 'old.md')).toBe(true)
    expect(importFileOperationActive(f.plugin, 'shared.md')).toBe(true)
    return 'outer completed'
  })
  expect(result).toBe('outer completed')
  expect(importFileOperationActive(f.plugin, 'old.md')).toBe(false)
  expect(importFileOperationActive(f.plugin, 'shared.md')).toBe(false)
  await expect(withImportFileOperation(f.plugin, ['failed.md'], async () => { throw failure })).rejects.toBe(failure)
  expect(importFileOperationActive(f.plugin, 'failed.md')).toBe(false)
  f.cleanup()
})

it('preserves unrelated local content as a conflict copy before importing the remote file', async () => {
  const f = fixture()
  const folder = f.folder('folder', 'Shared', { child: 'note.md' })
  f.files.set('Shared/note.md', Object.assign(new TFile(), { path: 'Shared/note.md' }))
  f.contents.set('Shared/note.md', 'My existing local note')
  await resume(folder)
  expect(f.contents.get('Shared/note_conflict.md')).toBe('My existing local note')
  expect(f.contents.get('Shared/note.md')).toBe('Remote content for child')
  expect(jest.mocked(SharedDocument.fromIdAndPath).mock.calls[0][3]?.allowExistingFile).toBe(false)
  expect(f.settings.folderImports?.folder).toBeUndefined()
  f.cleanup()
})

it('does not create files or start queued factories after the folder is destroyed', async () => {
  const f = fixture()
  const manifest = Object.fromEntries(Array.from({ length: 12 }, (_entry, index) => ['doc-' + index, index + '.md']))
  const folder = f.folder('folder', 'Shared', manifest)
  for (const id of Object.keys(manifest)) f.downloads.set(id, deferred())
  const jobs = Object.keys(manifest).map(id => folder.queueDocumentImport(id))
  expect(f.started).toHaveLength(8)
  folder.destroy()
  for (const gate of f.downloads.values()) gate.resolve()
  await Promise.all(jobs)
  expect(f.started).toHaveLength(8)
  expect(f.create).not.toHaveBeenCalled()
  expect(f.settings.serverShares.files.size).toBe(0)
  f.cleanup()
})

it.each(['rename', 'delete'])('cancels stale download materialization after a concurrent manifest %s', async mode => {
  const f = fixture()
  const folder = f.folder('folder', 'Shared', { child: 'old.md' })
  const download = deferred()
  f.downloads.set('child', download)
  const pending = folder.queueDocumentImport('child')
  folder.yDoc.transact(() => {
    if (mode === 'rename') folder.getDocsFragment().set('child', 'new.md')
    else folder.getDocsFragment().delete('child')
  }, f.plugin.serverSync)
  download.resolve()
  await pending
  await nextTurn()
  await folderImportQueue(f.plugin).idle()
  expect(f.contents.has('Shared/old.md')).toBe(false)
  expect(f.contents.get('Shared/new.md')).toBe(mode === 'rename' ? 'Remote content for child' : undefined)
  expect(f.settings.serverShares.files.has('Shared/old.md')).toBe(false)
  f.cleanup()
})

it.each(['../outside.md', '/outside.md', 'nested/../../outside.md', 'C:/outside.md', 'nested\\outside.md', './note.md', 'a//note.md', 'note\u0000.md', ''])('rejects unsafe manifest path %p before constructing a local target', relative => {
  expect(() => importedFilePath('Shared', relative)).toThrow('Invalid document path')
})

it('keeps valid nested import paths under the selected root', () => {
  expect(importedFilePath('Shared/', 'Nested/Good note.md')).toBe('Shared/Nested/Good note.md')
})
