import type { Menu, TAbstractFile } from 'obsidian'
import { TFile, TFolder } from 'obsidian'
import * as Y from 'yjs'
import type PeerdraftPlugin from '../peerdraftPlugin'
import { createMenu } from '../ui/createMenu'

type SavedShare = { shareId: string; persistenceId: string }
type Action = { title: string; disabled: boolean; click: () => void | Promise<void> }
type LiveDocument = { shareId: string; file: { basename: string }; unshare: () => Promise<void> }
type LiveFolder = { shareId: string; root: { path: string }; yDoc: Y.Doc; unshare: () => Promise<void>; removeDocument: () => void }
const mockDocuments = new Map<string, LiveDocument>()
const mockFolders = new Map<string, LiveFolder>()
const effects: string[] = []

jest.mock('src/peerdraftPlugin', () => ({ __esModule: true, default: class {} }))
jest.mock('src/sharedEntities/sharedDocument', () => ({ SharedDocument: {
  findByPath: (path: string) => mockDocuments.get(path),
  stopSession: async (id: string) => { effects.push('stop-document:' + id) },
} }))
jest.mock('src/sharedEntities/sharedFolder', () => ({ SharedFolder: {
  findByPath: (path: string) => mockFolders.get(path),
  getSharedFolderForSubPath: (path: string) => [...mockFolders.values()].find(folder =>
    path === folder.root.path || path.startsWith(folder.root.path + '/')),
  recreate: async (folder: LiveFolder) => { effects.push('recreate:' + folder.shareId) },
  stopSession: async (id: string) => { effects.push('stop-folder:' + id) },
  fromTFolder: async () => { effects.push('share-folder') },
} }))
jest.mock('../ui/folderOptions', () => ({ openFolderOptions: () => { effects.push('folder-options') } }))
jest.mock('../ui/chooseSessionType', () => ({ promptForSessionType: async () => undefined }))
jest.mock('src/ui', () => ({ openFileInNewTab: jest.fn(), showNotice: jest.fn() }))
jest.mock('obsidian', () => ({
  TFile: class { constructor(public path: string, public extension = 'md') {} },
  TFolder: class { constructor(public path: string) {} },
  normalizePath: (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, ''),
}), { virtual: true })

const savedFiles = new Map<string, SavedShare>()
const savedFolders = new Map<string, SavedShare>()
let copied = ''
let deletedPath: string | undefined
const plugin = {
  settings: { basePath: 'https://example.test', serverShares: { files: savedFiles, folders: savedFolders } },
  app: { vault: { delete: async (file: { path: string }) => { deletedPath = file.path } } },
} as unknown as PeerdraftPlugin

function file(path: string, extension = 'md'): TAbstractFile {
  return new (TFile as unknown as new (path: string, extension: string) => TAbstractFile)(path, extension)
}
function folder(path: string): TAbstractFile {
  return new (TFolder as unknown as new (path: string) => TAbstractFile)(path)
}
function saved(shareId: string): SavedShare { return { shareId, persistenceId: 'cache-' + shareId } }
function actions(target: TAbstractFile, prefix = ''): Action[] {
  const entries: Action[] = []
  const menu = { addItem: (configure: (item: unknown) => void) => {
    const entry: Action = { title: '', disabled: false, click: () => {} }
    const item = {
      setTitle: (value: string) => { entry.title = value; return item },
      setIcon: () => item,
      setDisabled: (value: boolean) => { entry.disabled = value; return item },
      onClick: (callback: Action['click']) => { entry.click = callback; return item },
    }
    configure(item)
    entries.push(entry)
    return menu
  } }
  createMenu(menu as unknown as Menu, target, plugin, prefix)
  return entries
}
function state(entries: Action[]): Array<[string, boolean]> { return entries.map(entry => [entry.title, entry.disabled]) }
function liveFolder(path: string, shareId = 'live-folder'): LiveFolder {
  const live: LiveFolder = {
    shareId, root: { path }, yDoc: new Y.Doc(),
    unshare: async () => { mockFolders.delete(path); savedFolders.delete(path) },
    removeDocument: () => { effects.push('remove-document') },
  }
  mockFolders.set(path, live)
  return live
}
function liveDocument(path: string, shareId = 'live-document'): LiveDocument {
  const live: LiveDocument = {
    shareId, file: { basename: 'note' },
    unshare: async () => { mockDocuments.delete(path); savedFiles.delete(path) },
  }
  mockDocuments.set(path, live)
  return live
}

beforeEach(() => {
  mockDocuments.clear(); mockFolders.clear(); savedFiles.clear(); savedFolders.clear()
  effects.length = 0; copied = ''; deletedPath = undefined
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { copied = text },
  } })
})
afterEach(() => { for (const live of mockFolders.values()) live.yDoc.destroy() })

