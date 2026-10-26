import { Notice, TFile, requestUrl } from 'obsidian'
import type { TFolder, WorkspaceLeaf } from 'obsidian'
import * as Y from 'yjs'
import { BinaryFileSync, type BinaryFileMetadata } from '../sharedEntities/binaryFileSync'
import type PeerDraftPlugin from '../main'
import { calculateFileHash } from '../utils/hashCalculation'

jest.mock('../main', () => ({ __esModule: true, default: class {} }))
jest.mock('../sharedEntities/sharedFolder', () => ({ SharedFolder: class {} }))
jest.mock('../peerdraftWebSocketProvider', () => ({ BINARY_PRESIGN_UPLOAD: 1, MESSAGE_MULTIPLEX_SYNC: 2 }))
jest.mock('../ui', () => ({ showNotice: jest.fn() }))

const remoteBytes = new Uint8Array([1, 2, 3]).buffer
const oldBytes = new Uint8Array([4, 5, 6]).buffer

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function createItem(): HTMLElement {
  const element = document.createElement('div')
  element.addClass = (...names: string[]): void => element.classList.add(...names)
  element.removeClass = (...names: string[]): void => element.classList.remove(...names)
  return element
}

async function createClient(localBytes?: ArrayBuffer) {
  const yDoc = new Y.Doc()
  const binaryFiles = yDoc.getMap<BinaryFileMetadata>('binaryFiles')
  binaryFiles.set('Photo.png', {
    path: 'Photo.png', hash: await calculateFileHash(remoteBytes), size: 3,
    storageKey: 'key', downloadUrl: 'https://example.test/file', contentType: 'image/png', uploadedAt: 0,
  })
  const files = new Map<string, TFile>()
  const contents = new Map<string, ArrayBuffer>()
  const items: Record<string, { innerEl: HTMLElement }> = {}
  const addFile = (path: string, bytes: ArrayBuffer): TFile => {
    const file = Object.assign(new TFile(), { path, name: path.split('/').pop()!, stat: { size: bytes.byteLength } })
    files.set(path, file)
    contents.set(path, bytes)
    items[path] = { innerEl: createItem() }
    return file
  }
  if (localBytes) addFile('Shared/Photo.png', localBytes)
  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => path === 'Shared' ? { path } : files.get(path)),
    readBinary: jest.fn(async (file: TFile) => contents.get(file.path)!),
    createBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => addFile(path, bytes)),
    modifyBinary: jest.fn(async (file: TFile, bytes: ArrayBuffer) => { contents.set(file.path, bytes) }),
  }
  const leaf = { view: { getViewType: () => 'file-explorer', fileItems: items }, loadIfDeferred: async () => {} }
  const plugin = { app: { vault, workspace: { iterateAllLeaves: (visit: (leaf: WorkspaceLeaf) => void) => visit(leaf as unknown as WorkspaceLeaf) } } } as unknown as PeerDraftPlugin
  const sync = new BinaryFileSync(yDoc, { path: 'Shared' } as TFolder, plugin, () => 'folder-id')
  const item = (path = 'Shared/Photo.png'): HTMLElement => items[path].innerEl
  return { yDoc, binaryFiles, files, contents, addFile, vault, sync, item }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(requestUrl).mockResolvedValue({ status: 200, arrayBuffer: remoteBytes } as Awaited<ReturnType<typeof requestUrl>>)
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('binary explorer status lifecycle', () => {
  test('paints a new download in sync after the local file has been created', async () => {
    const client = await createClient()
    await client.sync.initialize()

    expect(client.contents.get('Shared/Photo.png')).toEqual(remoteBytes)
    expect(client.item().classList.contains('pd-status-insync')).toBe(true)
    expect(client.item().title).toContain('In sync')
    client.sync.destroy()
  })

  test('keeps an overwrite syncing until the vault finishes writing, then paints matching bytes in sync', async () => {
    const client = await createClient(oldBytes)
    const writing = deferred<void>()
    const started = deferred<void>()
    client.vault.modifyBinary.mockImplementation(async (file, bytes) => {
      started.resolve()
      await writing.promise
      client.contents.set(file.path, bytes)
    })
    const initialization = client.sync.initialize()
    await started.promise
    expect(client.item().classList.contains('pd-status-syncing')).toBe(true)
    expect(client.item().classList.contains('pd-status-insync')).toBe(false)
    writing.resolve()
    await initialization

    expect(client.contents.get('Shared/Photo.png')).toEqual(remoteBytes)
    expect(client.item().classList.contains('pd-status-insync')).toBe(true)
    client.sync.destroy()
  })

  test('shows an already matching local binary as in sync without downloading', async () => {
    const client = await createClient(remoteBytes)
    await client.sync.initialize()
    expect(requestUrl).not.toHaveBeenCalled()
    expect(client.item().classList.contains('pd-status-insync')).toBe(true)
    client.sync.destroy()
  })

  test('clears syncing when the download request rejects without claiming success', async () => {
    const client = await createClient(oldBytes)
    jest.mocked(requestUrl).mockRejectedValueOnce(new Error('Network unavailable'))
    await client.sync.initialize()

    expect(client.contents.get('Shared/Photo.png')).toEqual(oldBytes)
    expect(client.item().classList.contains('pd-status-syncing')).toBe(false)
    expect(client.item().classList.contains('pd-status-insync')).toBe(false)
    client.sync.destroy()
  })

  test('clears syncing and preserves the failed-write notice when the vault write fails', async () => {
    const client = await createClient(oldBytes)
    client.vault.modifyBinary.mockRejectedValueOnce(new Error('Disk full'))
    const reportError = jest.spyOn(console, 'error').mockImplementation(() => {})
    await client.sync.initialize()

    expect(client.contents.get('Shared/Photo.png')).toEqual(oldBytes)
    expect(client.item().classList.contains('pd-status-syncing')).toBe(false)
    expect(client.item().classList.contains('pd-status-insync')).toBe(false)
    expect(Notice).toHaveBeenCalledWith('Failed to download Photo.png: Disk full')
    reportError.mockRestore()
    client.sync.destroy()
  })

  test('destroy clears tracked and pending-upload badges without touching local bytes or shared metadata', async () => {
    jest.useFakeTimers()
    const client = await createClient(remoteBytes)
    await client.sync.initialize()
    const pendingFile = client.addFile('Shared/Pending.png', oldBytes)
    await client.sync.handleBinaryFile(pendingFile)
    expect(client.item().classList.contains('pd-status-insync')).toBe(true)
    expect(client.item('Shared/Pending.png').classList.contains('pd-status-syncing')).toBe(true)
    client.sync.destroy()
    await Promise.resolve()
    await Promise.resolve()
    jest.advanceTimersByTime(10000)

    for (const path of ['Shared/Photo.png', 'Shared/Pending.png']) {
      expect(client.files.has(path)).toBe(true)
      expect(client.contents.has(path)).toBe(true)
      expect(client.item(path).className).toBe('')
      expect(client.item(path).hasAttribute('title')).toBe(false)
    }
    expect(client.binaryFiles.has('Photo.png')).toBe(true)
    expect(client.binaryFiles.has('Pending.png')).toBe(false)
    expect(client.contents.get('Shared/Photo.png')).toEqual(remoteBytes)
    expect(client.contents.get('Shared/Pending.png')).toEqual(oldBytes)
    expect(client.vault.createBinary).not.toHaveBeenCalled()
    expect(requestUrl).not.toHaveBeenCalled()
  })

  test('a status read finishing after destroy cannot restore a badge', async () => {
    const client = await createClient(remoteBytes)
    await client.sync.initialize()
    const reading = deferred<ArrayBuffer>()
    const started = deferred<void>()
    client.vault.readBinary.mockResolvedValueOnce(remoteBytes).mockImplementationOnce(() => {
      started.resolve()
      return reading.promise
    })
    const checking = client.sync.handleBinaryFile(client.files.get('Shared/Photo.png')!)
    await started.promise
    client.sync.destroy()
    reading.resolve(remoteBytes)
    await checking

    expect(client.item().className).toBe('')
    expect(client.item().hasAttribute('title')).toBe(false)
  })

  test('destroy clears a failed first upload warning even though the file has no shared metadata', async () => {
    jest.useFakeTimers()
    const client = await createClient()
    const file = client.addFile('Shared/Failed.png', oldBytes)
    const uploader = client.sync as unknown as {
      requestPresignedUpload: () => Promise<never>
      uploadFile: (file: TFile, relativePath: string) => Promise<void>
    }
    jest.spyOn(uploader, 'requestPresignedUpload').mockRejectedValueOnce(new Error('Upload unavailable'))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    await client.sync.handleBinaryFile(file)
    await uploader.uploadFile(file, 'Failed.png')

    expect(client.binaryFiles.has('Failed.png')).toBe(false)
    expect(client.item(file.path).classList.contains('pd-status-warning')).toBe(true)
    client.sync.destroy()
    await Promise.resolve()
    await Promise.resolve()

    expect(client.item(file.path).className).toBe('')
    expect(client.item(file.path).hasAttribute('title')).toBe(false)
    expect(client.contents.get(file.path)).toEqual(oldBytes)
  })
})
