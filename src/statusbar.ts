import { Menu, Plugin, TFile } from "obsidian";
import { statusBars, syncedDocs } from "./data";
import { Settings } from "./settings";
import { showNotice } from "./ui";
import { stopSession } from "./session";

export const addStatus = (file: TFile, plugin: Plugin, settings: Settings) => {
  const id = syncedDocs[file.path]
  if (!id) return

  const menu = new Menu()
  menu.addItem((item) => {
    item.setTitle("Copy link")
    item.onClick(() => {
      navigator.clipboard.writeText(settings.basePath + id)
      showNotice("Link copied to clipboard.")
    })
  })

  menu.addItem((item) => {
    item.setTitle("Stop shared session")
    item.onClick(() => {
      stopSession(file)
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

