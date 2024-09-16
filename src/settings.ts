import { Modal, Plugin, PluginSettingTab, Setting, debounce, normalizePath, requestUrl } from "obsidian";
import { showTextModal } from "./ui";
import PeerdraftPlugin from "./peerdraftPlugin";
import { promptForFolderSelection } from "./ui/selectFolder";
import { PermanentShareStoreIndexedDB } from "./permanentShareStore";
import { logout } from "./login";
import { openLoginModal } from "./ui/login";

export interface Settings {
  signaling: string,
  sync: string,
  subscriptionAPI: string,
  connectAPI: string,
  sessionAPI: string
  actives: string,
  basePath: string,
  name: string,
  oid: string,
  plan: {
    type: "hobby" | "professional" | "team"
    email?: string
  },
  root: string,
  duration: number,
  debug: boolean,
  version: string,
  serverShares: {
    folders: Map<string, { persistenceId: string, shareId: string }>
    files: Map<string, { persistenceId: string, shareId: string }>
  }
}

const DEFAULT_SETTINGS: Omit<Settings, "oid"> = {
  basePath: "https://www.peerdraft.app",
  subscriptionAPI: "https://www.peerdraft.app/subscription",
  connectAPI: "https://www.peerdraft.app/subscription/connect",
  sessionAPI: "https://www.peerdraft.app/session",
  sync: "wss://www.peerdraft.app/sync",
  signaling: "wss://www.peerdraft.app/signal",
  actives: "wss://www.peerdraft.app/actives",
  name: "",
  root: "",
  plan: {
    type: "hobby",
    email: ""
  },
  duration: 0,
  debug: false,
  version: '',
  serverShares: {
    files: new Map<string, { persistenceId: string, shareId: string }>(),
    folders: new Map<string, { persistenceId: string, shareId: string }>()
  }
}

const FORCE_SETTINGS: Partial<Settings> = {
/*
  basePath: "http://localhost:5173",
  subscriptionAPI: "http://localhost:5173/subscription",
  connectAPI: "http://localhost:5173/subscription/connect",
  sessionAPI: "http://localhost:5173/session",
  sync: "ws://localhost:5173/sync",
  signaling: "ws://localhost:5173/signal",
  actives: "ws://localhost:5173/actives"
*/
  basePath: "https://www.peerdraft.app",
  subscriptionAPI: "https://www.peerdraft.app/subscription",
  connectAPI: "https://www.peerdraft.app/subscription/connect",
  sessionAPI: "https://www.peerdraft.app/session",
  sync: "wss://www.peerdraft.app/sync",
  signaling: "wss://www.peerdraft.app/signal",
  actives: "wss://www.peerdraft.app/actives",

}

export const migrateSettings = async (plugin: PeerdraftPlugin) => {
  const oldSettings = await getSettings(plugin)

  const newSettings: Settings = Object.assign({}, DEFAULT_SETTINGS, oldSettings, FORCE_SETTINGS, {
    version: plugin.manifest.version
  })
  //@ts-expect-error
  newSettings.oid = oldSettings?.oid ?? plugin.app.appId

  const files = newSettings.serverShares.files
  for (const key of files.keys()) {
    if (key.contains('\\')) {
      files.set(normalizePath(key), files.get(key)!)
      files.delete(key)
    }
  }

  const folders = newSettings.serverShares.folders
  for (const key of folders.keys()) {
    if (key.contains('\\')) {
      folders.set(normalizePath(key), folders.get(key)!)
      folders.delete(key)
    }
  }

  if (oldSettings?.oid && newSettings.serverShares.files.size === 0 && newSettings.serverShares.folders.size === 0) {
    const db = new PermanentShareStoreIndexedDB(oldSettings.oid)
    const docs = await db.getAllDocs()
    docs.forEach(doc => {
      newSettings.serverShares.files.set(normalizePath(doc.path), { persistenceId: doc.persistenceId, shareId: doc.shareId })
    })
    const folders = await db.getAllFolders()
    folders.forEach(doc => {
      newSettings.serverShares.folders.set(normalizePath(doc.path), { persistenceId: doc.persistenceId, shareId: doc.shareId })
    })
    await saveSettingsNow(newSettings, plugin)
    await db.deleteDB()
  }

  await saveSettingsNow(newSettings, plugin)

  if (oldSettings && oldSettings.version != newSettings.version) {
    showTextModal(plugin.app, 'Peerdraft updated', 'A new version of Peerdraft was installed. Please restart Obsidian before you use Peerdraft again.')
  }

  return newSettings

}

