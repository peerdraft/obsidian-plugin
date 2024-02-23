import { Editor, MarkdownView, Plugin, TFile } from "obsidian"
import { getSettings } from "./settings"
import { createDocumentWithSyncId, initDocument, initDocumentToJoin, stopSync } from "./document"
import { syncObjects, syncedDocs } from "./data"
import { addExtensionToEditor, removeExtensionsForSession } from "./editor"
import { openFileInNewTab, showNotice } from "./ui"
import { addStatus, removeStatus } from "./statusbar"

export const startSession = async (editor: Editor, file: TFile, plugin: Plugin) => {
	const settings = await getSettings(plugin)
	const id = initDocument(editor.getValue(), settings)
	syncedDocs[file.path] = id

	// monitor participants
	notifyOnCollaboratorsChanged(id)

	// bind to editor
	addExtensionToEditor(id, settings, editor)

	// copy link and notify user
	navigator.clipboard.writeText(settings.basePath + id)
	showNotice("Session started for " + file.name + ". Link copied to Clipboard.")

	// set status bar
	addStatus(file, plugin, settings)
}

export const joinSession = async (url: string, plugin: Plugin) => {
	const id = url.split('/').pop()
	if (!id || !id.match('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) {
		showNotice("No valid peerdraft link")
		return
	}
	if (syncObjects[id]) {
		showNotice("Sync already active")
		return
	}

	const fileData = await createDocumentWithSyncId(id, plugin.app)

	if (!fileData) {
		showNotice('Error: Could not create file for session.')
		return
	}

	syncedDocs[fileData.file.path] = fileData.id

	const settings = await getSettings(plugin)
	const syncObj = initDocumentToJoin(fileData.id, settings)

	syncObj.doc.once('update', async () => {
		const leaf = await openFileInNewTab(fileData.file, plugin.app.workspace)
		let editor: Editor | undefined
		try {
			editor = ((leaf.view) as MarkdownView).editor
		} catch { }

		if (!editor) return

		editor.setValue(syncObj.content.toString())

		notifyOnCollaboratorsChanged(fileData.id)
		addExtensionToEditor(fileData.id, settings, editor)
		addStatus(fileData.file, plugin, settings)
		showNotice("Joined Session in " + fileData.file.name + ".")


		const owner = syncObj.doc.getText("owner");

		syncObj.provider.awareness.on("update", (msg: { removed: Array<number> }) => {
			const removed = msg.removed ?? [];
			if (!removed || removed.length < 1) return
			const removedStrings = removed.map((id) => {
				return id.toFixed(0);
			});

			if (removedStrings.includes(owner.toString())) {
				showNotice("Shared session stopped by owner")
				stopSession(fileData.file)
			}
		})
	})
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

const notifyOnCollaboratorsChanged = (id: string) => {
	const { provider } = syncObjects[id]
	if (!provider) return;

	provider.awareness.on('update', (msg: { added: Array<number>, updated: Array<number>, removed: Array<number> }) => {
		const added = msg.added ?? [];
		if (!added || added.length == 0) return;
		const states = provider.awareness.getStates()
		for (const key of added) {
			const peer = states.get(key)
			if (peer) {
				showNotice(`${peer.user.name} joined`)
			}
		}
	})
}