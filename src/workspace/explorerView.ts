import PeerdraftPlugin from "src/peerdraftPlugin"

export const addIsSharedClass = (path: string, plugin: PeerdraftPlugin) => {
  const fileExplorers = plugin.app.workspace.getLeavesOfType('file-explorer')
  fileExplorers.forEach(fileExplorer => {
    //@ts-expect-error
    const fileItem = fileExplorer.view.fileItems[path];
    if (!fileItem) return
    const el = fileItem.innerEl as HTMLElement
    el.addClass('pd-explorer-shared')
  })
}

export const removeIsSharedClass = (path: string, plugin: PeerdraftPlugin) => {
  const fileExplorers = plugin.app.workspace.getLeavesOfType('file-explorer')
  fileExplorers.forEach(fileExplorer => {
    //@ts-expect-error
    const fileItem = fileExplorer.view.fileItems[path];
    if (!fileItem) return
    const el = fileItem.innerEl as HTMLElement
    el.removeClass('pd-explorer-shared')
  })
}