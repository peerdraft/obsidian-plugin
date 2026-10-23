// Kept free of Obsidian imports so it stays unit-testable.

export interface StartupSyncDeps {
  showPendingShares: () => Promise<void>
  connect: () => void
  connected: () => Promise<void>
  restoreFiles: () => Promise<void>
  restoreFolders: () => Promise<void>
  isStopped?: () => boolean
}

export const runStartupSync = async (deps: StartupSyncDeps): Promise<void> => {
  if (deps.isStopped?.()) return
  const reportStatusError = (error: unknown): void => {
    console.error('[Peerdraft] Could not display startup sync status', error)
  }
  try {
    // Request indicators first, without making transport depend on deferred UI loading.
    void deps.showPendingShares().catch(reportStatusError)
  } catch (error) {
    reportStatusError(error)
  }
  deps.connect()
  await deps.connected()
  if (deps.isStopped?.()) return
  await deps.restoreFiles()
  if (deps.isStopped?.()) return
  await deps.restoreFolders()
}

/** Start every share in a phase without letting one slow or failed share block its peers. */
export const restoreSharesInParallel = async <Share>(
  shares: Iterable<Share>,
  restore: (share: Share) => Promise<unknown>,
  reportError: (share: Share, error: unknown) => void,
): Promise<void> => {
  await Promise.all(Array.from(shares, async share => {
    try {
      await restore(share)
    } catch (error) {
      reportError(share, error)
    }
  }))
}
