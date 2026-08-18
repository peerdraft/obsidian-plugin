import { Modal, Plugin, PluginSettingTab, Setting, debounce, normalizePath, requestUrl } from "obsidian";
import { showTextModal } from "./ui";
import PeerdraftPlugin from "./peerdraftPlugin";
import { promptForFolderSelection } from "./ui/selectFolder";
import { PermanentShareStoreIndexedDB } from "./permanentShareStore";
import { getJWT, logout } from "./login";
import { openLoginModal } from "./ui/login";

interface ShareUsageResponse {
  currentCount: number;
  limit: number | null;
  remaining: number | null;
  tierDisplayName: string;
}

interface AccountSettingsResponse {
  plan: {
    tier: string;
    displayName: string;
    expiresAt: string | null;
    renewsAt: string | null;
  };
  shares: {
    current: number;
    limit: number | null;
    warningMessage: string | null;
  };
  upgrade?: {
    title: string;
    content: string;
    options: Array<{
      id: string;
      label: string;
      url: string;
      highlighted?: boolean;
      comment?: string;
    }>;
  };
}

const fetchAccountSettings = async (plugin: PeerdraftPlugin): Promise<AccountSettingsResponse | null> => {
  const jwt = getJWT(plugin.settings.oid) || plugin.serverSync.jwt;
  if (!jwt) return null;

  try {
    const response = await requestUrl({
      url: plugin.settings.basePath + "/account/settings",
      method: 'GET',
      headers: {
        "Authorization": "Bearer " + jwt
      }
    });
    return response.json as AccountSettingsResponse;
  } catch (e) {
    console.error("Error fetching account settings:", e);
    return null;
  }
};

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
    type: string
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
    type: "Free",
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

// Injected by esbuild `define` from PEERDRAFT_DEV_SERVER_URL (see esbuild.config.mjs)
declare const PEERDRAFT_DEV_SERVER_URL: string

const settingsFromBaseUrl = (baseUrl: string): Partial<Settings> => {
  const wsBase = baseUrl.replace(/^http/, "ws")
  return {
    basePath: baseUrl,
    subscriptionAPI: `${baseUrl}/subscription`,
    connectAPI: `${baseUrl}/subscription/connect`,
    sessionAPI: `${baseUrl}/session`,
    sync: `${wsBase}/sync`,
    signaling: `${wsBase}/signal`,
    actives: `${wsBase}/actives`,
  }
}

