import type { Settings } from '../settings'

jest.mock('../peerdraftPlugin', () => ({ __esModule: true, default: class {} }))
jest.mock('../ui', () => ({ showNotice: jest.fn(), showTextModal: jest.fn() }))
jest.mock('../ui/selectFolder', () => ({ promptForFolderSelection: jest.fn() }))
jest.mock('../ui/login', () => ({ openLoginModal: jest.fn() }))
jest.mock('../login', () => ({ getJWT: jest.fn(), logout: jest.fn() }))
jest.mock('../tools', () => ({ createRandomId: () => 'fresh-copy-oid' }))
jest.mock('../ui/confirmVaultIdentity', () => ({ confirmVaultCopied: jest.fn() }))
jest.mock('../permanentShareStore', () => ({
  PermanentShareStoreIndexedDB: jest.fn().mockImplementation(() => ({
    getAllDocs: async () => [], getAllFolders: async () => [], deleteDB: async () => undefined
  }))
}))
jest.mock('obsidian', () => ({
  PluginSettingTab: class {}, debounce: (fn: unknown) => fn,
  normalizePath: (path: string) => path
}), { virtual: true })

// The production bundle defines this constant; the tests exercise migration directly.
Object.assign(globalThis, { PEERDRAFT_DEV_SERVER_URL: 'https://www.peerdraft.app' })
const { migrateSettings } = require('../settings') as typeof import('../settings')
const { confirmVaultCopied } = require('../ui/confirmVaultIdentity') as typeof import('../ui/confirmVaultIdentity')
const confirm = jest.mocked(confirmVaultCopied)

function fixture(storedPath: string | undefined, currentPath: string | undefined) {
  let persisted: unknown = {
    oid: 'original-oid', oidVaultPath: storedPath, version: '2.23.3',
    serverShares: {
      files: [['note.md', { persistenceId: 'file-db', shareId: 'file-share' }]],
      folders: [['folder', { persistenceId: 'folder-db', shareId: 'folder-share' }]]
    }
  }
  const plugin = {
    app: { appId: 'app-id', vault: { adapter: currentPath ? { getBasePath: () => currentPath } : {} } },
    manifest: { version: '2.23.3' },
    loadData: async () => JSON.parse(JSON.stringify(persisted)),
    saveData: jest.fn(async (data: unknown) => { persisted = data })
  }
  return { plugin: plugin as unknown as Parameters<typeof migrateSettings>[0],
    persisted: () => persisted as Settings }
}

beforeAll(() => { String.prototype.contains = String.prototype.includes })
beforeEach(() => { confirm.mockReset() })

it('holds startup until the mismatch choice; a copy gets new identity and empty registries, also after reload', async () => {
  const f = fixture('/vault/original', '/vault/copy')
  let choose!: (answer: { copied: boolean }) => void
  confirm.mockImplementation(() => new Promise(resolve => { choose = resolve }))
  let loaded = false
  const pending = migrateSettings(f.plugin).then(settings => { loaded = true; return settings })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(loaded).toBe(false)
  expect(confirm).toHaveBeenCalledWith(f.plugin.app, '/vault/original', '/vault/copy')
  choose({ copied: true })
  const settings = await pending
  expect(settings.oid).toBe('fresh-copy-oid')
  expect([...settings.serverShares.files]).toEqual([])
  expect([...settings.serverShares.folders]).toEqual([])
  expect(f.persisted().oidVaultPath).toBe('/vault/copy')
  const reloaded = await migrateSettings(f.plugin)
  expect(reloaded.oid).toBe('fresh-copy-oid')
  expect(reloaded.serverShares.files.size + reloaded.serverShares.folders.size).toBe(0)
  expect(confirm).toHaveBeenCalledTimes(1)
})

it.each([{ copied: false }, undefined])('a move or dismissal preserves identity and both share claims (%p)', async answer => {
  const f = fixture('/vault/old', '/vault/new')
  confirm.mockResolvedValue(answer)
  const settings = await migrateSettings(f.plugin)
  expect(settings.oid).toBe('original-oid')
  expect(settings.serverShares.files.get('note.md')?.shareId).toBe('file-share')
  expect(settings.serverShares.folders.get('folder')?.shareId).toBe('folder-share')
  expect(f.persisted().oidVaultPath).toBe('/vault/new')
  await migrateSettings(f.plugin)
  expect(confirm).toHaveBeenCalledTimes(1)
})

it.each([undefined, '/vault/current'])('first observation or unchanged vault preserves existing claims (%p)', async stored => {
  const f = fixture(stored, '/vault/current')
  const settings = await migrateSettings(f.plugin)
  expect(settings.oid).toBe('original-oid')
  expect(settings.serverShares.files.size).toBe(1)
  expect(settings.serverShares.folders.size).toBe(1)
  expect(f.persisted().oidVaultPath).toBe('/vault/current')
  expect(confirm).not.toHaveBeenCalled()
})

it('an adapter without getBasePath preserves the existing identity', async () => {
  const f = fixture('/vault/old', undefined)
  const settings = await migrateSettings(f.plugin)
  expect(settings.oid).toBe('original-oid')
  expect(settings.oidVaultPath).toBe('/vault/old')
  expect(settings.serverShares.files.size).toBe(1)
  expect(confirm).not.toHaveBeenCalled()
})
