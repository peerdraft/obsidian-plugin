import { App, Modal, Setting } from "obsidian";
import { SharedFolder } from "src/sharedEntities/sharedFolder";
import { showNotice } from "src/ui";

class SharedFolderOptionsModal extends Modal {

  folder: SharedFolder

  constructor(app: App, folder: SharedFolder) {
    super(app)
    this.folder = folder
  }

  async onOpen() {
    new Setting(this.contentEl).setName(this.folder.getOriginalFolderName()).setHeading()

    // Folder Name
    const nameSetting = new Setting(this.contentEl)
    let tempName = this.folder.getOriginalFolderName()
    nameSetting.setName("Peerdraft folder name")
    nameSetting.addText(text => {
      text.setValue(tempName)
      text.onChange(value => {
        tempName = value
      })
    })

    nameSetting.addButton(button => {
      button.setButtonText("Update")
      button.onClick(() => {
        if (tempName !== this.folder.getOriginalFolderName()) {
          this.folder.setOriginalFolderName(tempName)
          this.close()
          openFolderOptions(this.app, this.folder)
        }
      })
    })

    // Add peerdraft property

    const prop = new Setting(this.contentEl)
    prop.setName("Auto add property with Peerdraft URL")
    prop.setDesc("Leave empty if no property should be added")
    let tempProp = this.folder.getAutoFillProperty()

    prop.addText(text => {
      text.setValue(tempProp)
      text.onChange(value => {
        tempProp = value
      })
    })

    prop.addButton(button => {
      button.setButtonText("Update & Apply")
      button.onClick(async () => {
        const oldProperty = this.folder.getAutoFillProperty()
        if (tempProp !== oldProperty) {
          this.folder.setAutoFillProperty(tempProp)
        }
        const notice = showNotice("Updating URLs...")
        await this.folder.updatePropertiesOfAllDocuments(oldProperty)
        notice.hide()
        this.close()
        openFolderOptions(this.app, this.folder)
      })
    })

    const link = new Setting(this.contentEl)
    link.setName("Peerdraft URL")
    link.addButton(btn => {
      btn.setButtonText("Copy Peerdraft URL to clipboard")
      btn.onClick(()=> {
        navigator.clipboard.writeText(this.folder.getShareURL())
        showNotice("Link copied to clipboard.")
      })
    })


  }
}

export const openFolderOptions = (app: App, folder: SharedFolder) => {
  new SharedFolderOptionsModal(app, folder).open()
}