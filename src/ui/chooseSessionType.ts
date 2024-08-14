
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
      button.setButtonText("Fleeting session")
      button.setCta()
      button.onClick(() => {
        this.close()
        this.cb({
          permanent: false
        })
      })
    }).setDesc("A Fleeting Session is ideal when you need to collaborate on a document in real-time but don’t require ongoing synchronization or permanent sharing afterward.")

    const setting = new Setting(this.contentEl).addButton(button => {
      button.setButtonText("Persistent Share")
      button.setCta()
      button.onClick(() => {
        this.close()
        this.cb({
          permanent: true
        })
      })
    }).setDesc("A Persistent Share is used when you want to keep documents and folders synchronized over an extended period. Persistent Shares support both asynchronous and offline edits.")

    setting.settingEl.insertAdjacentHTML('afterend', '<p><small>To learn more about the difference between a Fleeting Session and a Permanent Share, click <a href="https://www.peerdraft.app/documentation/explanations/what-is-the-difference-between-persistent-and-fleeting">here</a>.</small></p>')
  }
}

export const promptForSessionType = (app: App) => {
  return new Promise<{permanent: boolean} | void>((resolve) => {
    new ChooseSessionTypeModal(app, (result) => {
      resolve(result)
    }).open()
  })
}