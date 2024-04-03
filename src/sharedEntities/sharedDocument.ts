import { MarkdownView, Menu, TFile } from 'obsidian'
import * as Y from 'yjs'
import { createRandomId, generateRandomString, randomUint32 } from '../tools'
import { Compartment } from "@codemirror/state";
import PeerDraftPlugin from '../main';
import { openFileInNewTab, pinLeaf, showNotice, usercolors } from '../ui';
import { yCollab } from 'y-codemirror.next';
import { EditorView } from '@codemirror/view';
import { StateEffect } from "@codemirror/state";
import { PeerdraftRecord } from '../utils/peerdraftRecord';
import { PermanentShareDocument } from '../permanentShareStore';
import { getLeafIdsByPath } from '../workspace/peerdraftWorkspace';
import { SharedEntity } from './sharedEntity';
import * as path from 'path';
import { WebrtcProvider } from 'y-webrtc';

export class SharedDocument extends SharedEntity {

  private static _sharedDocuments: Array<SharedDocument> = []
  private static _userColor = usercolors[randomUint32() % usercolors.length]

  private _isPermanent: boolean
  private _file: TFile

  private _extensions: PeerdraftRecord<Compartment>

  private statusBarEntry?: HTMLElement

  static async fromView(view: MarkdownView, plugin: PeerDraftPlugin, opts = { isPermanent: false }) {
    if (!view.file) return
    if (this.findByPath(view.file.path)) return

    const doc = new SharedDocument({
      path: view.file.path
    }, plugin)
    doc.yDoc.getText("content").insert(0, view.editor.getValue())
    if (opts.isPermanent) {
      await doc.setPermanent()
      doc.startWebSocketSync()
    } else {
      doc._shareId = createRandomId()
      doc.addStatusBarEntry()
      pinLeaf(view.leaf)
    }
    doc.startWebRTCSync()
    if (!opts.isPermanent && doc._webRTCProvider) {
      doc.getOwnerFragment().insert(0, doc._webRTCProvider.awareness.clientID.toFixed(0))
    }

    // @ts-expect-error
    doc.addExtensionToLeaf(view.leaf.id)

    navigator.clipboard.writeText(plugin.settings.basePath + doc.shareId)
    showNotice("Collaboration started for " + doc.path + ". Link copied to Clipboard.")

    return doc
  }

  static fromPermanentShareDocument(pd: PermanentShareDocument, plugin: PeerDraftPlugin) {
    if (this.findByPath(pd.path)) return
    const doc = new SharedDocument({
      path: pd.path
    }, plugin)
    doc._isPermanent = true
    doc._shareId = pd.shareId
    console.log("permenent share added " + pd.path)
    return doc
  }

