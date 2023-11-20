import { StateEffect } from "@codemirror/state";
import { EditorView } from '@codemirror/view';
import { around } from "monkey-around";
import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { syncedDocs } from './data';
import { initDocument, stopSync } from './document';
import { createSettingsModal, createSettingsTab, getSettings } from './settings';
import { addStatus, removeStatus } from "./statusbar";
import { getOrCreateExtension, removeExtensions } from "./editor";


export default class PeerDraftPlugin extends Plugin {

	async onload() {

		const plugin = this

		plugin.addCommand({
			id: 'start-session-with-active-document',
			name: 'Start shared session',
			checkCallback: (checking: boolean) => {
				// do the checks
				const editor = plugin.app.workspace.activeEditor
				if (!(editor && editor.editor)) return
				const file = editor.file
				if (!file) return false
				const sharedAlready = syncedDocs[file.path]
				if (sharedAlready) return false
				if (checking) return true

				// do the work
				getSettings(plugin).then(settings => {
					if (!(editor && editor.editor)) return
					// init doc
					const id = initDocument(editor.editor.getValue(), settings)
					syncedDocs[file.path] = id

					// bind to editor
					const extension = getOrCreateExtension(id, settings)
					const editorView = (editor.editor as any).cm as EditorView;
					editorView.dispatch({
						effects: StateEffect.appendConfig.of(extension)
					})

					// copy link and notify user
					navigator.clipboard.writeText(settings.basePath + '/' + id)
					new Notice("Session started for " + file.name + ". Link copied to Clipboard.")

					// set status bar
					addStatus(file, plugin, settings)
				})
			}
		});

		plugin.addCommand({
			id: 'stop-session-with-active-document',
			name: 'Stop shared session',
			checkCallback: (checking: boolean) => {
				// do the checks
				const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
				if (!markdownView) return false;
				const file = markdownView.file
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
			console.log("hallo")
			createSettingsModal(plugin).open()
		}
		plugin.addSettingTab(settingsTab)
	}

	onunload() {

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