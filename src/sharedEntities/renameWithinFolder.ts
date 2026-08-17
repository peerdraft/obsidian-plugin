// Import-free so this stays unit-testable without Obsidian.

export interface PathTrackingFolder {
  updatePath(oldPath: string, newPath: string): string | undefined
}

// Narrowed to what's actually used; real impl takes a full TFile.
export interface RelocatableDocument {
  setNewFileLocation(file: { path: string }): Promise<void>
}

export const handleRenameWithinSameFolder = async (
  folder: PathTrackingFolder,
  doc: RelocatableDocument,
  oldPath: string,
  file: { path: string }
): Promise<void> => {
  folder.updatePath(oldPath, file.path)
  await doc.setNewFileLocation(file)
}

export const relocateIfExisting = async (
  doc: RelocatableDocument | undefined,
  file: { path: string }
): Promise<RelocatableDocument | undefined> => {
  if (doc) {
    await doc.setNewFileLocation(file)
  }
  return doc
}
