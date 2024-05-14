import { Modal, Plugin, PluginSettingTab, Setting, debounce, requestUrl } from "obsidian";
import { refreshSubscriptionData } from "./subscription";
import { showTextModal } from "./ui";
import PeerdraftPlugin from "./peerdraftPlugin";
import { promptForFolderSelection } from "./ui/selectFolder";
import { PermanentShareStoreIndexedDB } from "./permanentShareStore";

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
  newSettings.oid = oldSettings.oid ?? plugin.app.appId

  if (newSettings.serverShares.files.size === 0 && newSettings.serverShares.folders.size === 0) {
    const db = new PermanentShareStoreIndexedDB(oldSettings.oid)
    const docs = await db.getAllDocs()
    docs.forEach(doc => {
      newSettings.serverShares.files.set(doc.path, { persistenceId: doc.persistenceId, shareId: doc.shareId })
    })
    const folders = await db.getAllFolders()
    folders.forEach(doc => {
      newSettings.serverShares.folders.set(doc.path, { persistenceId: doc.persistenceId, shareId: doc.shareId })
    })
    saveSettings(newSettings, plugin)
    await db.deleteDB()
  }

  saveSettings(newSettings, plugin)

  if (oldSettings && oldSettings.version != newSettings.version) {
    showTextModal(plugin.app, 'Peerdraft updated', 'A new version of Peerdraft was installed. Please restart Obsidian before you use Peerdraft again.')
  }

}

export const getSettings = async (plugin: Plugin) => {
  const settings = await plugin.loadData() as Settings
  settings.serverShares = {
    files: new Map(settings.serverShares?.files),
    folders: new Map(settings.serverShares?.folders)
  }
  return settings
}


export const saveSettings = debounce(async (settings: Settings, plugin: PeerdraftPlugin) => {

  const serialized = JSON.parse(JSON.stringify(settings))

  serialized.serverShares = {
    files: Array.from(settings.serverShares.files.entries()),
    folders: Array.from(settings.serverShares.folders.entries())
  }

  plugin.saveData(serialized)
}, 1000, true)

export const renderSettings = async (el: HTMLElement, plugin: PeerdraftPlugin) => {
  el.empty();

  const settings = await getSettings(plugin)

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


  el.createEl("h1", { text: "Your subscription" })
  if (settings.plan.type === "hobby") {
    el.createEl("div", { text: "You are on the free Hobby plan. You can collaborate with your peers for up to 2.5 hours a month. For unlimited collaboration time, sign-up for the Professional plan at 30 USD/year." })
    el.createEl("p")
    el.createEl("div", { text: `You have used Peerdraft for ${settings.duration} minutes so far.` })
    el.createEl("p")

    new Setting(el)
      .setName("Subscribe")
      .addButton(button => {
        button.setButtonText("Buy professional plan")
        button.setCta()
        button.onClick((e) => {
          window.open(`https://peerdraft.app/checkout?oid=${settings.oid}`)
        })
      })

    let connectEmail = ""
    new Setting(el)
      .setName("Use existing subscription")
      .setDesc("If you already bought a subscription, enter the e-mail address associated with it and click on `Connect`.")
      .addText((text) => {
        text.setPlaceholder("me@test.com")
        text.onChange((value) => {
          connectEmail = value
        })
      })
      .addButton(button => {
        button.setButtonText("Connect")
        button.onClick(async (e) => {
          const data = await requestUrl({
            url: settings.connectAPI,
            method: 'POST',
            contentType: "application/json",
            body: JSON.stringify({
              email: connectEmail,
              oid: settings.oid
            })

          }).json
          if (data && data.plan) {
            settings.plan = data.plan
            saveSettings(settings, plugin),
              await renderSettings(el, plugin)
          }
        })
      })

  } else if (settings.plan.type === "professional") {
    el.createEl("div", { text: "You are on the professional plan for unlimited collaboration. Happy peerdrafting." })
    el.createEl("p")
    el.createEl("div", { text: `You have used Peerdraft for ${settings.duration} minutes so far.` })
    el.createEl("p")
  }

  new Setting(el)
    .setName("Refresh subscription data")
    .setDesc("If you just subscribed or connected your license, click here to refresh your subscription information.")
    .addButton((button) => {
      button.setButtonText("Refresh")
      button.onClick(async (e) => {
        refreshSubscriptionData(plugin)
        renderSettings(el, plugin)
      })
    })

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