export const getSettings = async (plugin: Plugin) => {
  const settings = await plugin.loadData() as Settings
  if (settings) {
    settings.serverShares = {
      files: new Map(settings.serverShares?.files),
      folders: new Map(settings.serverShares?.folders)
    }
  }
  return settings
}

export const saveSettingsNow = async (settings: Settings, plugin: PeerdraftPlugin) => {

  const serialized = JSON.parse(JSON.stringify(settings))

  serialized.serverShares = {
    files: Array.from(settings.serverShares.files.entries()),
    folders: Array.from(settings.serverShares.folders.entries())
  }

  await plugin.saveData(serialized)
}

export const saveSettings = debounce(saveSettingsNow, 1000, true)

export const renderSettings = async (el: HTMLElement, plugin: PeerdraftPlugin) => {
  el.empty();

  const settings = plugin.settings

  el.createEl("h1", { text: "General" });

  new Setting(el)
    .setName("Display Name")
    .setDesc("This name will be shown to your collaborators")
    .addText((text) => {
      text.setValue(settings.name)
      text.onChange(async (value) => {
        settings.name = value
        saveSettings(settings, plugin);
      })
    })

  const pathSetting = new Setting(el)
  pathSetting.setName("Root Folder")
  pathSetting.setDesc("When you import a share from someone else it will be created in this folder.")
  pathSetting.addText(text => {
    text.setValue(settings.root)
    text.onChange(async value => {
      settings.root = value
      saveSettings(settings, plugin)
    })

    pathSetting.addExtraButton(button => {
      button.setIcon('search')
      button.onClick(async () => {
        const folder = await promptForFolderSelection(plugin.app)
        if (folder) {
          text.setValue(folder.path)
          settings.root = folder.path
          saveSettings(settings, plugin)
        }
      })
    })
  })

  el.createEl("h1", { text: "Your Account" })

  if (plugin.serverSync.authenticated) {
    el.createEl("div", { text: `You are logged in as ${plugin.settings.plan.email}.` })
    el.createEl("p")
    const div = el.createEl("div")
    div.createSpan({ text: "You are on the "}).createEl('b', { text:  plugin.settings.plan.type})
    div.createSpan({ text: " plan."})
    el.createEl("p")

    if (plugin.settings.plan.type === "hobby") {
      new Setting(el)
        .setName("Manage your subscription")
        .addButton(button => {
          button.setButtonText("Upgrade to pro")
          button.setCta()
          button.onClick((e) => {
            window.open(`https://peerdraft.app/checkout?email=${plugin.settings.plan.email}`)
          })
        })
    }

    new Setting(el)
      .setName("Log out")
      .addButton(button => {
        button.setButtonText("Log out")
        button.onClick(async (e) => {
          await logout(plugin)
          renderSettings(el, plugin)
        })
      })
  } else {
    el.createEl("div", { text: `You are not logged in.` })
    el.createEl("p")
    el.createEl("div", { text: `To initiate new shared documents or folders you need to log in to your Peerdraft account. If you only work on shared documents and folders created by others, you don't need an account.` })
    el.createEl("p")

    new Setting(el)
      .setName("Log in or create account")
      .addButton(button => {
        button.setButtonText("Log in or create account")
        button.onClick(async (e) => {
          await openLoginModal(plugin)
          renderSettings(el, plugin)
        })
      })
  }

  el.createEl("h1", { text: "Help" })
  const div = el.createDiv()
  div.createSpan({ text: "If you need any help, " })
  div.createEl("a", {
    text: "get in touch",
    attr: {
      href: "mailto:dominik@peerdraft.app"
    }
  })
  div.createSpan({ text: '.' })

}

export const createSettingsTab = (plugin: PeerdraftPlugin) => {
  return new class extends PluginSettingTab {
    async display() {
      await renderSettings(this.containerEl, plugin)
    }
  }(plugin.app, plugin)
}

export const createSettingsModal = (plugin: PeerdraftPlugin) => {
  return new class extends Modal {

    async onOpen() {
      const el = this.contentEl
      el.empty();

      const settings = await getSettings(plugin)

      el.createEl("h1", { text: "What's your name?" });

      const setting = new Setting(el)
      setting.setName("Name")
      setting.setDesc("This name will be shown to your collaborators")
      setting.addText((text) => {
        text.setValue(settings.name)
        text.onChange(async (value) => {
          settings.name = value
          await saveSettings(settings, plugin);
        })
      })
    }

    onClose() {
      this.contentEl.empty()
    }

  }(plugin.app)
}