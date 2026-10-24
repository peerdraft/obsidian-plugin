import { MarkdownView, Menu, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import PeerdraftPlugin from "src/peerdraftPlugin";
import { SharedFolder } from "src/sharedEntities/sharedFolder";
import { openFolderOptions } from "./folderOptions";
import { SharedDocument } from "src/sharedEntities/sharedDocument";
import { promptForSessionType } from "./chooseSessionType";
import { openFileInNewTab, showNotice } from "src/ui";

/** Saved membership is available before the runtime folder is restored. */
const isInSavedFolder = (filePath: string, plugin: PeerdraftPlugin): boolean => {
  const normalizedPath = normalizePath(filePath)
  for (const path of plugin.settings.serverShares.folders.keys()) {
    const root = normalizePath(path).replace(/\/+$/, '')
    if (!root || normalizedPath === root || normalizedPath.startsWith(root + '/')) return true
  }
  return false
}

export const createMenuAsSubMenu = (menu: Menu, file: TAbstractFile, plugin: PeerdraftPlugin) => {
  menu.addItem(item => {
    //@ts-expect-error
    const submenu = item.setSubmenu() as Menu
    item.setIcon("users")
    item.setTitle("Peerdraft")
    createMenu(submenu, file, plugin)
  })
}


export const createMenu = (menu: Menu, file: TAbstractFile, plugin: PeerdraftPlugin, prefix: string = "") => {
  if (file instanceof TFolder) {
    const sharedFolder = SharedFolder.findByPath(file.path)
    const shareId = sharedFolder?.shareId ?? plugin.settings.serverShares.folders.get(normalizePath(file.path))?.shareId
    if (!shareId) {
      if (!SharedFolder.getSharedFolderForSubPath(file.path) && !isInSavedFolder(file.path, plugin)) {
        menu.addItem((item) => {
          item.setTitle('Share Folder')
          item.setIcon('share-2')
          item.onClick(() => {
            void SharedFolder.fromTFolder(file, plugin)
          })
        })
      }
    } else {
      menu.addItem(item => {
        item.setTitle('Copy URL')
        item.setIcon('clipboard-copy')
        item.onClick(() => {
          void navigator.clipboard.writeText(plugin.settings.basePath + '/team/' + shareId)
        })
      })
      menu.addItem(item => {
        item.setTitle('Re-create folder from server')
        item.setIcon('refresh-cw')
        if (!sharedFolder) item.setDisabled(true)
        item.onClick(async () => {
          if (!sharedFolder) return
          await SharedFolder.recreate(sharedFolder, plugin)
        })
      })
      menu.addItem(item => {
        item.setTitle('Stop syncing with this vault')
        item.setIcon('refresh-cw-off')
        if (!sharedFolder) item.setDisabled(true)
        item.onClick(async () => {
          if (!sharedFolder) return
          await sharedFolder.unshare()
        })
      })
      menu.addItem(item => {
        item.setTitle('Stop syncing for everyone')
        item.setIcon('circle-off')
        if (!sharedFolder) item.setDisabled(true)
        item.onClick(async () => {
          if (!sharedFolder) return
          await SharedFolder.stopSession(sharedFolder.shareId, plugin)
        })
      })
      menu.addItem(item => {
        item.setTitle('Show folder options')
        item.setIcon('settings')
        if (!sharedFolder) item.setDisabled(true)
        item.onClick(async () => {
          if (!sharedFolder) return
          void openFolderOptions(plugin.app, sharedFolder)
        })
      })
    }
  } else if (file instanceof TFile) {
    const sharedDocument = SharedDocument.findByPath(file.path)
    const sharedFolder = SharedFolder.getSharedFolderForSubPath(file.path)
    const shareId = sharedDocument?.shareId ?? plugin.settings.serverShares.files.get(normalizePath(file.path))?.shareId
    const hasSharedParent = !!sharedFolder || isInSavedFolder(file.path, plugin)
    if (shareId) {
      menu.addItem(item => {
        item.setTitle(prefix + 'Copy URL')
        item.setIcon('clipboard-copy')
        item.onClick(() => {
          void navigator.clipboard.writeText(plugin.settings.basePath + '/cm/' + shareId)
        })
      })
      if (hasSharedParent) {
        menu.addItem(item => {
          item.setTitle(prefix + 'Delete and remove from Shared Folder')
          item.setIcon('trash')
          if (!sharedDocument || !sharedFolder) item.setDisabled(true)
          item.onClick(async () => {
            if (!sharedDocument || !sharedFolder) return
            const fileName = sharedDocument.file.basename
            let cleanupFailed = false
            try {
              await plugin.serverSync.stopSession(sharedDocument.shareId)
            } catch {
              showNotice("Could not confirm the session stop. The document was kept in the shared folder. Please try again.")
              return
            }
            sharedFolder.removeDocument(sharedDocument)
            try {
              await sharedDocument.unshare()
            } catch {
              cleanupFailed = true
              showNotice("Local cleanup failed after removing the document from the shared folder.")
            }
            try {
              await plugin.app.vault.delete(sharedDocument.file)
            } catch {
              cleanupFailed = true
              showNotice("The file could not be deleted from this vault.")
            }
            if (!cleanupFailed) {
              showNotice(`${fileName} removed from shared folder.`)
            }
          })
        })
      } else {
        menu.addItem(item => {
          item.setTitle(prefix + 'Stop syncing with this vault')
          item.setIcon('refresh-cw-off')
          if (!sharedDocument) item.setDisabled(true)
          item.onClick(async () => {
            if (!sharedDocument) return
            await sharedDocument.unshare()
          })
        })
        menu.addItem(item => {
          item.setTitle(prefix + 'Stop syncing for everyone')
          item.setIcon('circle-off')
          if (!sharedDocument) item.setDisabled(true)
          item.onClick(async () => {
            if (!sharedDocument) return
            await SharedDocument.stopSession(sharedDocument.shareId, plugin)
          })
        })
      }
    } else if (sharedFolder && file instanceof TFile) {
      // Check if file is actually synced as binary by looking in binaryFilesMap
      const relativePath = normalizePath(file.path.slice(sharedFolder.root.path.length + 1))
      const isBinaryFile = sharedFolder.yDoc.getMap('binaryFiles').has(relativePath)
      
      if (isBinaryFile) {
        // Binary file synced in shared folder
        menu.addItem(item => {
          item.setTitle(prefix + 'Delete and remove from Shared Folder')
          item.setIcon('trash')
          item.onClick(async () => {
            // Remove from binaryFilesMap in Y.Doc
            sharedFolder.yDoc.getMap('binaryFiles').delete(relativePath)
            // Delete local file
            void plugin.app.vault.delete(file)
          })
        })
      }
    } else if (!sharedDocument && !hasSharedParent && ['md', 'MD', 'canvas'].includes(file.extension)) {

      menu.addItem((item) => {
        item.setTitle(prefix + 'Share File')
        item.setIcon('share-2')
        item.onClick(async () => {
          const result = await promptForSessionType(plugin.app)
          if (!result) return
          const leaf = await openFileInNewTab(file, plugin.app.workspace)
          void SharedDocument.fromView(leaf.view as MarkdownView, plugin, { permanent: result.permanent })
        })
      })
    }
  }
}
