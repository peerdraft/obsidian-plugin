import * as Y from 'yjs'
import { BinaryFileSync, type BinaryFileMetadata } from '../sharedEntities/binaryFileSync'

// These pull in the whole plugin, and BinaryFileSync only needs them as types or constants
jest.mock('../main', () => ({ __esModule: true, default: class {} }))
jest.mock('../sharedEntities/sharedFolder', () => ({ SharedFolder: class {} }))
jest.mock('../peerdraftWebSocketProvider', () => ({
  BINARY_PRESIGN_UPLOAD: 1,
  MESSAGE_MULTIPLEX_SYNC: 2
}))
jest.mock('../ui', () => ({ showNotice: jest.fn() }))
jest.mock('../workspace/explorerView', () => ({
  setStatusClass: jest.fn().mockResolvedValue(undefined),
  removeStatusClass: jest.fn().mockResolvedValue(undefined)
}))

const metadata = (relativePath: string): BinaryFileMetadata => ({
  path: relativePath,
  hash: 'hash',
  size: 1,
  storageKey: 'key',
  downloadUrl: 'https://example.test/file',
  contentType: 'text/plain',
  uploadedAt: 0
})

function createClient(sharedPaths: string[]) {
  const yDoc = new Y.Doc()
  const binaryFiles = yDoc.getMap<BinaryFileMetadata>('binaryFiles')
  for (const relativePath of sharedPaths) binaryFiles.set(relativePath, metadata(relativePath))

  const vault = {
    getAbstractFileByPath: jest.fn().mockReturnValue({ path: 'present' }),
    delete: jest.fn().mockResolvedValue(undefined),
    readBinary: jest.fn()
  }
  const sync = new BinaryFileSync(yDoc, { path: 'Shared' } as any, { app: { vault } } as any, () => 'folder-id')
  // Skips initialize(), which would try to download every entry
  ;(sync as any).setupYDocObserver()
  return { yDoc, binaryFiles, vault, sync }
}

/** Sends everything the sender has to the receiver, as the server does. */
function syncDocs(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)))
}

// A client that receives a new entry tries to download it, which needs the server
beforeEach(() => {
  jest.spyOn(BinaryFileSync.prototype as any, 'downloadFile').mockResolvedValue(undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('BinaryFileSync.unshareFile', () => {
  it('removes the file from the shared map and reports that it was shared', () => {
    const { binaryFiles, sync } = createClient(['a.base', 'b.base'])

    expect(sync.unshareFile('a.base')).toBe(true)

    expect(binaryFiles.has('a.base')).toBe(false)
    expect(binaryFiles.has('b.base')).toBe(true)
    expect(sync.isFileTracked('a.base')).toBe(false)
  })

  it('reports false for a file that was not shared', () => {
    const { sync } = createClient(['a.base'])

    expect(sync.unshareFile('other.base')).toBe(false)
  })

  it('leaves the file in the vault of the client that unshares it', () => {
    const { vault, sync } = createClient(['a.base'])

    sync.unshareFile('a.base')

    expect(vault.delete).not.toHaveBeenCalled()
  })

  it('cancels an upload that was still waiting', () => {
    jest.useFakeTimers()
    const { binaryFiles, sync } = createClient([])
    const upload = jest.fn()
    ;(sync as any).uploadTimeouts.set('a.base', window.setTimeout(upload, 5000))

    expect(sync.unshareFile('a.base')).toBe(false)
    jest.advanceTimersByTime(10000)

    expect(upload).not.toHaveBeenCalled()
    expect(binaryFiles.has('a.base')).toBe(false)
  })

  it('does not stop later remote deletions from removing the local file', () => {
    const { binaryFiles, vault, sync } = createClient(['a.base', 'b.base'])

    sync.unshareFile('a.base')
    binaryFiles.delete('b.base')

    expect(vault.delete).toHaveBeenCalledTimes(1)
  })
})

describe('other clients when a file is unshared', () => {
  it('delete their copy of a file that is no longer shared', () => {
    const owner = createClient(['a.base'])
    const other = createClient([])
    syncDocs(owner.yDoc, other.yDoc)

    owner.sync.unshareFile('a.base')
    syncDocs(owner.yDoc, other.yDoc)

    expect(other.binaryFiles.has('a.base')).toBe(false)
    expect(other.vault.delete).toHaveBeenCalledTimes(1)
    expect(other.vault.getAbstractFileByPath).toHaveBeenCalledWith('Shared/a.base')
  })

  it('keep their copy when the file moved to a text document', () => {
    const owner = createClient(['a.base'])
    const other = createClient([])
    syncDocs(owner.yDoc, other.yDoc)

    owner.yDoc.getMap<string>('documents').set('doc-id', 'a.base')
    owner.sync.unshareFile('a.base')
    syncDocs(owner.yDoc, other.yDoc)

    expect(other.binaryFiles.has('a.base')).toBe(false)
    expect(other.vault.delete).not.toHaveBeenCalled()
  })
})
