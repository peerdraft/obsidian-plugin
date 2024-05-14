import { MarkdownView, Plugin, TFile, TFolder } from "obsidian"
import { ActiveStreamClient } from "./activeStreamClient"
import { prepareCommunication } from "./cookie"
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
import { PeerdraftWebsocketProvider } from "./peerdraftWebSocketProvider"
import * as path from "path"

export default class PeerdraftPlugin extends Plugin {

	settings: Settings
	pws: PeerdraftRecord<PeerdraftLeaf>
	serverAPI: ServerAPI
	activeStreamClient: ActiveStreamClient
	serverSync: PeerdraftWebsocketProvider

	async onload() {

		const plugin = this

		await migrateSettings(plugin)
		await prepareCommunication(plugin)

		plugin.settings = await getSettings(plugin)
		console.log(plugin.settings)

		plugin.pws = new PeerdraftRecord<PeerdraftLeaf>()
		plugin.serverAPI = new ServerAPI({
			oid: plugin.settings.oid,
			permanentSessionUrl: plugin.settings.sessionAPI
		})

		plugin.activeStreamClient = new ActiveStreamClient(plugin.settings.actives, {
			maxBackoffTime: 300000,
			connect: true,
			resyncInterval: -1
		})

		plugin.pws.on('add', (key, leaf) => {
			SharedDocument.findByPath(leaf.path)?.addExtensionToLeaf(key)
			leaf.on("changePath", (oldPath) => {
				const doc = SharedDocument.findByPath(oldPath)
				if (doc) {
					doc.removeExtensionFromLeaf(key)
					const leafs = getLeafsByPath(oldPath, plugin.pws)
					if (leafs.length === 0 && !doc.isPermanent) {
						doc.unshare()
					}
				}
				SharedDocument.findByPath(leaf.path)?.addExtensionToLeaf(key)
			})
		})

		plugin.pws.on('delete', async (key, leaf) => {
			const doc = SharedDocument.findByPath(leaf.path)
			if (!doc) return
			doc.removeExtensionFromLeaf(key)
			const leafs = getLeafsByPath(leaf.path, plugin.pws)
			if (leafs.length === 0) {
				if (doc && !doc.isPermanent) {
					await doc.unshare()
				}
			}
			leaf.destroy()
		})

		plugin.app.workspace.onLayoutReady(
			async () => {
				for (const docs of plugin.settings.serverShares.files) {
					SharedDocument.fromPermanentShareDocument({ path: docs[0], persistenceId: docs[1].persistenceId, shareId: docs[1].shareId }, plugin)
				}
				for (const folder of plugin.settings.serverShares.folders) {
					SharedFolder.fromPermanentShareFolder({ path: folder[0], persistenceId: folder[1].persistenceId, shareId: folder[1].shareId }, plugin)
				}
				updatePeerdraftWorkspace(plugin.app.workspace, plugin.pws)
				plugin.registerEvent(plugin.app.workspace.on("layout-change", () => {
					updatePeerdraftWorkspace(plugin.app.workspace, plugin.pws)
				}))
				this.serverSync = new PeerdraftWebsocketProvider(this.settings.sync)
			}
		)

		plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFolder) {
				// Not shared folder && not within shared folder
				const sharedFolder = SharedFolder.findByPath(file.path)
				if (!sharedFolder) {
					if (!SharedFolder.getSharedFolderForSubPath(file.path) && plugin.settings.plan.type === "team") {
						menu.addItem((item) => {
							item.setTitle('Share Folder')
							item.setIcon('users')
							item.onClick(() => {
								SharedFolder.fromTFolder(file, plugin)
							})
						})
					}
				} else {
					menu.addItem(item => {
						item.setTitle('Copy Peerdraft URL')
						item.setIcon('users')
						item.onClick(() => {
							navigator.clipboard.writeText(plugin.settings.basePath + '/team/' + sharedFolder.shareId)
						})
					})
					menu.addItem(item => {
						item.setTitle('Stop syncing this folder')
						item.setIcon('refresh-cw-off')
						item.onClick(async () => {
							await sharedFolder.unshare()
						})
					})
					menu.addItem(item => {
						item.setTitle('Re-create sync from server')
						item.setIcon('refresh-cw')
						item.onClick(async () => {
							await SharedFolder.recreate(sharedFolder, plugin)
						})
					})
				}
			} else {
				const sharedDocument = SharedDocument.findByPath(file.path)
				const sharedFolder = SharedFolder.getSharedFolderForSubPath(file.path)
				if (sharedDocument) {
					menu.addItem(item => {
						item.setTitle('Copy Peerdraft URL')
						item.setIcon('users')
						item.onClick(() => {
							navigator.clipboard.writeText(plugin.settings.basePath + '/cm/' + sharedDocument.shareId)
						})
					})
					if (!sharedFolder) {
						menu.addItem(item => {
							item.setTitle('Stop syncing this document')
							item.setIcon('refresh-cw-off')
							item.onClick(async () => {
								await sharedDocument.unshare()
							})
						})
					}
				}
			}
		}))

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
						SharedDocument.fromView(view, plugin, { permanent: result.permanent }).then(doc => {
							if (!doc) {
								return showNotice("ERROR creating sharedDoc")
							}
						})
					})
				} else {
					SharedDocument.fromView(view, plugin, { permanent: false }).then(doc => {
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
				doc.unshare().then(() => { })
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

		if (plugin.settings.debug) {
			plugin.addCommand({
				id: "clearDatabase",
				name: "DEBUG: clear database (Nothing will be shared after this!)",
				callback: async () => {
					const dbs = await window.indexedDB.databases()
					for (const db of dbs) {
						for (const doc of SharedDocument.getAll()) {
							doc.unshare()
						}
						for (const folder of SharedFolder.getAll()) {
							folder.unshare()
						}
						if (db.name?.startsWith("peerdraft_")) {
							window.indexedDB.deleteDatabase(db.name)
						}
					}
				}
			})
		}

		plugin.registerEvent(plugin.app.vault.on('rename', async (file, oldPath) => {
			if (file instanceof TFile) {
				const doc = SharedDocument.findByPath(oldPath)
				if (doc) {
					await doc.setNewFileLocation(file)
				}

				const oldPathInFolder = SharedFolder.getSharedFolderForSubPath(oldPath)
				const newPathInFolder = SharedFolder.getSharedFolderForSubPath(file.path)

				if (oldPathInFolder && newPathInFolder) {
					if (oldPathInFolder === newPathInFolder) {
						oldPathInFolder.updatePath(oldPath, file.path)
					} else {
						const newDoc = await SharedDocument.fromTFile(file, { permanent: true }, plugin)
						if (newDoc) {
							newPathInFolder.addDocument(newDoc)
						}
						if (doc) {
							// oldPathInFolder.removeDocument(doc)
							// doc.unshare()
						}
					}
				} else if (oldPathInFolder && !newPathInFolder) {
					if (doc) {
						showNotice("It is not possible to remove a document from a shared folder right now. Created a copy.")
						// oldPathInFolder.removeDocument(doc)
						await SharedFolder.getOrCreatePath(path.dirname(oldPath), plugin)
						const file = await plugin.app.vault.create(oldPath, '')
						if (!file) {
							showNotice("Error creating file " + oldPath + ".")
							return
						}
						doc.setNewFileLocation(file)
						doc.syncWithServer()
					}
				} else if (!oldPathInFolder && newPathInFolder) {
					const doc = await SharedDocument.fromTFile(file, { permanent: true }, plugin)
					if (doc) {
						newPathInFolder.addDocument(doc)
					}
				}
			} else if (file instanceof TFolder) {
				const folder = SharedFolder.findByPath(oldPath)
				if (folder) {
					await folder.setNewFolderLocation(file)
				}
			}
		}))

		plugin.registerEvent(plugin.app.vault.on('delete', async (file) => {
			plugin.log("register delete for " + file.path)
			if (file instanceof TFolder) {
				const folder = SharedFolder.findByPath(file.path)
				folder?.unshare()
				return
			} else if (file instanceof TFile) {
				const folder = SharedFolder.getSharedFolderForSubPath(file.path)
				if (!folder) {
					const doc = SharedDocument.findByPath(file.path)
					if (doc) {
						await doc.unshare()
					}
				}
			}
			/* Do net delete on delete files from Shared Folders just yet...
			// If you really want to remove a file, you can move
			if (file instanceof TFile){
				const doc = SharedDocument.findByPath(file.path)
				if (doc) {
					await doc.unshare()
					if (folder) {
						folder.removeDocument(doc)
					}
				}
			} else if (file instanceof TFolder) {
				const folder = SharedFolder.getSharedFolderForSubPath(file.path)
					if (folder) {
						folder.unshare()
					}
			}
			*/
		}))

		plugin.app.workspace.onLayoutReady(
			() => {
				plugin.registerEvent((plugin.app.vault.on("create", async (file) => {
					if (!(file instanceof TFile)) return
					const folder = SharedFolder.getSharedFolderForSubPath(file.path)
					if (!folder) return
					if (folder.isFileInSyncObject(file)) return
					if (SharedDocument.findByPath(file.path)) return

					if (plugin.settings.serverShares.files.has(file.path)) return

					const doc = await SharedDocument.fromTFile(file, {
						permanent: true
					}, plugin)
					if (doc) {
						folder.addDocument(doc)
					}
				})))
			}
		)

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
	}

	log(message: string) {
		if (this.settings.debug) {
			console.log(message)
		}
	}

}

