import { Editor, Plugin, TFile } from "obsidian"
import { getSettings } from "./settings"
import { initDocument, stopSync } from "./document"
import { syncedDocs } from "./data"
import { addExtensionToEditor, removeExtensionsForSession } from "./editor"
import { showNotice } from "./ui"
import { addStatus, removeStatus } from "./statusbar"

export const startSession = async (editor: Editor, file: TFile, plugin: Plugin) => {
	const settings = await getSettings(plugin)
	const id = initDocument(editor.getValue(), settings)
	syncedDocs[file.path] = id

	// bind to editor
	addExtensionToEditor(id, settings, editor)

	// copy link and notify user
	navigator.clipboard.writeText(settings.basePath + id)
	showNotice("Session started for " + file.name + ". Link copied to Clipboard.")

	// set status bar
	addStatus(file, plugin, settings)
}


export const stopSession = (file: TFile) => {
	const id = syncedDocs[file.path]
	if (!id) return
	delete syncedDocs[file.path]
	stopSync(id)
	removeStatus(id)
	removeExtensionsForSession(id)
	showNotice("Session stopped for " + file.name)
}