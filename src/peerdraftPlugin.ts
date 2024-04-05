import { MarkdownView, Plugin, TFile, TFolder } from "obsidian"
import { ActiveStreamClient } from "./activeStreamClient"
import { prepareCommunication } from "./cookie"
import { PermanentShareStore } from "./permanentShareStore"
import { ServerAPI } from "./serverAPI"
import { Settings, createSettingsTab, getSettings, migrateSettings, saveSettings } from "./settings"
import { SharedDocument } from "./sharedEntities/sharedDocument"
import { fromShareURL } from "./sharedEntities/sharedEntityFactory"
import { SharedFolder } from "./sharedEntities/sharedFolder"
import { showNotice } from "./ui"
import { promptForSessionType } from "./ui/chooseSessionType"
import { promptForName, promptForURL } from "./ui/enterText"
import { PeerdraftRecord } from "./utils/peerdraftRecord"
import { PeerdraftLeaf } from "./workspace/peerdraftLeaf"
import { getLeafsByPath, updatePeerdraftWorkspace } from "./workspace/peerdraftWorkspace"

export default class PeerdraftPlugin extends Plugin {

	settings: Settings
	pws: PeerdraftRecord<PeerdraftLeaf>
	permanentShareStore: PermanentShareStore
	serverAPI: ServerAPI
	activeStreamClient: ActiveStreamClient

	async onload() {


		const plugin = this

		await migrateSettings(plugin)
		await prepareCommunication(plugin)

		plugin.settings = await getSettings(plugin)
		plugin.pws = new PeerdraftRecord<PeerdraftLeaf>()
		plugin.serverAPI = new ServerAPI({
			oid: plugin.settings.oid,
			permanentSessionUrl: plugin.settings.sessionAPI
		})

		plugin.activeStreamClient = new ActiveStreamClient(plugin.settings.actives)

		plugin.pws.on('add', (key, leaf) => {
			SharedDocument.findByPath(leaf.path)?.addExtensionToLeaf(key)
			leaf.on("changePath", (oldPath) => {
				const doc = SharedDocument.findByPath(oldPath)
				if (doc) {
					doc.removeExtensionFromLeaf(key)
					const leafs = getLeafsByPath(oldPath, plugin.pws)
					if (leafs.length === 0 && !doc.isPermanent) {
						doc.destroy()
					}
				}
				SharedDocument.findByPath(leaf.path)?.addExtensionToLeaf(key)
			})
		})

		plugin.pws.on('delete', (key, leaf) => {
			const doc = SharedDocument.findByPath(leaf.path)?.removeExtensionFromLeaf(key)
			const leafs = getLeafsByPath(leaf.path, plugin.pws)
			if (leafs.length === 0) {
				const doc = SharedDocument.findByPath(leaf.path)
				if (doc && !doc.isPermanent) {
					doc.destroy()
				}
			}
			leaf.destroy()
		})

		plugin.permanentShareStore = new PermanentShareStore(plugin.settings.oid)

		plugin.app.workspace.onLayoutReady(
			async () => {
				const permanentlySharedDocs = await plugin.permanentShareStore.getAllDocs()
				for (const doc of permanentlySharedDocs) {
					SharedDocument.fromPermanentShareDocument(doc, plugin)?.startWebSocketSync()
				}
				updatePeerdraftWorkspace(plugin.app.workspace, plugin.pws)
				plugin.registerEvent(plugin.app.workspace.on("layout-change", () => {
					updatePeerdraftWorkspace(plugin.app.workspace, plugin.pws)
				}))
			}
		)

		if (plugin.settings.plan.type === "team") {
			plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item.setTitle('Share Folder')
						item.setIcon('users')
						item.onClick(() => {
							SharedFolder.fromTFolder(file, plugin)
						})
					})
				}
			}))
		}

		plugin.addCommand({
			id: "share",
			name: "Start working together on this document",
			checkCallback(checking) {
				const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
				if (!view) return false;
				const file = view.file
				if (!file) return false
				const doc = SharedDocument.findByPath(file.path)
				if (doc) return false
				if (checking) return true
				// do it
				if (plugin.settings.plan.type === "team") {
					promptForSessionType(plugin.app).then(result => {
						if (!result) return
						SharedDocument.fromView(view, plugin, { isPermanent: result.permanent }).then(doc => {
							if (!doc) {
								return showNotice("ERROR creating sharedDoc")
							}
						})
					})
				} else {
					SharedDocument.fromView(view, plugin, { isPermanent: false }).then(doc => {
						if (!doc) {
							return showNotice("ERROR creating sharedDoc")
						}
					})
				}
			}
		})

		plugin.addCommand({
			id: 'stop-session-with-active-document',
			name: 'Stop working together on this document',
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file
				if (!file) return false
				const doc = SharedDocument.findByPath(file.path)
				if (!doc || doc.isPermanent) return false
				if (checking) return true
				doc.destroy()
			}
		});

		plugin.addCommand({
			id: "join",
			name: "Join session and add document from someone else",
			callback: async () => {
				const url = await promptForURL(plugin.app)
				if (url && url.text) {
					await fromShareURL(url.text, plugin)
				}
			}
		})

		this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
			if (file instanceof TFile) {
				const doc = SharedDocument.findByPath(oldPath)
				if (doc) {
					await doc.setNewFileLocation(file)
				}
			} else if (file instanceof TFolder) {
				const folder = SharedFolder.findByPath(oldPath)
				if (folder) {
					await folder.setNewFolderLocation(file)
				}
			}
		}))

		const settingsTab = createSettingsTab(plugin)
		const settings = await getSettings(plugin)

		if (!settings.name) {
			const name = await promptForName(plugin.app)
			if (name && name.text) {
				this.settings.name = name.text
				saveSettings(this.settings, plugin)
			}
		}
		plugin.addSettingTab(settingsTab)
	}

	onunload() {
		SharedDocument.getAll().forEach((doc) => {
			doc.destroy()
		})
		SharedFolder.getAll().forEach(folder => {
			folder.destroy()
		})
		this.activeStreamClient.destroy()
		this.permanentShareStore.close()
	}

}

