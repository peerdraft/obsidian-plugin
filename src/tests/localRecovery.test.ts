import { TFile, TFolder, type Vault } from 'obsidian'
import { isLocalRecoveryPath, preserveLocalVersion, savedSharesOutsideRecovery } from '../localRecovery'

function fixture() {
  const files = new Map<string, TFile | TFolder>()
  const contents = new Map<TFile, string>()
  const parent = (path: string): TFolder | undefined => files.get(path.slice(0, path.lastIndexOf('/'))) as TFolder | undefined
  const createFolder = jest.fn(async (path: string) => {
    if (files.has(path)) throw new Error('Already exists')
    const folder = Object.assign(new TFolder(), { path, children: [] })
    files.set(path, folder); parent(path)?.children.push(folder)
    return folder
  })
  const create = jest.fn(async (path: string, text: string) => {
    if (files.has(path)) throw new Error('Already exists')
    const file = Object.assign(new TFile(), { path, name: path.split('/').pop() })
    files.set(path, file); contents.set(file, text); parent(path)?.children.push(file)
    return file
  })
  const read = jest.fn(async (file: TFile) => contents.get(file) ?? '')
  const vault = { getAbstractFileByPath: (path: string) => files.get(path), createFolder, create, read } as unknown as Vault
  return { vault, files, contents, create, read }
}

test('preserves exact source and relative folders, then reuses the verified copy on retry', async () => {
  const f = fixture()
  const text = '---\nactive: false\n---\nSource 😀\n'
  const first = await preserveLocalVersion(f.vault, 'Projects/Note.md', text, new Date(2026, 10, 3, 17, 0, 0))
  expect(first.file.path).toBe('_Peerdraft Recovery/Projects/Note (local recovery 2026-11-03 170000).md')
  expect(f.contents.get(first.file)).toBe(text)
  expect(first.created).toBe(true)
  const second = await preserveLocalVersion(f.vault, 'Projects/Note.md', text, new Date(2026, 10, 4))
  expect(second).toEqual({ file: first.file, created: false })
  expect(f.create).toHaveBeenCalledTimes(1)
})

test('keeps differing versions with colliding timestamps without overwriting either', async () => {
  const f = fixture(); const time = new Date(2026, 10, 3, 17)
  const first = await preserveLocalVersion(f.vault, 'Note.md', 'Saved disk', time)
  const second = await preserveLocalVersion(f.vault, 'Note.md', 'Unsaved editor', time)
  expect(first.file.path).not.toBe(second.file.path)
  expect(f.contents.get(first.file)).toBe('Saved disk')
  expect(f.contents.get(second.file)).toBe('Unsaved editor')
})

test('does not reuse another original whose basename contains the recovery label', async () => {
  const f = fixture(); const time = new Date(2026, 10, 3, 17)
  const other = await preserveLocalVersion(f.vault, 'Note (local recovery draft).md', 'Same bytes', time)
  const original = await preserveLocalVersion(f.vault, 'Note.md', 'Same bytes', time)
  expect(original.created).toBe(true)
  expect(original.file.path).toBe('_Peerdraft Recovery/Note (local recovery 2026-11-03 170000).md')
  expect(original.file.path).not.toBe(other.file.path)
  expect(f.contents.get(original.file)).toBe('Same bytes')
  expect(f.contents.get(other.file)).toBe('Same bytes')
})

test('rejects failed writes and read-back mismatch', async () => {
  const f = fixture()
  f.create.mockRejectedValueOnce(new Error('Disk full'))
  await expect(preserveLocalVersion(f.vault, 'Note.md', 'Keep me')).rejects.toThrow('Disk full')
  f.read.mockResolvedValueOnce('Wrong bytes')
  await expect(preserveLocalVersion(f.vault, 'Note.md', 'Keep me')).rejects.toThrow('Could not verify')
})

test('recognizes only the reserved root segment, and rejects unsafe original paths', async () => {
  expect(isLocalRecoveryPath('_Peerdraft Recovery/Projects/Note.md')).toBe(true)
  expect(isLocalRecoveryPath('_Peerdraft Recovery')).toBe(true)
  expect(isLocalRecoveryPath('Projects/_Peerdraft Recovery/Note.md')).toBe(false)
  expect(isLocalRecoveryPath('_Peerdraft Recovery copy/Note.md')).toBe(false)
  const f = fixture()
  await expect(preserveLocalVersion(f.vault, '../Note.md', 'x')).rejects.toThrow('Invalid')
  expect(f.create).not.toHaveBeenCalled()
})


test('ignores configured recovery entries in saved startup views without changing settings', () => {
  const saved = new Map([
    ['Projects/Note.md', { shareId: 'regular' }],
    ['_Peerdraft Recovery/Projects/Note.md', { shareId: 'recovery-note' }],
    ['_Peerdraft Recovery', { shareId: 'recovery-folder' }],
    ['_Peerdraft Recovery/Projects', { shareId: 'recovery-subfolder' }],
  ])
  const entries = savedSharesOutsideRecovery(saved.entries())
  // The same view supplies restore work, pending path/status indicators,
  // and document IDs requested from the checkpoint transport.
  expect(entries.map(([location]) => location)).toEqual(['Projects/Note.md'])
  expect(entries.map(([, entry]) => entry.shareId)).toEqual(['regular'])
  expect(saved.size).toBe(4)
})
