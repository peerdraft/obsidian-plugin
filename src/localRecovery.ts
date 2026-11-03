import { TFile, TFolder, normalizePath, type Vault } from 'obsidian'
import { Mutex } from 'async-mutex'

export const LOCAL_RECOVERY_FOLDER = '_Peerdraft Recovery'

/** Recovery copies stay local in this reserved vault-root directory. */
export function isLocalRecoveryPath(location: string): boolean {
  const path = normalizePath(location)
  return path === LOCAL_RECOVERY_FOLDER || path.startsWith(LOCAL_RECOVERY_FOLDER + '/')
}

/** Ignore manually configured recovery shares without changing the saved settings. */
export function savedSharesOutsideRecovery<Share>(entries: Iterable<[string, Share]>): Array<[string, Share]> {
  return Array.from(entries).filter(([location]) => !isLocalRecoveryPath(location))
}

const locks = new WeakMap<Vault, Map<string, Mutex>>()

async function ensureDirectory(vault: Vault, location: string): Promise<TFolder> {
  let folder: TFolder | undefined
  let current = ''
  for (const segment of location.split('/')) {
    current = current ? current + '/' + segment : segment
    let entry = vault.getAbstractFileByPath(current)
    if (!entry) {
      try { entry = await vault.createFolder(current) }
      catch (error) {
        entry = vault.getAbstractFileByPath(current)
        if (!entry) throw error
      }
    }
    if (!(entry instanceof TFolder)) throw new Error('Recovery destination is not a folder: ' + current)
    folder = entry
  }
  if (!folder) throw new Error('Recovery destination is missing')
  return folder
}

/** Preserve exact source before replacing an unbased local note. Never overwrite a copy. */
export async function preserveLocalVersion(
  vault: Vault, originalPath: string, content: string, now = new Date(),
): Promise<{ file: TFile; created: boolean }> {
  if (!originalPath || originalPath.startsWith('/') || originalPath.includes('\\') ||
    originalPath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid original path for local recovery')
  }
  const path = normalizePath(originalPath)
  if (isLocalRecoveryPath(path)) throw new Error('Cannot recover a recovery copy into itself')
  const mutexes = locks.get(vault) ?? new Map<string, Mutex>()
  locks.set(vault, mutexes)
  const mutex = mutexes.get(path) ?? new Mutex()
  mutexes.set(path, mutex)
  return mutex.runExclusive(async () => {
    const slash = path.lastIndexOf('/')
    const name = path.slice(slash + 1)
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    const directory = LOCAL_RECOVERY_FOLDER + (slash >= 0 ? '/' + path.slice(0, slash) : '')
    const folder = await ensureDirectory(vault, directory)
    const prefix = base + ' (local recovery '
    // A completed preservation may be followed by a retry or restart before
    // the original was replaced. Reuse only an exact, still-existing copy.
    for (const candidate of folder.children) {
      if (candidate instanceof TFile && candidate.name.startsWith(prefix) && candidate.name.endsWith(')' + extension) &&
        /^\d{4}-\d{2}-\d{2} \d{6}(?: \d+)?$/.test(candidate.name.slice(prefix.length, -(')' + extension).length)) &&
        await vault.read(candidate) === content && vault.getAbstractFileByPath(candidate.path) === candidate) {
        return { file: candidate, created: false }
      }
    }
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    for (let suffix = 0; ; suffix++) {
      const target = `${directory}/${prefix}${stamp}${suffix ? ' ' + suffix : ''})${extension}`
      if (vault.getAbstractFileByPath(target)) continue
      let file: TFile
      try { file = await vault.create(target, content) }
      catch (error) {
        if (vault.getAbstractFileByPath(target)) continue
        throw error
      }
      if (await vault.read(file) !== content || vault.getAbstractFileByPath(target) !== file) {
        throw new Error('Could not verify preserved local source: ' + target)
      }
      return { file, created: true }
    }
  })
}
