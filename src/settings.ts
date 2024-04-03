import { Modal, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
import { createRandomId } from "./tools";
import { refreshSubscriptionData } from "./subscription";
import { showTextModal } from "./ui";
import PeerdraftPlugin from "./peerdraftPlugin";

export interface Settings {
  signaling: string,
  sync: string,
  subscriptionAPI: string,
  connectAPI: string,
  sessionAPI: string
  basePath: string,
  name: string,
  oid: string,
  plan: {
    type: "hobby" | "professional"
    email?: string
  },
  duration: number,
  version: string
}

const DEFAULT_SETTINGS: Settings = {
  basePath: "https://www.peerdraft.app/cm/",
  subscriptionAPI: "https://www.peerdraft.app/subscription",
  connectAPI: "https://www.peerdraft.app/subscription/connect",
  sessionAPI: "https://www.peerdraft.app/session",
  sync: "wss://www.peerdraft.app/sync",
  signaling: "wss://www.peerdraft.app/signal",
  name: "",
  oid: createRandomId(),
  plan: {
    type: "hobby",
    email: ""
  },
  duration: 0,
  version: '',
}

const FORCE_SETTINGS: Partial<Settings> = {
  /*
  basePath: "http://localhost:5173/cm/",
  subscriptionAPI: "http://localhost:5173/subscription",
  connectAPI: "http://localhost:5173/subscription/connect",
  sessionAPI: "http://localhost:5173/session",
  sync: "ws://localhost:5173/sync",
  signaling: "ws://localhost:5173/signal",
  */
  basePath: "https://www.peerdraft.app/cm/",
  subscriptionAPI: "https://www.peerdraft.app/subscription",
  connectAPI: "https://www.peerdraft.app/subscription/connect",
  sessionAPI: "https://www.peerdraft.app/session",
  sync: "wss://www.peerdraft.app/sync",
  signaling: "wss://www.peerdraft.app/signal"
}

export const migrateSettings = async (plugin: PeerdraftPlugin) => {
  const oldSettings = await getSettings(plugin)

  const newSettings = Object.assign({}, DEFAULT_SETTINGS, oldSettings, FORCE_SETTINGS, {
    version: plugin.manifest.version
  })
  await saveSettings(newSettings, plugin)

  if (oldSettings && oldSettings.version != newSettings.version) {
    showTextModal(plugin.app, 'Peerdraft updated', 'A new version of Peerdraft was installed. Please restart Obsidian before you use Peerdraft again.')
  }

}

export const getSettings = async (plugin: Plugin) => {
  const settings = await plugin.loadData() as Settings
  return settings
}

export const saveSettings = async (settings: Settings, plugin: PeerdraftPlugin) => {
  await plugin.saveData(settings)
  plugin.settings = settings
}

export const renderSettings = async (el: HTMLElement, plugin: PeerdraftPlugin) => {
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