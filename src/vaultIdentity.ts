// Kept free of Obsidian imports so it stays unit-testable.

export type VaultIdentityAssessment =
  | { action: 'first-run'; basePath: string }
  | { action: 'match' }
  | { action: 'mismatch'; storedPath: string; currentPath: string }

export const assessVaultIdentity = (
  storedPath: string | undefined,
  currentPath: string
): VaultIdentityAssessment => {
  if (!storedPath) return { action: 'first-run', basePath: currentPath }
  if (storedPath === currentPath) return { action: 'match' }
  return { action: 'mismatch', storedPath, currentPath }
}

/** A copied vault must not keep the original's oid (JWT/IndexedDB keys)
 *  or its serverShares registry (path→shareId claims the original's
 *  remote shares). */
export const resetVaultIdentity = (
  settings: {
    oid: string
    serverShares: { files: Map<string, unknown>; folders: Map<string, unknown> }
  },
  newOid: string
): void => {
  settings.oid = newOid
  settings.serverShares.files.clear()
  settings.serverShares.folders.clear()
}
