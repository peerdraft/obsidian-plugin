import { ImportQueue } from './importQueue'
import type PeerdraftPlugin from './peerdraftPlugin'

const queues = new WeakMap<PeerdraftPlugin, ImportQueue>()

/** All folder imports in one vault share the same bounded initialization budget. */
export function folderImportQueue(plugin: PeerdraftPlugin): ImportQueue {
  let queue = queues.get(plugin)
  if (!queue) {
    queue = new ImportQueue(8)
    queues.set(plugin, queue)
    if (typeof plugin.register === 'function') plugin.register(() => queue?.destroy())
  }
  return queue
}

/** Reject a remote manifest path before it can escape its chosen local folder. */
export function importedFilePath(root: string, relative: string): string {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || /[\u0000-\u001f]/.test(relative) ||
    relative.split('/').some(segment => !segment || segment === '.' || segment === '..') || /^[A-Za-z]:/.test(relative)) {
    throw new Error('Invalid document path in shared folder')
  }
  return `${root.replace(/\/$/, '')}/${relative}`
}

const fileOperations = new WeakMap<PeerdraftPlugin, Map<string, number>>()

/** Recovery changes belong to the existing remote share, not to a new local share. */
export function importFileOperationActive(plugin: PeerdraftPlugin, path: string): boolean {
  return (fileOperations.get(plugin)?.get(path) ?? 0) > 0
}

export async function withImportFileOperation<T>(
  plugin: PeerdraftPlugin, paths: string[], action: () => Promise<T>,
): Promise<T> {
  const operations = fileOperations.get(plugin) ?? new Map<string, number>()
  fileOperations.set(plugin, operations)
  for (const path of paths) operations.set(path, (operations.get(path) ?? 0) + 1)
  try { return await action() }
  finally {
    for (const path of paths) {
      const remaining = (operations.get(path) ?? 1) - 1
      if (remaining) operations.set(path, remaining)
      else operations.delete(path)
    }
  }
}
