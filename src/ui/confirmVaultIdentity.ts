import { App, Modal, Setting } from "obsidian"

class ConfirmVaultIdentityModal extends Modal {

  private result: { copied: boolean } | undefined
  cb: (result: { copied: boolean } | undefined) => void
  storedPath: string
  currentPath: string

  constructor(app: App, storedPath: string, currentPath: string, cb: (result: { copied: boolean } | undefined) => void) {
    super(app)
    this.storedPath = storedPath
    this.currentPath = currentPath
    this.cb = cb
  }

  async onOpen() {
    new Setting(this.contentEl).setName("Peerdraft vault moved or copied?").setHeading()

    const desc = this.contentEl.createEl("p")
    desc.setText(
      `This vault's Peerdraft data was created under a different location (${this.storedPath}). ` +
      `If this vault was copied with its .obsidian folder, it must get a new identity — otherwise it would ` +
      `claim the original vault's shared documents and login. If the vault was only moved or renamed, ` +
      `everything can stay as is.`
    )

    new Setting(this.contentEl).addButton(button => {
      button.setButtonText("It was moved or renamed")
      button.setCta()
      button.onClick(() => {
        this.result = { copied: false }
        this.close()
      })
    }).setDesc("Keep the existing Peerdraft identity and shared documents.")

    new Setting(this.contentEl).addButton(button => {
      button.setButtonText("This vault is a copy")
      button.setWarning()
      button.onClick(() => {
        this.result = { copied: true }
        this.close()
      })
    }).setDesc("Generate a new identity and clear this vault's share registry. You will need to log in again.")
  }

  onClose(): void {
    this.cb(this.result)
  }
}

/** Resolves `void` when dismissed — treated as the non-destructive default. */
export const confirmVaultCopied = (app: App, storedPath: string, currentPath: string) => {
  return new Promise<{ copied: boolean } | void>((resolve) => {
    new ConfirmVaultIdentityModal(app, storedPath, currentPath, (result) => {
      resolve(result)
    }).open()
  })
}
