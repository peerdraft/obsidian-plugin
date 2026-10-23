/**
 * Reproduces the "Untitled.md -> skill.md" data-loss bug: renaming a file
 * within the same shared folder must keep the SharedDocument's own tracked
 * path (and therefore its settings entry) in sync with the folder's
 * documents map. Previously only the folder's map was updated, leaving the
 * document's own path stale forever.
 */

import {
  handleRenameWithinSameFolder,
  relocateIfExisting,
  type PathTrackingFolder,
  type RelocatableDocument,
} from '../sharedEntities/renameWithinFolder'

describe('handleRenameWithinSameFolder', () => {
  test('updates the folder documents map for the renamed file', async () => {
    const folder: PathTrackingFolder = {
      updatePath: jest.fn(),
    }
    const doc: RelocatableDocument = {
      setNewFileLocation: jest.fn().mockResolvedValue(undefined),
    }
    const file = { path: 'shared/skill.md' } as any

    await handleRenameWithinSameFolder(folder, doc, 'shared/Untitled.md', file)

    expect(folder.updatePath).toHaveBeenCalledWith('shared/Untitled.md', 'shared/skill.md')
  })

  test('also updates the document\'s own tracked path, not just the folder map', async () => {
    const folder: PathTrackingFolder = {
      updatePath: jest.fn(),
    }
    const doc: RelocatableDocument = {
      setNewFileLocation: jest.fn().mockResolvedValue(undefined),
    }
    const file = { path: 'shared/skill.md' } as any

    await handleRenameWithinSameFolder(folder, doc, 'shared/Untitled.md', file)

    expect(doc.setNewFileLocation).toHaveBeenCalledWith(file)
  })
})

describe('relocateIfExisting', () => {
  test('relocates an existing document to the new file location', async () => {
    const doc: RelocatableDocument = {
      setNewFileLocation: jest.fn().mockResolvedValue(undefined),
    }
    const file = { path: 'NewFolder/note.md' }

    const result = await relocateIfExisting(doc, file)

    expect(doc.setNewFileLocation).toHaveBeenCalledWith(file)
    expect(result).toBe(doc)
  })

  test('does nothing and returns undefined when no document exists yet', async () => {
    const file = { path: 'NewFolder/note.md' }

    const result = await relocateIfExisting(undefined, file)

    expect(result).toBeUndefined()
  })
})
