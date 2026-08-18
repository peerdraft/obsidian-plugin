import type { WorkspaceLeaf } from "obsidian"
import PeerdraftPlugin from "src/peerdraftPlugin"

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

export const setStatusClass = async (path: string, plugin: PeerdraftPlugin, status: 'offline' | 'syncing' | 'insync' | 'warning' | 'disconnected' | 'connected' | 'not-initialized') => {
  const fileExplorers = await getFileExplorers(plugin)
  fileExplorers.forEach(fileExplorer => {
    //@ts-expect-error
    const fileItem = fileExplorer.view.fileItems[path];
    if (!fileItem) return
    const el = fileItem.innerEl as HTMLElement
    
    // Remove peerdraft icon and all status classes first
    el.removeClass('pd-explorer-shared', 'pd-status-offline', 'pd-status-syncing', 'pd-status-insync', 'pd-status-warning', 'pd-status-disconnected', 'pd-status-connected')
    
    // Add the appropriate status class
    if (status !== 'not-initialized') {
      el.addClass(`pd-status-${status}`)
      // Add tooltip
      el.setAttribute('title', getStatusTooltip(status))
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
  const fileExplorers = await getFileExplorers(plugin)
  fileExplorers.forEach(fileExplorer => {
    //@ts-expect-error
    const fileItem = fileExplorer.view.fileItems[path];
    if (!fileItem) return
    const el = fileItem.innerEl as HTMLElement
    el.removeClass('pd-status-offline', 'pd-status-syncing', 'pd-status-insync', 'pd-status-warning', 'pd-status-disconnected', 'pd-status-connected')
    // Remove tooltip
    el.removeAttribute('title')
  })
}


// fix by https://github.com/dtkav
const getFileExplorers = async (plugin: PeerdraftPlugin) => {
  // IMPORTANT: manually iterate — make.md monkeypatches getLeavesOfType
  const fileExplorers: WorkspaceLeaf[] = [];
  plugin.app.workspace.iterateAllLeaves(async (leaf) => {
    const viewType = leaf.view.getViewType();
    if (viewType === "file-explorer") {
      if (!fileExplorers.includes(leaf)){
        await leaf.loadIfDeferred()
        fileExplorers.push(leaf);
      }
    }
  });
  return fileExplorers;
}