const FORCE_SETTINGS: Partial<Settings> = settingsFromBaseUrl(PEERDRAFT_DEV_SERVER_URL)

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

  const generalSection = el.createDiv({ cls: "pd-settings-section" });
  generalSection.createEl("h2", { text: "General", cls: "pd-section-header" });

  new Setting(generalSection)
    .setName("Display Name")
    .setDesc("This name will be shown to your collaborators")
    .addText((text) => {
      text.setValue(settings.name)
      text.onChange(async (value) => {
        settings.name = value
        saveSettings(settings, plugin);
      })
    })

  const pathSetting = new Setting(generalSection)
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

  const accountSection = el.createDiv({ cls: "pd-settings-section" });
  accountSection.createEl("h2", { text: "Your Account", cls: "pd-section-header" })

  if (plugin.serverSync.authenticated) {
    accountSection.createEl("div", { text: `You are logged in as ${plugin.settings.plan.email}.` })

    const accountDiv = accountSection.createEl("div", { text: "Loading account information..." })
    
    fetchAccountSettings(plugin).then(settings => {
      if (!settings) {
        accountDiv.setText("Could not load account information.")
        return;
      }

      accountDiv.empty()

      // Plan Status subsection
      const planSubsection = accountDiv.createDiv({ cls: "pd-account-subsection" })
      const planDiv = planSubsection.createEl("div")
      planDiv.createSpan({ text: "You are on the " }).createEl('b', { text: settings.plan.displayName })
      planDiv.createSpan({ text: " plan." })
      
      // Show expiry/renewal info
      if (settings.plan.expiresAt) {
        const expiryDate = new Date(settings.plan.expiresAt);
        const daysRemaining = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        planSubsection.createEl("div", { 
          text: `Trial expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
          cls: "setting-item-description"
        })
      } else if (settings.plan.renewsAt) {
        const renewalDate = new Date(settings.plan.renewsAt);
        planSubsection.createEl("div", { 
          text: `Renews on ${renewalDate.toLocaleDateString()}`,
          cls: "setting-item-description"
        })
      }

      // Share Usage subsection
      const sharesSubsection = accountDiv.createDiv({ cls: "pd-account-subsection" })
      const sharesDiv = sharesSubsection.createEl("div")
      if (settings.shares.limit === null) {
        sharesDiv.createSpan({ text: `You have ${settings.shares.current} active shares (unlimited).` })
      } else {
        sharesDiv.createSpan({ text: `You have ` })
        sharesDiv.createEl('b', { text: `${settings.shares.current} / ${settings.shares.limit}` })
        sharesDiv.createSpan({ text: ` active shares.` })
      }

      // Warning message
      if (settings.shares.warningMessage) {
        sharesSubsection.createEl("div", {
          text: `⚠️ ${settings.shares.warningMessage}`,
          cls: "mod-warning"
        })
      }

      // Upgrade section
      if (settings.upgrade && settings.upgrade.options.length > 0) {
        accountDiv.createEl("h2", { text: settings.upgrade.title })
        
        // Render HTML content
        const contentDiv = accountDiv.createDiv()
        contentDiv.innerHTML = settings.upgrade.content
        
        // Render buttons
        const upgradeSection = accountDiv.createDiv({ cls: "setting-item" })
        const upgradeControls = upgradeSection.createDiv({ cls: "setting-item-control" })
        
        settings.upgrade.options.forEach(option => {
          const button = upgradeControls.createEl("button", { 
            text: option.label,
            cls: option.highlighted ? "mod-cta" : undefined
          })
          if (upgradeControls.children.length > 1) {
            button.style.marginLeft = "8px"
          }
          button.addEventListener("click", () => {
            window.open(option.url)
          })
        })
        
        // Show comment if available
        const optionWithComment = settings.upgrade.options.find(o => o.comment);
        if (optionWithComment) {
          accountDiv.createEl("div", { 
            text: `💡 ${optionWithComment.comment}`,
            cls: "setting-item-description"
          })
        }
      }
    })

    new Setting(accountSection)
      .setName("Log out")
      .addButton(button => {
        button.setButtonText("Log out")
        button.onClick(async (e) => {
          await logout(plugin)
          renderSettings(el, plugin)
        })
      })
  } else {
    accountSection.createEl("div", { text: `You are not logged in.` })
    accountSection.createEl("div", { text: `To initiate new shared documents or folders you need to log in to your Peerdraft account. If you only work on shared documents and folders created by others, you don't need an account.` })

    new Setting(accountSection)
      .setName("Log in or create account")
      .addButton(button => {
        button.setButtonText("Log in or create account")
        button.onClick(async (e) => {
          await openLoginModal(plugin)
          renderSettings(el, plugin)
        })
      })
  }

  const helpSection = el.createDiv({ cls: "pd-settings-section" });
  helpSection.createEl("h2", { text: "Help", cls: "pd-section-header" })
  const div = helpSection.createDiv()
  div.createSpan({ text: "If you need any help, " })
  div.createEl("a", {
    text: "get in touch",
    attr: {
      href: "mailto:dominik@peerdraft.app"
    }
  })
  div.createSpan({ text: " or join our " })
  div.createEl("a", {
    text: "Discord community",
    attr: {
      href: "https://discord.gg/bKtVfTAkXt"
    }
  })
  div.createSpan({ text: ". Also check out our " })
  div.createEl("a", {
    text: "Documentation",
    attr: {
      href: "https://www.peerdraft.app/documentation"
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