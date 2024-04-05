
import { App, Modal, Setting } from "obsidian"

class ChooseSessionTypeModal extends Modal {

  cb: (result: {permanent: boolean}) => any

  constructor(app: App, cb: (result: {permanent: boolean}) => any) {
    super(app)
    this.cb = cb
  }

  async onOpen() {
    new Setting(this.contentEl).setName("Start working together").setHeading()

    new Setting(this.contentEl).addButton(button => {
      button.setButtonText("Start fleeting session")
      button.setCta()
      button.onClick(() => {
        this.close()
        this.cb({
          permanent: false
        })
      })
    }).setDesc("A fleeting session automatically closes when you close the document or disconnect.")

    new Setting(this.contentEl).addButton(button => {
      button.setButtonText("Share permanently")
      button.setCta()
      button.onClick(() => {
        this.close()
        this.cb({
          permanent: true
        })
      })
    }).setDesc("The document will be shared permanently until you explicitely stop sharing. This is persisted even if you disconnect or close Obsidian.")
  }
}

export const promptForSessionType = (app: App) => {
  return new Promise<{permanent: boolean} | void>((resolve) => {
    new ChooseSessionTypeModal(app, (result) => {
      resolve(result)
    }).open()
  })
}