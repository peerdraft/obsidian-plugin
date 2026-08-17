// Kept free of Obsidian imports so it stays unit-testable.

export interface StartupSyncDeps {
  connect: () => void
  connected: () => Promise<void>
  restoreFiles: () => Promise<void>
  restoreFolders: () => Promise<void>
}

export const runStartupSync = async (deps: StartupSyncDeps): Promise<void> => {
  deps.connect()
  await deps.connected()
  await deps.restoreFiles()
  await deps.restoreFolders()
}
