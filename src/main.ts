import { around } from "monkey-around";
import { MarkdownView, Plugin, TFile } from 'obsidian';
import { prepareCommunication } from "./cookie";
import { syncedDocs } from './data';
import { createSettingsModal, createSettingsTab, getSettings, migrateSettings } from './settings';
import { refreshSubscriptionData } from "./subscription";
import { startSession, stopSession } from "./session";

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

		plugin.register(around(MarkdownView.prototype, {
			onUnloadFile(next) {
				return async function (file) {
					stopSession(file)
					return next.call(this, file)
				}
			}
		}))

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

