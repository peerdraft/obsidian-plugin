import { MarkdownView, Menu, TAbstractFile, TFile, TFolder } from "obsidian";
import PeerdraftPlugin from "src/peerdraftPlugin";
import { SharedFolder } from "src/sharedEntities/sharedFolder";
import { openFolderOptions } from "./folderOptions";
import { SharedDocument } from "src/sharedEntities/sharedDocument";
import { promptForSessionType } from "./chooseSessionType";
import { openFileInNewTab, showNotice } from "src/ui";

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
    // Not shared folder && not within shared folder
    const sharedFolder = SharedFolder.findByPath(file.path)
    if (!sharedFolder) {
      if (!SharedFolder.getSharedFolderForSubPath(file.path)) {
        menu.addItem((item) => {
          item.setTitle('Share Folder')
          item.setIcon('share-2')
          item.onClick(() => {
            SharedFolder.fromTFolder(file, plugin)
          })
        })
      }
    } else {
      menu.addItem(item => {
        item.setTitle('Copy URL')
        item.setIcon('clipboard-copy')
        item.onClick(() => {
          navigator.clipboard.writeText(plugin.settings.basePath + '/team/' + sharedFolder.shareId)
        })
      })
      menu.addItem(item => {
        item.setTitle('Re-create folder from server')
        item.setIcon('refresh-cw')
        item.onClick(async () => {
          await SharedFolder.recreate(sharedFolder, plugin)
        })
      })
      menu.addItem(item => {
        item.setTitle('Stop syncing with this vault')
        item.setIcon('refresh-cw-off')
        item.onClick(async () => {
          await sharedFolder.unshare()
        })
      })
      menu.addItem(item => {
        item.setTitle('Stop syncing for everyone')
        item.setIcon('circle-off')
        item.onClick(async () => {
          await SharedFolder.stopSession(sharedFolder.shareId, plugin)
        })
      })
      menu.addItem(item => {
        item.setTitle('Show folder options')
        item.setIcon('settings')
        item.onClick(async () => {
          openFolderOptions(plugin.app, sharedFolder)
        })
      })
    }
  } else if (file instanceof TFile) {
    const sharedDocument = SharedDocument.findByPath(file.path)
    const sharedFolder = SharedFolder.getSharedFolderForSubPath(file.path)
    if (sharedDocument) {
      menu.addItem(item => {
        item.setTitle(prefix + 'Copy URL')
        item.setIcon('clipboard-copy')
        item.onClick(() => {
          navigator.clipboard.writeText(plugin.settings.basePath + '/cm/' + sharedDocument.shareId)
        })
      })
      if (sharedFolder) {
        menu.addItem(item => {
          item.setTitle(prefix + 'Delete and remove from Shared Folder')
          item.setIcon('trash')
          item.onClick(async () => {
            sharedFolder.removeDocument(sharedDocument)
            sharedDocument.unshare()
            plugin.app.vault.delete(sharedDocument.file)
          })
        })
      } else {
        menu.addItem(item => {
          item.setTitle(prefix + 'Stop syncing with this vault')
          item.setIcon('refresh-cw-off')
          item.onClick(async () => {
            await sharedDocument.unshare()
          })
        })
        menu.addItem(item => {
          item.setTitle(prefix + 'Stop syncing for everyone')
          item.setIcon('circle-off')
          item.onClick(async () => {
            await SharedDocument.stopSession(sharedDocument.shareId, plugin)
          })
        })
      }
    } else if (!sharedFolder && ['md', 'MD'].includes(file.extension)) {

      menu.addItem((item) => {
        item.setTitle(prefix + 'Share File')
        item.setIcon('share-2')
        item.onClick(async () => {
          const result = await promptForSessionType(plugin.app)
          if (!result) return
          const leaf = await openFileInNewTab(file, plugin.app.workspace)
          SharedDocument.fromView(leaf.view as MarkdownView, plugin, { permanent: result.permanent })
        })
      })
    }
  }
}