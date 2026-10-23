
import { App, Modal, Setting } from "obsidian"

type OPTS = {
  header: string,
  description: string,
  initial: RESULT
}

type RESULT = {
  text: string
}

class EnterTextModal extends Modal {

  cb: (result: RESULT | void) => void
  opts: OPTS
  result: RESULT
  private acceptedResult?: RESULT
  private settled = false

  constructor(app: App, opts: OPTS, cb: (result: RESULT | void) => void) {
    super(app)
    this.cb = cb
    this.result = opts.initial
    this.opts = opts
  }

  private submit(): void {
    if (this.settled) return
    this.acceptedResult = { ...this.result }
    this.close()
  }

  onClose(): void {
    if (this.settled) return
    this.settled = true
    this.cb(this.acceptedResult)
  }

  async onOpen() {
    new Setting(this.contentEl).setName(this.opts.header).setHeading()

    new Setting(this.contentEl).addText(text => {
      text.setValue(this.result.text),
        text.onChange((value) => {
          this.result.text = value
        })
      text.inputEl.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault()
          this.submit()
        }
      }
    }).setDesc(this.opts.description)

    const buttons = new Setting(this.contentEl)

    buttons.addButton(button => {
      button.setButtonText("Cancel")
      button.onClick(() => {
        this.close()
      })
    })

    buttons.addButton(button => {
      button.setButtonText("OK")
      button.setCta()
      button.onClick(() => {
        this.submit()
      })
    })

  }
}

export const promptForText = (app: App, opts: OPTS) => {
  return new Promise<RESULT | void>((resolve) => {
    new EnterTextModal(app, opts, (cb) => {
      resolve(cb)
    }).open()
  })
}

export const promptForURL = (app: App) => {
  return promptForText(app, {
    description: "Enter the URL you received to start working together.",
    header: "Enter your Peerdraft URL",
    initial: {
      text: ""
    }
  })
}

export const promptForName = (app: App) => {
  return promptForText(app, {
    description: "This name will be shown to your collaborators",
    header: "What's your name?",
    initial: {
      text: ""
    }
  })
}
