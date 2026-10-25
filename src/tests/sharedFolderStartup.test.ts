import { TFile, TFolder } from 'obsidian'
import * as Y from 'yjs'
import type PeerdraftPlugin from '../peerdraftPlugin'
import { BinaryFileSync } from '../sharedEntities/binaryFileSync'
import { SharedFolder } from '../sharedEntities/sharedFolder'
import { SharedDocument } from '../sharedEntities/sharedDocument'
import { showNotice } from '../ui'

// Exercise the real directory creation helper; replace plugin UI, transport,
// and unrelated entity integrations that are not needed for vault operations.
jest.mock('../settings', () => ({ saveSettingsNow: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../main', () => ({ __esModule: true, default: class {} }))
jest.mock('../permanentShareStoreFS', () => ({ getFolderByPath: jest.fn() }))
jest.mock('../ui/enterText', () => ({}))
jest.mock('../peerdraftWebSocketProvider', () => ({ StopSessionError: class extends Error {} }))
jest.mock('../ui/login', () => ({}))
jest.mock('../workspace/explorerView', () => ({ setStatusClass: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../ui', () => ({ showNotice: jest.fn() }))
jest.mock('../utils/fileTypeDetection', () => ({}))
jest.mock('../sharedEntities/binaryFileSync', () => ({
  BinaryFileSync: class {
    async initialize(): Promise<void> {}
    destroy(): void {}
  },
}))
jest.mock('../sharedEntities/sharedDocument', () => {
  class MockSharedDocument { static getAll = jest.fn(() => []) }
  return { SharedDocument: MockSharedDocument }
})
jest.mock('y-webrtc', () => ({ WebrtcProvider: class {} }))

function createFolder(path: string): TFolder {
  return Object.assign(new TFolder(), { path })
}

function createVault(): {
  files: Map<string, TFile | TFolder>
  createFolder: jest.Mock<Promise<TFolder>, [string]>
  plugin: PeerdraftPlugin
} {
  const files = new Map<string, TFile | TFolder>()
  const createFolder = jest.fn<Promise<TFolder>, [string]>()
  const plugin = {
    log: jest.fn(),
    activeStreamClient: { add: jest.fn() },
    serverSync: {
      wsconnected: true,
      on: jest.fn(),
      off: jest.fn(),
      sendSyncStep1: jest.fn(),
      sendUpdate: jest.fn(),
    },
    app: {
      vault: {
        getAbstractFileByPath: (path: string): TFile | TFolder | undefined => files.get(path),
        createFolder,
      },
    },
  } as unknown as PeerdraftPlugin
  return { files, createFolder, plugin }
}

afterEach(() => {
  for (const folder of SharedFolder.getAll()) folder.destroy()
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

describe('startup directory creation', () => {
  test('restores two missing paths when both try to create the same missing parent', async () => {
    const { files, createFolder: createVaultFolder, plugin } = createVault()
    let releaseParentCreation: () => void = () => {}
    const parentCreation = new Promise<void>(resolve => { releaseParentCreation = resolve })
    createVaultFolder.mockImplementation(async path => {
      if (path === 'Shared') await parentCreation
      if (files.has(path)) throw new Error('Folder already exists')
      const folder = createFolder(path)
      files.set(path, folder)
      return folder
    })

    const first = SharedFolder.getOrCreatePath('Shared/first', plugin)
    const second = SharedFolder.getOrCreatePath('Shared/second', plugin)
    // Neither caller can observe the parent until the pending vault operation
    // completes. One succeeds; the other's create rejects as already existing.
    expect(createVaultFolder.mock.calls).toEqual([['Shared'], ['Shared']])
    releaseParentCreation()
    const restored = await Promise.all([first, second])

    expect(restored).toEqual([files.get('Shared/first'), files.get('Shared/second')])
    expect(restored.every(folder => folder instanceof TFolder)).toBe(true)
    expect(Array.from(files.keys()).sort()).toEqual(['Shared', 'Shared/first', 'Shared/second'])
  })

  test('propagates a creation failure when no folder was created by another caller', async () => {
    const { files, createFolder: createVaultFolder, plugin } = createVault()
    const failure = new Error('Vault is read-only')
    createVaultFolder.mockRejectedValue(failure)

    await expect(SharedFolder.getOrCreatePath('Shared/nested', plugin)).rejects.toBe(failure)

    expect(files.size).toBe(0)
    expect(createVaultFolder.mock.calls).toEqual([['Shared']])
  })

  test('does not treat a file appearing at the contested path as a recovered folder', async () => {
    const { files, createFolder: createVaultFolder, plugin } = createVault()
    const failure = new Error('Path already exists as a file')
    createVaultFolder.mockImplementation(async path => {
      files.set(path, Object.assign(new TFile(), { path }))
      throw failure
    })

    await expect(SharedFolder.getOrCreatePath('Shared/nested', plugin)).rejects.toBe(failure)

    expect(files.has('Shared/nested')).toBe(false)
  })
})

describe('startup attachment catch-up', () => {
  test('publishes newly added folder members after restoring matching server content', async () => {
    const { files, plugin } = createVault()
    files.set('Shared', createFolder('Shared'))
    const server = new Y.Doc()
    server.getArray<string>('fileExtensions').push(['md', 'png'])
    server.getMap<string>('documents').set('existing', 'Existing.md')
    const cachedState = Y.encodeStateAsUpdate(server)
    jest.spyOn(SharedFolder.prototype, 'startIndexedDBSync').mockImplementation(async function () {
      Y.applyUpdate(this.yDoc, cachedState)
      return undefined
    })
    jest.mocked(plugin.serverSync.sendUpdate).mockImplementation((_folder, update) => {
      Y.applyUpdate(server, update)
    })

    try {
      const folder = await SharedFolder.fromPermanentShareFolder({
        path: 'Shared', persistenceId: 'folder-cache', shareId: 'folder-share',
      }, plugin)
      if (!folder) throw new Error('Could not restore folder fixture')
      // An unchanged-content startup can omit a full client-to-server state
      // transfer. The next ordinary update must be usable on its own.
      expect(folder.getDocsFragment().toJSON()).toEqual(server.getMap('documents').toJSON())
      folder.addDocument({ shareId: 'new', path: 'Shared/New.md' } as SharedDocument)

      expect(server.getMap('documents').get('new')).toBe('New.md')
      expect(folder.yDoc.getArray('fileExtensions').toArray()).toEqual(['md', 'png'])
    } finally {
      server.destroy()
    }
  })

  test('returns the restored folder while attachment initialization is still pending', async () => {
    const { files, plugin } = createVault()
    files.set('Shared', createFolder('Shared'))
    let finishAttachments: () => void = () => {}
    let attachmentsCompleted = false
    const attachments = new Promise<void>(resolve => {
      finishAttachments = () => { attachmentsCompleted = true; resolve() }
    })
    const initialize = jest.spyOn(BinaryFileSync.prototype, 'initialize').mockReturnValue(attachments)
    const restoring = SharedFolder.fromPermanentShareFolder({
      path: 'Shared', persistenceId: 'folder-cache', shareId: 'folder-share',
    }, plugin)
    // A turn of the event loop lets all restoration microtasks finish without
    // waiting for attachment bytes. A regression must fail instead of hang.
    let deadline: ReturnType<typeof setTimeout> | undefined
    const nextTurn = new Promise<undefined>(resolve => {
      deadline = setTimeout(() => resolve(undefined), 0)
    })
    try {
      const folder = await Promise.race([restoring, nextTurn])

      expect(folder).toBeInstanceOf(SharedFolder)
      expect(initialize).toHaveBeenCalledTimes(1)
      expect(attachmentsCompleted).toBe(false)
      expect(plugin.serverSync.sendSyncStep1).toHaveBeenCalledTimes(1)
      expect(plugin.activeStreamClient.add).toHaveBeenCalledWith(['folder-share'])
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      finishAttachments()
      await restoring
    }
  })

  test('reports a rejected background attachment initialization after the folder has restored', async () => {
    const { files, plugin } = createVault()
    files.set('Shared', createFolder('Shared'))
    let failAttachments: (error: Error) => void = () => {}
    const attachments = new Promise<void>((_resolve, reject) => { failAttachments = reject })
    jest.spyOn(BinaryFileSync.prototype, 'initialize').mockReturnValue(attachments)
    const reportError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const folder = await SharedFolder.fromPermanentShareFolder({
      path: 'Shared', persistenceId: 'folder-cache', shareId: 'folder-share',
    }, plugin)
    expect(folder).toBeInstanceOf(SharedFolder)
    expect(showNotice).not.toHaveBeenCalled()

    const failure = new Error('Attachment storage unavailable')
    failAttachments(failure)
    await Promise.resolve()

    expect(reportError).toHaveBeenCalledWith(
      '[Peerdraft] Could not initialize attachments for shared folder', 'Shared', failure,
    )
    expect(showNotice).toHaveBeenCalledWith(
      'Peerdraft could not initialize attachments in Shared. See the console for details.',
    )
    expect(SharedFolder.findByPath('Shared')).toBe(folder)
  })

  test('does not report a late attachment failure after the restored folder was destroyed', async () => {
    const { files, plugin } = createVault()
    files.set('Shared', createFolder('Shared'))
    let failAttachments: (error: Error) => void = () => {}
    jest.spyOn(BinaryFileSync.prototype, 'initialize').mockReturnValue(
      new Promise<void>((_resolve, reject) => { failAttachments = reject }),
    )
    const reportError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const folder = await SharedFolder.fromPermanentShareFolder({
      path: 'Shared', persistenceId: 'folder-cache', shareId: 'folder-share',
    }, plugin)
    folder?.destroy()

    failAttachments(new Error('Late attachment failure'))
    await Promise.resolve()

    expect(reportError).not.toHaveBeenCalled()
    expect(showNotice).not.toHaveBeenCalled()
  })
})


describe('large-folder status aggregation', () => {
  test('reflects all 1000 child states using the current document registry', async () => {
    const { files, plugin } = createVault()
    files.set('Shared', createFolder('Shared'))
    const folder = await SharedFolder.fromPermanentShareFolder({
      path: 'Shared', persistenceId: 'folder-cache', shareId: 'large-folder',
    }, plugin)
    if (!folder) throw new Error('Could not create status fixture')
    let changedChild: 'insync' | 'syncing' | 'offline' = 'insync'
    const documents = Array.from({ length: 1000 }, (_, index) => ({
      shareId: `child-${index}`,
      getSyncStatus: () => index === 999 ? changedChild : 'insync',
      syncable: { on: jest.fn() },
    })) as unknown as SharedDocument[]
    jest.mocked(SharedDocument.getAll).mockReturnValue(documents)
    const runtime = folder as unknown as { _initializationGuardPassed: boolean; _syncable: { serverSynced: boolean; serverSyncing: boolean } }
    runtime._initializationGuardPassed = true
    jest.spyOn(runtime._syncable, 'serverSynced', 'get').mockReturnValue(true)
    jest.spyOn(runtime._syncable, 'serverSyncing', 'get').mockReturnValue(false)
    folder.yDoc.transact(() => {
      for (let i = 0; i < 1000; i++) folder.getDocsFragment().set(`child-${i}`, `note-${i}.md`)
    })

    expect(folder.getSyncStatus()).toBe('insync')
    changedChild = 'syncing'
    expect(folder.getSyncStatus()).toBe('syncing')
    changedChild = 'offline'
    expect(folder.getSyncStatus()).toBe('syncing')
    changedChild = 'insync'
    expect(folder.getSyncStatus()).toBe('insync')
  })
})