describe('saved-share context menus during startup', () => {
  test('pending folder keeps its normal actions and copies its saved URL without a live model', async () => {
    savedFolders.set('Team', saved('saved-folder'))
    const entries = actions(folder('Team'))
    expect(state(entries)).toEqual([
      ['Copy URL', false], ['Re-create folder from server', true], ['Stop syncing with this vault', true],
      ['Stop syncing for everyone', true], ['Show folder options', true],
    ])
    await entries[0].click()
    expect(copied).toBe('https://example.test/team/saved-folder')
    // Even an invocation outside Obsidian's disabled-item guard cannot mutate a pending share.
    for (const entry of entries.slice(1)) await entry.click()
    expect([...savedFolders.keys()]).toEqual(['Team'])
    expect(effects).toEqual([])
  })

  test('pending standalone document preserves mobile prefixes and copies its saved URL', async () => {
    savedFiles.set('note.MD', saved('saved-document'))
    const entries = actions(file('note.MD', 'MD'), 'Peerdraft: ')
    expect(state(entries)).toEqual([
      ['Peerdraft: Copy URL', false], ['Peerdraft: Stop syncing with this vault', true],
      ['Peerdraft: Stop syncing for everyone', true],
    ])
    for (const entry of entries) await entry.click()
    expect(copied).toBe('https://example.test/cm/saved-document')
    expect([...savedFiles.keys()]).toEqual(['note.MD'])
    expect(effects).toEqual([])
  })

  test.each([false, true])('document remains a folder member before parent restoration (live document=%s)', async hasDocument => {
    savedFolders.set('Team', saved('saved-folder'))
    savedFiles.set('Team/note.md', saved('saved-document'))
    if (hasDocument) liveDocument('Team/note.md')
    const entries = actions(file('Team/note.md'))
    expect(state(entries)).toEqual([['Copy URL', false], ['Delete and remove from Shared Folder', true]])
    await entries[0].click()
    await entries[1].click()
    expect(copied).toBe('https://example.test/cm/' + (hasDocument ? 'live-document' : 'saved-document'))
    expect(savedFiles.has('Team/note.md')).toBe(true)
    expect(deletedPath).toBeUndefined()
    expect(effects).toEqual([])
  })

  test('a restored parent cannot enable deletion before the document model exists', () => {
    liveFolder('Team')
    savedFiles.set('Team/note.md', saved('saved-document'))
    expect(state(actions(file('Team/note.md')))).toEqual([
      ['Copy URL', false], ['Delete and remove from Shared Folder', true],
    ])
  })

  test('restored folder uses its live identity and keeps the existing local unshare action', async () => {
    savedFolders.set('Team', saved('stale-folder'))
    const live = liveFolder('Team')
    const entries = actions(folder('Team'))
    expect(entries.every(entry => !entry.disabled)).toBe(true)
    await entries[0].click()
    expect(copied).toBe('https://example.test/team/live-folder')
    await entries.find(entry => entry.title === 'Stop syncing with this vault')!.click()
    expect(state(actions(folder('Team')))).toEqual([['Share Folder', false]])
    live.yDoc.destroy()
  })

  test('existing temporary document remains usable without a saved registration', async () => {
    liveDocument('note.md')
    const entries = actions(file('note.md'))
    expect(state(entries)).toEqual([
      ['Copy URL', false], ['Stop syncing with this vault', false], ['Stop syncing for everyone', false],
    ])
    await entries[0].click()
    expect(copied).toBe('https://example.test/cm/live-document')
    await entries[1].click()
    expect(state(actions(file('note.md')))).toEqual([['Share File', false]])
  })

  test('a newly created runtime document awaiting its ID does not offer duplicate sharing', () => {
    liveDocument('note.md', '')
    expect(actions(file('note.md'))).toEqual([])
  })

  test('restored document and parent retain their existing delete action', () => {
    liveFolder('Team'); liveDocument('Team/note.md')
    expect(state(actions(file('Team/note.md')))).toEqual([
      ['Copy URL', false], ['Delete and remove from Shared Folder', false],
    ])
  })

  test('descendant folders cannot offer nested sharing while the saved root is pending', () => {
    savedFolders.set('Team', saved('saved-folder'))
    expect(actions(folder('Team/Nested'))).toEqual([])
  })

  test.each(['md', 'canvas', 'png'])('unknown %s files inside a pending saved folder do not invent share actions or URLs', extension => {
    savedFolders.set('Team', saved('saved-folder'))
    expect(actions(file(`Team/unknown.${extension}`, extension))).toEqual([])
  })

  test('saved membership matches full path segments instead of similar sibling names', () => {
    savedFolders.set('Team', saved('saved-folder'))
    expect(state(actions(folder('Teamwork')))).toEqual([['Share Folder', false]])
    expect(state(actions(file('Teamwork/note.md')))).toEqual([['Share File', false]])
  })

  test.each(['', '/'])('a saved vault-root share (%p) prevents duplicate descendant sharing', root => {
    savedFolders.set(root, saved('saved-root'))
    savedFiles.set('note.md', saved('saved-document'))
    expect(state(actions(file('note.md')))).toEqual([
      ['Copy URL', false], ['Delete and remove from Shared Folder', true],
    ])
    expect(actions(folder('Nested'))).toEqual([])
  })

  test('saved document lookup and parent membership normalize vault paths', async () => {
    savedFolders.set('Team', saved('saved-folder'))
    savedFiles.set('Team/Nested/note.md', saved('saved-document'))
    const entries = actions(file('Team\\Nested\\note.md'))
    expect(state(entries)).toEqual([['Copy URL', false], ['Delete and remove from Shared Folder', true]])
    await entries[0].click()
    expect(copied).toBe('https://example.test/cm/saved-document')
  })

  test('a known binary retains removal through the restored parent', async () => {
    const live = liveFolder('Team')
    live.yDoc.getMap('binaryFiles').set('image.png', { id: 'binary' })
    const entries = actions(file('Team/image.png', 'png'))
    expect(state(entries)).toEqual([['Delete and remove from Shared Folder', false]])
    await entries[0].click()
    expect(live.yDoc.getMap('binaryFiles').has('image.png')).toBe(false)
    expect(deletedPath).toBe('Team/image.png')
  })
})
