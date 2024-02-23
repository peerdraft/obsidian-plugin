import { around } from "monkey-around";
import { MarkdownView, Plugin, TFile } from 'obsidian';
import { prepareCommunication } from "./cookie";
import { syncedDocs } from './data';
import { createSettingsModal, createSettingsTab, getSettings, migrateSettings } from './settings';
import { refreshSubscriptionData } from "./subscription";
import { joinSession, startSession, stopSession } from "./session";
import { promptForMultipleTextInputs } from "./ui";

export default class PeerDraftPlugin extends Plugin {

	async onload() {

		const plugin = this

		await migrateSettings(plugin)
		await prepareCommunication(plugin)
		await refreshSubscriptionData(plugin)

		plugin.addCommand({
			id: 'start-session-with-active-document',
			name: 'Start shared session',
			editorCheckCallback: (checking, editor, ctx) => {
				// checking
				const file = ctx.file
				if (!file) return false
				const sharedAlready = syncedDocs[file.path]
				if (sharedAlready) return false
				if (checking) return true
				// do it
				startSession(editor, file, plugin)
			}
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
				stopSession(file)
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

		plugin.register(around(MarkdownView.prototype, {
			onUnloadFile(next) {
				return async function (file) {
					stopSession(file)
					return next.call(this, file)
				}
			}
		}))

		this.app.vault.on('rename', (file, oldPath) => {
			if (!syncedDocs[oldPath]) return
			syncedDocs[file.path] = syncedDocs[oldPath]
		})

		const settingsTab = createSettingsTab(plugin)
		const settings = await getSettings(plugin)
		if (!settings.name) {
			createSettingsModal(plugin).open()
		}
		plugin.addSettingTab(settingsTab)
	}

	onunload() {
		Object.keys(syncedDocs).forEach(path => {
			const file = this.app.vault.getAbstractFileByPath(path)
			if (!file || !(file instanceof TFile)) return
			stopSession(file)
		});
	}

}

