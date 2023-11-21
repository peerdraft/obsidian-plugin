import { Modal, Plugin, PluginSettingTab, Setting } from "obsidian";

export interface Settings {
  signaling: Array<string>,
  basePath: string,
  name: string
}

const DEFAULT_SETTINGS: Settings = {
  basePath: "https://www.peerdraft.app/cm/",
  name: "",
  signaling: ["wss://signal.peerdraft.app"]
}

export const getSettings = async (plugin: Plugin) => {
  const settings = Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData()) as Settings
  return settings
}

export const saveSettings = async (settings: Settings, plugin: Plugin) => {
  await plugin.saveData(settings)
}

export const createSettingsTab = (plugin: Plugin) => {
  return new class extends PluginSettingTab {
    async display() {
      const containerEl = this.containerEl
      containerEl.empty();

      const settings = await getSettings(plugin)
      const setting = new Setting(containerEl)

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
  }(plugin.app, plugin)
}

export const createSettingsModal = (plugin: Plugin) => {
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