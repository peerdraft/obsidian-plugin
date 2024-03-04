import { App, Modal, Notice, Setting, TFile, Workspace, WorkspaceLeaf } from "obsidian";

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


class EnterTextModal extends Modal {

  inputDescriptions: Array<{name: string, description: string}>
  cb: (result: Array<{name: string, value: string}>) => any
  result: Array<{name: string, value: string}>

  constructor(app: App, inputDescriptions: Array<{name: string, description: string}>, cb: (result: Array<{name: string, value: string}>) => any) {
    super(app)
    this.inputDescriptions = inputDescriptions
    this.cb = cb
    this.result = inputDescriptions.map(description => {
      return {
        name: description.name,
        value: ""
      }
    })
  }

  async onOpen() {
    for (let index = 0; index < this.inputDescriptions.length; index++) {
      const description = this.inputDescriptions[index];
      const setting = new Setting(this.contentEl)
      setting.setName(description.name)
      setting.setDesc(description.description)
      setting.addText(text => {
        text.onChange(value => {
          this.result[index].value = value
        })
      })
    }

    const buttons = new Setting(this.contentEl)
    buttons.addButton(button => {
      button.setButtonText("Cancel")
      button.onClick(() => {
        this.close()
        this.cb(this.result)
      })
    })

    buttons.addButton(button => {
      button.setButtonText("Go")
      button.setCta()
      button.onClick(() => {
        this.close()
        this.cb(this.result)
      })
    })
  }

  onClose(): void {
    this.cb(this.result)
  }
}

export const promptForMultipleTextInputs = async (app: App, inputDescriptions: Array<{ name: string, description: string }>) => {
  return new Promise<Array<{ name: string, value: string }> | void>((resolve) => {
    new EnterTextModal(app, inputDescriptions, (result) => {
      resolve(result)
    }).open()
  })
}

export const openFileInNewTab = async (file: TFile, workspace: Workspace) => {
  const leaf = workspace.getLeaf('tab')
  await leaf.openFile(file)
  return leaf
}

export const pinLeaf = (leaf: WorkspaceLeaf) => {
  leaf.setPinned(true)
  console.log(leaf)
  showNotice(`auto-pinned "${leaf.getDisplayText()}"`)
}