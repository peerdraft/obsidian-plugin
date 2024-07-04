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

export const showNotice = (text: string, duration?: number | undefined) => {
	return new Notice(text, duration)
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
  showNotice(`auto-pinned "${leaf.getDisplayText()}"`)
}

export const usercolors = [
  { dark: '#30bced', light: '#30bced33' },
  { dark: '#6eeb83', light: '#6eeb8333' },
  { dark: '#ffbc42', light: '#ffbc4233' },
  { dark: '#ecd444', light: '#ecd44433' },
  { dark: '#ee6352', light: '#ee635233' },
  { dark: '#9ac2c9', light: '#9ac2c933' },
  { dark: '#8acb88', light: '#8acb8833' },
  { dark: '#1be7ff', light: '#1be7ff33' }
]