  static async fromShareURL(url: string, plugin: PeerDraftPlugin): Promise<SharedDocument | void> {
    const id = url.split('/').pop()
    if (!id || !id.match('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) {
      showNotice("No valid peerdraft link")
      return
    }

    if (SharedDocument.findById(id)) {
      showNotice("This share is already active.")
      return
    }

    // TODO: Check if permanent
    // Assume p2p here

    const isPermanent = false

    if (!isPermanent) {
      const initialFileName = `_peerdraft_session_${id}_${generateRandomString()}.md`
      const parent = plugin.app.fileManager.getNewFileParent('', initialFileName)
      const filePath = path.join(parent.path, initialFileName)
      const file = await plugin.app.vault.create(filePath, '')

      const doc = new SharedDocument({
        path: file.path,
        id
      }, plugin)

      doc.startWebRTCSync()
      const leaf = await openFileInNewTab(file, plugin.app.workspace)
      doc.addStatusBarEntry()
      // @ts-expect-error
      doc.addExtensionToLeaf(leaf.id)
      pinLeaf(leaf)
      showNotice("Joined Session in " + doc.path + ".")

      return doc

    }

  }

  startWebRTCSync(): WebrtcProvider {
    return super.startWebRTCSync((provider) => {
      console.log("register")
      provider.awareness.on("update", (msg: { added: Array<number>, updated: Array<number>, removed: Array<number> }) => {
        const removed = msg.removed ?? [];
        if (removed && removed.length > 0) {
          const removedStrings = removed.map((id) => {
            return id.toFixed(0);
          });

          const owner = this.getOwnerFragment().toString()
          if (owner != provider.awareness.clientID.toString()) {
            if (removedStrings.includes(owner)) {
              showNotice("Shared session for " + this.path + " stopped by owner")
              this.destroy()
            }
          }
        }

        const added = msg.added ?? [];
        if (added && added.length > 0) {
          const states = provider.awareness.getStates()
          for (const key of added) {
            const peer = states.get(key)
            if (peer) {
              showNotice(`${peer.user.name} joined`)
            }
          }
        }
      })
    })
  }

  static async fromTFile(file: TFile, plugin: PeerDraftPlugin) {

    const doc = new SharedDocument({ path: file.path }, plugin)
    // await doc.setPermanent()
    doc._shareId = createRandomId()

    const leafIds = getLeafIdsByPath(file.path, plugin.pws)

    if (leafIds.length > 0) {
      const content = (plugin.app.workspace.getLeafById(leafIds[0]).view as MarkdownView).editor.getValue()
      doc.getContentFragment().insert(0, content)
      for (const id of leafIds) {
        doc.addExtensionToLeaf(id)
      }
    } else {
      const content = await plugin.app.vault.read(file)
      doc.getContentFragment().insert(0, content)
    }
    return doc
  }

  static findByPath(path: string) {
    const docs = this._sharedDocuments.filter(doc => {
      return doc.path === path
    })
    if (docs.length >= 1) {
      return docs[0]
    } else {
      return
    }
  }

  static findById(id: string) {
    const docs = this._sharedDocuments.filter(doc => {
      return doc.shareId === id
    })
    if (docs.length >= 1) {
      return docs[0]
    } else {
      return
    }
  }

  static getAll() {
    return Object.assign([], this._sharedDocuments) as Array<SharedDocument>
  }


  private constructor(opts: {
    path?: string,
    id?: string
  }, plugin: PeerDraftPlugin) {
    super(plugin)
    if (opts.path) {
      this._path = opts.path
      const file = this.plugin.app.vault.getAbstractFileByPath(this.path)
      if ((file instanceof TFile)) {
        this._file = file
      } else {
        console.log("FILE NOT FOUND")
      }
    }
    if (opts.id) {
      this._shareId = opts.id
    }
    this.yDoc = new Y.Doc()

    SharedDocument._sharedDocuments.push(this)
    this._extensions = new PeerdraftRecord<Compartment>()

    this._extensions.on("delete", () => {
      if (this._extensions.size === 0 && this._webRTCProvider) {
        this._webRTCProvider.awareness.setLocalState({})
      }
    })

    this.getContentFragment().observe(() => {
      if (this._file && this._extensions.size === 0) {
        this.plugin.app.vault.modify(this._file, this.getContentFragment().toString())
      }
    })
  }

  setNewFileLocation(file: TFile) {
    this._file = file
    this._path = file.path
    if (this.statusBarEntry) {
      this.removeStatusStatusBarEntry()
      this.addStatusBarEntry()
    }
  }

  async setPermanent() {
    if (!this._isPermanent) {
      const data = await this.plugin.serverAPI.createPermanentSession()
      if (!data) return
      this._isPermanent = true
      this._shareId = data.id
      await this.plugin.permanentShareStore.add(this)
    }
  }

  get isPermanent() {
    return this._isPermanent
  }

  getValue() {
    return this.getContentFragment().toString()
  }

  getContentFragment() {
    return this.yDoc.getText("content")
  }

  getOwnerFragment() {
    return this.yDoc.getText("owner")
  }


  startLocalSync() {

  }

  stopLocalSync() {

  }

  async addExtensionToLeaf(leafId: string) {
    // only makes sense if we have a webrct provider to sync with
    const webRTCProcider = await this.startWebRTCSync()
    // already there
    if (this._extensions.get(leafId)) return
    // need a pleaf
    const pLeaf = this.plugin.pws.get(leafId)
    if (!pLeaf) return
    // path needs to match
    if (pLeaf.path != this._path) return
    if (pLeaf.isPreview) {
      pLeaf.once("changeIsPreview", () => {
        this.addExtensionToLeaf(leafId)
      })
      return
    }

    const leaf = this.plugin.app.workspace.getLeafById(leafId)
    if (!leaf) return
    const view = leaf.view as MarkdownView
    const editor = view.editor

    editor.setValue(this.getValue())

    const undoManager = new Y.UndoManager(this.getContentFragment())
    webRTCProcider.awareness.setLocalStateField('user', {
      name: this.plugin.settings.name,
      color: SharedDocument._userColor.dark,
      colorLight: SharedDocument._userColor.light
    })

    const extension = yCollab(this.getContentFragment(), webRTCProcider.awareness, { undoManager })
    const compartment = new Compartment()

    const editorView = (editor as any).cm as EditorView;
    editorView.dispatch({
      effects: StateEffect.appendConfig.of(compartment.of(extension))
    })

    this._extensions.set(leafId, compartment)

    // remove if switch to preview
    pLeaf.once("changeIsPreview", () => {
      this.removeExtensionFromLeaf(leafId)
      // add again if switched back
      pLeaf.once("changeIsPreview", () => {
        this.addExtensionToLeaf(leafId)
      })
    })

    return Compartment
  }

  removeExtensionFromLeaf(leafId: string) {
    const leaf = this.plugin.app.workspace.getLeafById(leafId)
    if (leaf) {
      const editor = (leaf.view as MarkdownView).editor
      const editorView = (editor as any).cm as EditorView;
      const compartment = this._extensions.get(leafId)
      if (compartment) {
        editorView.dispatch({
          effects: compartment.reconfigure([])
        })
      }
    }
    this._extensions.delete(leafId)
  }

  startUpdateInBackground() {

  }

  stopUpdateInBackground() {

  }

  addStatusBarEntry() {
    if (this.statusBarEntry) return
    const menu = new Menu()
    menu.addItem((item) => {
      item.setTitle("Copy link")
      item.onClick(() => {
        navigator.clipboard.writeText(this.plugin.settings.basePath + this.shareId)
        showNotice("Link copied to clipboard.")
      })
    })

    menu.addItem((item) => {
      item.setTitle("Stop shared session")
      item.onClick(() => {
        this.destroy()
      })
    })

    const status = this.plugin.addStatusBarItem();
    status.addClass('mod-clickable')
    status.createEl("span", { text: "Sharing '" + this.path + "'" })
    status.onClickEvent((event) => {
      menu.showAtMouseEvent(event);
    })
    this.statusBarEntry = status
  }

  removeStatusStatusBarEntry() {
    if (!this.statusBarEntry) return
    this.statusBarEntry.remove()
    this.statusBarEntry = undefined
  }


  destroy() {
    if (!this.isPermanent) {
      showNotice("Stopping collaboration on " + this.path + ".")
    }
    for (const key of this._extensions.keys) {
      this.removeExtensionFromLeaf(key)
    }
    this._extensions.destroy()
    this.stopWebRTCSync()
    this.stopWebSocketSync()
    this.stopLocalSync()
    this.removeStatusStatusBarEntry()
    SharedDocument._sharedDocuments.splice(SharedDocument._sharedDocuments.indexOf(this), 1)
  }
}