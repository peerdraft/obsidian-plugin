import type { Settings } from '../settings'
import type PeerdraftPlugin from '../peerdraftPlugin'

jest.mock('../peerdraftPlugin', () => ({ __esModule: true, default: class {} }))
jest.mock('../ui', () => ({ showNotice: jest.fn(), showTextModal: jest.fn() }))
jest.mock('../ui/selectFolder', () => ({ promptForFolderSelection: jest.fn() }))
jest.mock('../ui/login', () => ({ openLoginModal: jest.fn() }))
jest.mock('../login', () => ({ getJWT: jest.fn(), logout: jest.fn() }))
jest.mock('../tools', () => ({ createRandomId: () => 'unused' }))
jest.mock('../ui/confirmVaultIdentity', () => ({ confirmVaultCopied: jest.fn() }))
jest.mock('../permanentShareStore', () => ({ PermanentShareStoreIndexedDB: class {} }))
jest.mock('obsidian', () => ({
  PluginSettingTab: class {}, debounce: (fn: unknown) => fn,
  normalizePath: (path: string) => path,
}), { virtual: true })

Object.assign(globalThis, { PEERDRAFT_DEV_SERVER_URL: 'https://www.peerdraft.app' })
const { getSettings, saveSettingsNow } = require('../settings') as typeof import('../settings')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

function fixture() {
  const settings = {
    oid: 'vault',
    serverShares: {
      files: new Map([['Shared/first.md', { shareId: 'first', persistenceId: 'first-db' }]]),
      folders: new Map([['Shared', { shareId: 'folder', persistenceId: 'folder-db' }]]),
    },
    restartCheckpoints: {},
    folderImports: {},
  } as unknown as Settings
  let disk: unknown
  const writes: unknown[] = []
  const saveData = jest.fn(async (data: unknown): Promise<void> => {
    writes.push(data)
    disk = JSON.parse(JSON.stringify(data))
  })
  const plugin = {
    saveData,
    loadData: async (): Promise<unknown> => JSON.parse(JSON.stringify(disk)),
  } as unknown as PeerdraftPlugin
  return { settings, plugin, saveData, writes, disk: (): unknown => disk }
}

it('coalesces simultaneous saves into the latest durable snapshot and round-trips both Map registries', async () => {
  const f = fixture()
  const first = saveSettingsNow(f.settings, f.plugin)
  f.settings.serverShares.files.set('Shared/second.md', { shareId: 'second', persistenceId: 'second-db' })
  f.settings.serverShares.folders.set('Other', { shareId: 'other', persistenceId: 'other-db' })
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: { second: { path: 'Shared/second.md' } } } }
  const second = saveSettingsNow(f.settings, f.plugin)
  await Promise.all([first, second])

  expect(f.writes).toHaveLength(1)
  expect(f.disk()).toEqual({
    oid: 'vault', restartCheckpoints: {}, folderImports: f.settings.folderImports,
    serverShares: {
      files: Array.from(f.settings.serverShares.files),
      folders: Array.from(f.settings.serverShares.folders),
    },
  })
  const restored = await getSettings(f.plugin)
  expect(restored.serverShares.files).toEqual(f.settings.serverShares.files)
  expect(restored.serverShares.folders).toEqual(f.settings.serverShares.folders)
  expect(f.settings.serverShares.files).toBeInstanceOf(Map)
  expect(f.settings.serverShares.folders).toBeInstanceOf(Map)
})

it('serializes delayed old writes before the newest checkpoint and journal without resolving newer callers early', async () => {
  const f = fixture()
  const oldWrite = deferred()
  let disk: unknown
  const stored: unknown[] = []
  f.saveData.mockImplementation(async (data: unknown): Promise<void> => {
    stored.push(data)
    if (stored.length === 1) await oldWrite.promise
    disk = JSON.parse(JSON.stringify(data))
  })
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: { first: { path: 'Shared/first.md' } } } }
  const first = saveSettingsNow(f.settings, f.plugin)
  await Promise.resolve()
  expect(stored).toHaveLength(1)
  f.settings.restartCheckpoints = { first: {
    schema: 1, checkpoint: 'new-checkpoint', stateHash: 'state-hash', contentHash: 'content-hash',
    scope: 'vault', persistenceId: 'first-db',
  } }
  f.settings.folderImports.folder.documents.first.materialized = true
  const second = saveSettingsNow(f.settings, f.plugin)
  delete f.settings.folderImports.folder.documents.first
  let newestComplete = false
  const newest = saveSettingsNow(f.settings, f.plugin).then(() => { newestComplete = true })
  await Promise.resolve()
  expect(stored).toHaveLength(1)
  expect(newestComplete).toBe(false)
  expect((stored[0] as Settings).restartCheckpoints).toEqual({})
  expect((stored[0] as Settings).folderImports?.folder.documents.first).toEqual({ path: 'Shared/first.md' })

  oldWrite.resolve()
  await Promise.all([first, second, newest])
  expect(stored).toHaveLength(2)
  expect(disk).toEqual(stored[1])
  expect((disk as Settings).restartCheckpoints?.first.checkpoint).toBe('new-checkpoint')
  expect((disk as Settings).folderImports?.folder.documents).toEqual({})
  expect(newestComplete).toBe(true)
})

it('rejects callers on a failed write and persists subsequent mutations on a later save', async () => {
  const f = fixture()
  const failure = new Error('Vault temporarily read-only')
  f.saveData.mockRejectedValueOnce(failure)
  await expect(saveSettingsNow(f.settings, f.plugin)).rejects.toBe(failure)
  f.settings.folderImports = { folder: { path: 'Shared', startedAt: 1, documents: { first: { path: 'Shared/first.md' } } } }
  await saveSettingsNow(f.settings, f.plugin)
  expect((f.disk() as Settings).folderImports).toEqual(f.settings.folderImports)
  expect(f.saveData).toHaveBeenCalledTimes(2)
})
