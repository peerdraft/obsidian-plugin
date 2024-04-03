
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

  cb: (result: { text: string }) => any
  opts: OPTS
  result: RESULT

  constructor(app: App, opts: OPTS, cb: (result: RESULT) => any) {
    super(app)
    this.cb = cb
    this.result = opts.initial
    this.opts = opts
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
          this.close()
          this.cb(this.result)
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
        this.close()
        this.cb(this.result)
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
    description: "Enter the URL you received to start collaborating.",
    header: "Enter your Peerdraft URL",
    initial: {
      text: ""
    }
  })
}