import { App, Modal, Notice } from "obsidian";

class ShowTextModal extends Modal {

	message: string
  title: string

	constructor(app: App, title: string, message: string) {
		super(app);
		this.message = message
    this.title = title
	}

	onOpen() {
		this.titleEl.setText(this.title)
		this.contentEl.setText(this.message)
	}

	onClose() {
		this.containerEl.empty()
	}
}

export const showTextModal = (app: App, title: string, text: string) => {
  new ShowTextModal(app, title, text).open()
}

export const showNotice = (text: string) => {
	new Notice(text)
}