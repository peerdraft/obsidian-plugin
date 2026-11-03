import * as Y from 'yjs'
import { SyncableDocument, type SyncableFileIO } from '../sharedEntities/syncableDocument'

jest.mock('../tools', () => ({ calculateHash: (text: string) => text, checkIndexedDBAlreadyExists: jest.fn() }))

function fixture(disk = 'Old disk', editor?: string) {
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Server text')
  let currentDisk = disk; let currentEditor = editor; let mtime = 1
  const copies: string[] = []
  const preserve = jest.fn(async (text: string) => { copies.push(text) })
  const file: SyncableFileIO = { read: async () => currentDisk, modify: jest.fn(async () => {}), getMTime: () => mtime }
  const document = new SyncableDocument({ yDoc: doc, fileIO: file, shareId: 'note', isPermanent: true,
    serverSync: { on: jest.fn(), off: jest.fn(), sendSyncStep1: jest.fn(), sendUpdate: jest.fn() }, preserveLocalVersion: preserve })
  document._setServerSynced(true)
  return { doc, document, file, copies, preserve, readEditor: () => currentEditor,
    changeDisk: () => { currentDisk = 'New local edit'; mtime++ },
    changeEditor: () => { currentEditor = 'New unsaved edit' },
    cleanup: () => { document.destroy(); doc.destroy() } }
}
const recover = { initialState: 'server' as const, preserveLocalOnServer: true }

test('preserves saved disk and distinct unsaved source without generating local CRDT edits', async () => {
  const f = fixture('Old disk', 'Unsaved local text')
  try {
    const before = Y.encodeStateAsUpdate(f.doc)
    await expect(f.document.reconcileWithFile(f.readEditor, recover)).resolves.toBe(true)
    expect(f.copies).toEqual(['Old disk', 'Unsaved local text'])
    expect(Y.encodeStateAsUpdate(f.doc)).toEqual(before)
    expect(f.document.pendingUpdateCount).toBe(0)
    expect(f.file.modify).not.toHaveBeenCalled()
  } finally { f.cleanup() }
})

test.each(['', 'Old disk'])('preserves an existing local version %j even with a clean open editor', async text => {
  const f = fixture(text, text)
  try {
    await f.document.reconcileWithFile(f.readEditor, recover)
    expect(f.copies).toEqual([text])
    expect(f.doc.getText('content').toString()).toBe('Server text')
  } finally { f.cleanup() }
})

test('equal text needs no copy; an unmarked download placeholder keeps ordinary restoration', async () => {
  const same = fixture('Server text')
  const placeholder = fixture('')
  try {
    await same.document.reconcileWithFile(same.readEditor, recover)
    expect(same.preserve).not.toHaveBeenCalled()
    await placeholder.document.reconcileWithFile(undefined, { initialState: 'server' })
    expect(placeholder.preserve).not.toHaveBeenCalled()
    expect(placeholder.doc.getText('content').toString()).toBe('Server text')
  } finally { same.cleanup(); placeholder.cleanup() }
})

test.each([['', undefined], ['', 'Unsaved on new file'], ['Edited placeholder', undefined]] as const)(
  'a download placeholder preserves real new disk/editor edits (%p, %p)', async (disk, editor) => {
    const f = fixture(disk, editor)
    try {
      await f.document.reconcileWithFile(f.readEditor, { ...recover, emptyDiskIsPlaceholder: true })
      expect(f.copies).toEqual(editor ? [editor] : disk ? [disk] : [])
      expect(f.doc.getText('content').toString()).toBe('Server text')
    } finally { f.cleanup() }
  },
)

test('copy failure leaves original/server untouched and imported-mode retries cannot skip preservation', async () => {
  const f = fixture()
  f.preserve.mockRejectedValueOnce(new Error('Disk full'))
  const options = { initialState: 'imported' as const, preserveLocalOnServer: true }
  try {
    await expect(f.document.reconcileWithFile(f.readEditor, options)).rejects.toThrow('Disk full')
    expect(f.doc.getText('content').toString()).toBe('Server text')
    expect(f.file.modify).not.toHaveBeenCalled()
    await expect(f.document.reconcileWithFile(f.readEditor, options)).resolves.toBe(true)
    expect(f.preserve).toHaveBeenCalledTimes(2)
    expect(f.document.pendingUpdateCount).toBe(0)
  } finally { f.cleanup() }
})

test.each(['disk', 'editor', 'server'] as const)('retries when %s changes during preservation', async kind => {
  const f = fixture()
  f.preserve.mockImplementationOnce(async () => {
    if (kind === 'disk') f.changeDisk()
    if (kind === 'editor') f.changeEditor()
    if (kind === 'server') f.doc.getText('content').insert(0, 'New ')
  })
  try {
    await expect(f.document.reconcileWithFile(f.readEditor, recover)).resolves.toBe(false)
    expect(f.file.modify).not.toHaveBeenCalled()
    expect(f.doc.getText('content').toString()).toBe(kind === 'server' ? 'New Server text' : 'Server text')
  } finally { f.cleanup() }
})
