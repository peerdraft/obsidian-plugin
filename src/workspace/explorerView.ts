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


// fix by https://github.com/dtkav
const getFileExplorers = async (plugin: PeerdraftPlugin) => {
  // IMPORTANT: We manually iterate because a popular plugin make.md monkeypatches
  // getLeavesOfType to return their custom folder explorer.
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