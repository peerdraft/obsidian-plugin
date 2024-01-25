import { StateEffect } from "@codemirror/state";
import { EditorView } from '@codemirror/view';
import { around } from "monkey-around";
import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { prepareCommunication } from "./cookie";
import { syncedDocs } from './data';
import { initDocument, stopSync } from './document';
import { getOrCreateExtension } from "./editor";
import { createSettingsModal, createSettingsTab, getSettings, migrateSettings } from './settings';
import { addStatus, removeStatus } from "./statusbar";
import { refreshSubscriptionData } from "./subscription";

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
				stopSession(file, plugin)
			}
		});

		plugin.register(around(MarkdownView.prototype, {
			onUnloadFile(next) {
				return async function (file) {
					stopSession(file, plugin)
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
			stopSession(file, this)
		});
	}

}

export const stopSession = (file: TFile, plugin: Plugin) => {
	const id = syncedDocs[file.path]
	if (!id) return
	delete syncedDocs[file.path]
	stopSync(id)
	removeStatus(id)
	const notice = new Notice("Session stopped for " + file.name)
}

export const startSession = async (editor: Editor, file: TFile, plugin: Plugin) => {
	const settings = await getSettings(plugin)
	const id = initDocument(editor.getValue(), settings)
	syncedDocs[file.path] = id

	// bind to editor
	const extension = getOrCreateExtension(id, settings)
	const editorView = (editor as any).cm as EditorView;
	editorView.dispatch({
		effects: StateEffect.appendConfig.of(extension)
	})

	// copy link and notify user
	navigator.clipboard.writeText(settings.basePath + id)
	new Notice("Session started for " + file.name + ". Link copied to Clipboard.")

	// set status bar
	addStatus(file, plugin, settings)
}