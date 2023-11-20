import { Menu, Notice, Plugin, TFile } from "obsidian";
import { statusBars, syncedDocs } from "./data";
import { Settings } from "./settings";
import { stopSync } from "./document";

export const addStatus = (file: TFile, plugin: Plugin, settings: Settings) => {
  const id = syncedDocs[file.path]
  if (!id) return

  const menu = new Menu()
  menu.addItem((item) => {
    item.setTitle("Copy Link")
    item.onClick(() => {
      navigator.clipboard.writeText(settings.basePath + id)
      new Notice("Link copied to Clipboard.")
    })
  })

  menu.addItem((item) => {
    item.setTitle("Stop shared session")
    item.onClick(() => {
      delete syncedDocs[file.path]
				stopSync(id)
        removeStatus(id)
				const notice = new Notice("Session stopped for " + file.name)
    })
  })


  const status = plugin.addStatusBarItem();
  status.addClass('mod-clickable')
  status.createEl("span", { text: "Sharing '" + file.name + "'" })
  status.onClickEvent((event) => {
    menu.showAtMouseEvent(event);
  })
  statusBars[id] = status
}

export const removeStatus = (id: string) => {
  const status = statusBars[id]
  if (!status) return
  delete statusBars[id]
  status.remove()
}

