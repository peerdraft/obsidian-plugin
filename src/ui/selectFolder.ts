import { App, SuggestModal, TFile, TFolder, Vault } from "obsidian";

export class SelectFolderModal extends SuggestModal<TFolder> {

  folders: Array<TFolder>
  cb: (folder: TFolder) => any
  selectedFolder: TFolder

  constructor(app: App, cb: (file: TFolder) => any) {
    super(app)
    this.cb = cb

    this.folders = []
    Vault.recurseChildren(app.vault.getRoot(), (file) => {
      if (file instanceof TFolder) this.folders.push(file)
    })
    // remove root & sort
    this.folders.shift()
    this.folders.sort((a, b) => {
      return a.path.toLocaleLowerCase().localeCompare(b.path.toLocaleLowerCase())
    })
  }

  onOpen() {
    super.onOpen()
    this.inputEl.placeholder = "Choose a location"
  }

  getSuggestions(query: string): TFolder[] {
    return this.folders.filter(folder => {
      return folder.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    })
  }

  renderSuggestion(value: TFolder, el: HTMLElement) {
    el.setText(value.path)
  }

  selectSuggestion(value: TFolder, evt: MouseEvent | KeyboardEvent): void {
    this.selectedFolder = value
    super.selectSuggestion(value, evt)
  }

  onChooseSuggestion(item: TFolder, evt: MouseEvent | KeyboardEvent) {
  }

  onClose(): void {
    this.cb(this.selectedFolder)
  }

}

export const promptForFolderSelection = async (app: App) => {
  return new Promise<TFolder | void>((resolve) => {
    new SelectFolderModal(app, (folder) => {
      resolve(folder)
    }).open()
  })
}