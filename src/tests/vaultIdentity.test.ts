/**
 * Vault-identity guard (copied-vault detection). `.obsidian` — and with
 * it `data.json` carrying `oid` and the `serverShares` path→shareId
 * registry — travels with a vault copy, so the copy would claim the
 * original's shares and JWT key. Persisting the vault's base path lets
 * the plugin notice the travel and reset identity + registry when the
 * user confirms the vault was copied (as opposed to moved/renamed).
 */

import { assessVaultIdentity, resetVaultIdentity } from '../vaultIdentity'

describe('assessVaultIdentity', () => {
  test('first run without a stored path records the current path', () => {
    expect(assessVaultIdentity(undefined, '/vaults/a')).toEqual({
      action: 'first-run',
      basePath: '/vaults/a'
    })
  })

  test('a matching stored path needs no action', () => {
    expect(assessVaultIdentity('/vaults/a', '/vaults/a')).toEqual({ action: 'match' })
  })

  test('a different stored path means data.json traveled', () => {
    expect(assessVaultIdentity('/vaults/original', '/vaults/copy')).toEqual({
      action: 'mismatch',
      storedPath: '/vaults/original',
      currentPath: '/vaults/copy'
    })
  })
})

describe('resetVaultIdentity', () => {
  test('assigns the new oid and clears both share registries', () => {
    const settings = {
      oid: 'shared-oid',
      serverShares: {
        files: new Map([['notes/a.md', { persistenceId: 'p1', shareId: 's1' }]]),
        folders: new Map([['folder', { persistenceId: 'p2', shareId: 's2' }]])
      }
    }

    resetVaultIdentity(settings, 'fresh-oid')

    expect(settings.oid).toBe('fresh-oid')
    expect(settings.serverShares.files.size).toBe(0)
    expect(settings.serverShares.folders.size).toBe(0)
  })
})
