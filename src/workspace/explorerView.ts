import type { WorkspaceLeaf } from "obsidian"
import type PeerdraftPlugin from "src/peerdraftPlugin"

type ExplorerStatus = 'offline' | 'syncing' | 'insync' | 'warning' | 'disconnected' | 'connected' | 'not-initialized'
const statusVersions = new WeakMap<PeerdraftPlugin, Map<string, number>>()

export const addIsSharedClass = async (path: string, plugin: PeerdraftPlugin) => {
  const fileExplorers = await getFileExplorers(plugin)
  fileExplorers.forEach(fileExplorer => {
    //@ts-expect-error
    const fileItem = fileExplorer.view.fileItems[path];
    if (!fileItem) return
    const el = fileItem.innerEl as HTMLElement
    el.addClass('pd-explorer-shared')
  })
}

export const removeIsSharedClass = async (path: string, plugin: PeerdraftPlugin) => {
  const fileExplorers = await getFileExplorers(plugin)
  fileExplorers.forEach(fileExplorer => {
    //@ts-expect-error
    const fileItem = fileExplorer.view.fileItems[path];
    if (!fileItem) return
    const el = fileItem.innerEl as HTMLElement
    el.removeClass('pd-explorer-shared')
  })
}

export const setStatusClass = async (path: string, plugin: PeerdraftPlugin, status: ExplorerStatus, tooltip?: string): Promise<void> => {
  await setStatusClasses([path], plugin, status, tooltip)
}

/** Paint a batch of paths after discovering and loading explorers once. */
export const setStatusClasses = async (paths: Iterable<string>, plugin: PeerdraftPlugin, status: ExplorerStatus, tooltip?: string): Promise<void> => {
  await updateStatusClasses(paths, plugin, status, tooltip)
}

const updateStatusClasses = async (paths: Iterable<string>, plugin: PeerdraftPlugin, status: ExplorerStatus, tooltip?: string, preserveSharedIcon = false): Promise<void> => {
  const versions = statusVersions.get(plugin) ?? new Map<string, number>()
  statusVersions.set(plugin, versions)
  const requestedVersions = new Map(Array.from(paths, path => {
    const version = (versions.get(path) ?? 0) + 1
    versions.set(path, version)
    return [path, version] as const
  }))
  if (requestedVersions.size === 0) return
  await getFileExplorers(plugin, fileExplorer => {
    for (const [path, version] of requestedVersions) {
      // A newer state or removal may have arrived while this explorer loaded.
      if (versions.get(path) !== version) continue
      //@ts-expect-error
      const fileItem = fileExplorer.view.fileItems?.[path];
      if (!fileItem) continue
      const el = fileItem.innerEl as HTMLElement

      // Remove peerdraft icon and all status classes first
      el.removeClass('pd-status-offline', 'pd-status-syncing', 'pd-status-insync', 'pd-status-warning', 'pd-status-disconnected', 'pd-status-connected')
      if (!preserveSharedIcon) el.removeClass('pd-explorer-shared')

      // Add the appropriate status class
      if (status !== 'not-initialized') {
        el.addClass(`pd-status-${status}`)
        el.setAttribute('title', tooltip ?? getStatusTooltip(status))
      } else {
        el.removeAttribute('title')
      }
    }
  })
}

function getStatusTooltip(status: string): string {
  switch (status) {
    case 'offline': return 'Offline - Not connected to Peerdraft. Changes will be merged when connected.'
    case 'syncing': return 'Syncing - Synchronizing with Peerdraft'
    case 'insync': return 'In sync - Synchronized with Peerdraft'
    case 'warning': return 'Warning - Offline with no synced data (data may be lost!)'
    case 'disconnected': return 'Disconnected - No peers connected'
    case 'connected': return 'Connected - Peers connected'
    default: return ''
  }
}

export const removeStatusClass = async (path: string, plugin: PeerdraftPlugin) => {
  await updateStatusClasses([path], plugin, 'not-initialized', undefined, true)
}


// fix by https://github.com/dtkav
const getFileExplorers = async (plugin: PeerdraftPlugin, onLoaded?: (leaf: WorkspaceLeaf) => void) => {
  // IMPORTANT: manually iterate — make.md monkeypatches getLeavesOfType
  const fileExplorers: WorkspaceLeaf[] = [];
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    const viewType = leaf.view.getViewType();
    if (viewType === "file-explorer") {
      if (!fileExplorers.includes(leaf)){
        fileExplorers.push(leaf);
      }
    }
  });
  const loadedExplorers = await Promise.all(fileExplorers.map(async leaf => {
    try {
      await leaf.loadIfDeferred()
      onLoaded?.(leaf)
      return leaf
    } catch (error) {
      console.error('[Peerdraft] Could not load a file explorer for status updates.', error)
      return undefined
    }
  }))
  return loadedExplorers.filter((leaf): leaf is WorkspaceLeaf => leaf !== undefined)
}
