import { MarkdownView, Plugin, TFile, TFolder } from "obsidian"
import { Settings, createSettingsModal, createSettingsTab, getSettings, migrateSettings, saveSettings } from "./settings"
import { PeerdraftRecord } from "./utils/peerdraftRecord"
import { PeerdraftLeaf } from "./workspace/peerdraftLeaf"
import { PermanentShareStore } from "./permanentShareStore"
import { ServerAPI } from "./serverAPI"
import { SharedDocument } from "./sharedEntities/sharedDocument"
import { getLeafsByPath, updatePeerdraftWorkspace } from "./workspace/peerdraftWorkspace"
import { SharedFolder } from "./sharedEntities/sharedFolder"
import { promptForSessionType } from "./ui/chooseSessionType"
import { promptForName, promptForURL } from "./ui/enterText"
import { SharedEntity } from "./sharedEntities/sharedEntity"
import { prepareCommunication } from "./cookie"

export default class PeerdraftPlugin extends Plugin {

	settings: Settings
	pws: PeerdraftRecord<PeerdraftLeaf>
	permanentShareStore: PermanentShareStore
	serverAPI: ServerAPI

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

		plugin.pws.on('add', (key, leaf) => {
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
		
		/*
		plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFolder) {
				menu.addItem((item) => {
					item.setTitle('Share Folder')
					item.setIcon('users')
					item.onClick(() => {
						console.log("clicked " + file.path)
						SharedFolder.fromTFolder(file, plugin)
					})
				})
			}
		}))
		*/

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

				SharedDocument.fromView(view, plugin, { isPermanent: false }).then(doc => {
					if (!doc) {
						return console.log("ERROR creating sharedDoc")
					}
				})

				/*
				promptForSessionType(plugin.app).then(result => {
					if (!result) return
					SharedDocument.fromView(view, plugin, { isPermanent: result.permanent }).then(doc => {
						if (!doc) {
							return console.log("ERROR creating sharedDoc")
						}
					})
				})
				*/
			}
		})

		plugin.addCommand({
			id: 'stop-session-with-active-document',
			name: 'Stop working together on this document',
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file
				if (!file) return false
				const doc = SharedDocument.findByPath(file.path)
				console.log(doc)
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
					await SharedEntity.fromShareURL(url.text, plugin)
				}
			}
		})

		/*

		plugin.addCommand({
			id: 'start-session-with-active-document',
			name: 'Start shared session',
			checkCallback(checking) {
				const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
				if (!view) return false;
				const file = view.file
				if (!file) return false
				const sharedAlready = syncedDocs[file.path]
				if (sharedAlready) return false
				if (checking) return true
				// do it
				startSession(view, file, plugin)
			},
		});

		plugin.addCommand({
			id: 'stop-session-with-active-document',
			name: 'Stop shared session',
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file
				if (!file) return false
				const id = syncedDocs[file.path]
				if (!id) return false
				if (checking) return true
				endSharing(file.path, plugin).then(() => {
					stopSession(file, plugin)
				})
			}
		});

		plugin.addCommand({
			id: 'join-session',
			name: 'Join shared session',
			callback: async () => {
				// ask for url
				const input = await promptForMultipleTextInputs(this.app, [{
					description: "Enter your share URL",
					name: "URL"
				}])
				if (!input || input.length < 1) return
				const url = input.pop()?.value
				if (!url) return
				joinSession(url, this)
			}
		})

		plugin.addCommand({
			id: 'share',
			name: 'Share this document',
			checkCallback(checking) {
				const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
				if (!view) return false;
				const file = view.file
				if (!file) return false
				const sharedAlready = syncedDocs[file.path]
				if (sharedAlready) return false
				if (checking) return true

				// do it

				shareFile(view, file, plugin)
			},
		});


		plugin.addCommand({
			id: 'add-shared',
			name: 'Add a shared file from someone else',
			callback: async () => {
				// ask for url
				const input = await promptForMultipleTextInputs(this.app, [{
					description: "Enter your share URL",
					name: "URL"
				}])
				if (!input || input.length < 1) return
				const url = input.pop()?.value
				if (!url) return
				addSharedFile(url, plugin)
			}
		})
		*/

		/*
		plugin.register(around(MarkdownView.prototype, {
			onUnloadFile(next) {
				return async function (file) {
					stopSession(file)
					return next.call(this, file)
				}
			}
		}))
		**/

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile) {
				const doc = SharedDocument.findByPath(oldPath)
				if (doc) {
					doc.setNewFileLocation(file)
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
		SharedDocument.getAll().map((doc) => {
			doc.destroy()
		})
	}

}

