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
import { IndexeddbPersistence } from 'y-indexeddb';

export class SharedDocument extends SharedEntity {

  private static _userColor = usercolors[randomUint32() % usercolors.length]

  private _isPermanent: boolean
  private _file: TFile

  private _extensions: PeerdraftRecord<Compartment>

  private statusBarEntry?: HTMLElement

  protected static _sharedEntites: Array<SharedDocument> = new Array<SharedDocument>()

  static async fromView(view: MarkdownView, plugin: PeerDraftPlugin, opts = { isPermanent: false }) {
    if (!view.file) return
    if (this.findByPath(view.file.path)) return

    const doc = new SharedDocument({
      path: view.file.path
    }, plugin)
    if (opts.isPermanent) {
      await doc.setPermanent()
      await doc.startWebSocketSync()
      await doc.startIndexedDBSync()
    } else {
      doc._shareId = createRandomId()
      doc.addStatusBarEntry()
      pinLeaf(view.leaf)
    }
    doc.startWebRTCSync()
    if (!opts.isPermanent && doc._webRTCProvider) {
      doc.getOwnerFragment().insert(0, doc._webRTCProvider.awareness.clientID.toFixed(0))
    }

    doc.yDoc.getText("content").insert(0, view.editor.getValue())
    // @ts-expect-error
    doc.addExtensionToLeaf(view.leaf.id)

    navigator.clipboard.writeText(plugin.settings.basePath + "/cm/" + doc.shareId)
    showNotice("Collaboration started for " + doc.path + ". Link copied to Clipboard.")

    return doc
  }

  static async fromPermanentShareDocument(pd: PermanentShareDocument, plugin: PeerDraftPlugin) {
    if (this.findByPath(pd.path)) return
    const doc = new SharedDocument({
      path: pd.path
    }, plugin)
    doc._isPermanent = true
    doc._shareId = pd.shareId
    const local = await doc.startIndexedDBSync()
    if (local) {
      if (local.synced || await local.whenSynced) {
        doc.startWebSocketSync()
      }
    }
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

    const isPermanent = await plugin.serverAPI.isSessionPermanent(id)

    const initialFileName = `_peerdraft_session_${id}_${generateRandomString()}.md`
    const parent = plugin.app.fileManager.getNewFileParent('', initialFileName)
    const filePath = path.join(parent.path, initialFileName)
    const file = await plugin.app.vault.create(filePath, '')

    const doc = new SharedDocument({
      path: file.path,
      id
    }, plugin)

    doc.startWebRTCSync()
    if (isPermanent) {
      doc._isPermanent = true
      await plugin.permanentShareStore.add(doc)
      doc.startWebSocketSync()
      doc.startIndexedDBSync()
    }

    const leaf = await openFileInNewTab(file, plugin.app.workspace)
    doc.addStatusBarEntry()
    // @ts-expect-error
    doc.addExtensionToLeaf(leaf.id)
    pinLeaf(leaf)
    showNotice("Joined Session in " + doc.path + ".")

    return doc

  }

  static async fromTFile(file: TFile, opts: { id?: string, permanent?: boolean }, plugin: PeerDraftPlugin) {
    const existing = SharedDocument.findByPath(file.path)
    if (existing) return existing

    const doc = new SharedDocument({ path: file.path }, plugin)
    if (opts.id) {
      doc._shareId = opts.id
    }
    if (opts.permanent) {
      await doc.setPermanent()
      doc.startWebSocketSync()
      doc.startIndexedDBSync()
    }
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
    return super.findByPath(path) as SharedDocument | undefined
  }

  static findById(id: string) {
    return super.findById(id) as SharedDocument | undefined
  }

  static getAll() {
    return super.getAll() as Array<SharedDocument>
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
        showNotice("ERROR creating sharedDoc")
      }
    }
    if (opts.id) {
      this._shareId = opts.id
    }
    this.yDoc = new Y.Doc()

    SharedDocument._sharedEntites.push(this)
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
  
  get file () {
    return this._file
  }
  startWebRTCSync() {
    return super.startWebRTCSync((provider) => {
      provider.awareness.on("update", async (msg: { added: Array<number>, removed: Array<number> }) => {
        const removed = msg.removed ?? [];
        if (removed && removed.length > 0) {
          const removedStrings = removed.map((id) => {
            return id.toFixed(0);
          });

          const owner = this.getOwnerFragment().toString()
          if (owner != provider.awareness.clientID.toString()) {
            if (removedStrings.includes(owner) && !this.isPermanent) {
              showNotice("Shared session for " + this.path + " stopped by owner")
              await this.unshare()
            }
          }
        }

        const added = msg.added ?? [];
        if (added && added.length > 0) {
          const states = provider.awareness.getStates()
          for (const key of added) {
            const peer = states.get(key)
            if (peer) {
              showNotice(`${peer.user.name} works on ${this.path}`)
            }
          }
        }
      })

      const handleTimeout = () => {
        if (this._extensions.size > 0 || getLeafIdsByPath(this.path, this.plugin.pws).length > 0) {
          this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)
          return
        }
        this.stopWebRTCSync()
      }

      this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)
      provider.doc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc, tr: Y.Transaction) => {
        if (this._webRTCTimeout != null) {
          window.clearTimeout(this._webRTCTimeout)
        }
        this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)
      })
    })
  }

  async setNewFileLocation(file: TFile) {
    const oldPath = this._path
    this._file = file
    this._path = file.path
    if (this.statusBarEntry) {
      this.removeStatusStatusBarEntry()
      this.addStatusBarEntry()
    }
    const dbEntry = await this.plugin.permanentShareStore.getDocByPath(oldPath)
    if (dbEntry) {
      this.plugin.permanentShareStore.removeDoc(oldPath)
      this.plugin.permanentShareStore.add(this)
    }
  }

  async setPermanent() {
    if (!this._isPermanent) {
      if (!this.shareId) {
        const data = await this.plugin.serverAPI.createPermanentSession()
        if (!data) return
        this._shareId = data.id
      }
      this._isPermanent = true
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

  async startIndexedDBSync() {
    if (this._indexedDBProvider) return this._indexedDBProvider
    const id = (await this.plugin.permanentShareStore.getDocByPath(this.path))?.persistenceId
    if (!id) return
    this._indexedDBProvider = new IndexeddbPersistence(SharedEntity.DB_PERSISTENCE_PREFIX + id, this.yDoc)
    return this._indexedDBProvider
  }

  addExtensionToLeaf(leafId: string) {
    // only makes sense if we have a webrct provider to sync with
    const webRTCProvider = this.startWebRTCSync()
    if (!webRTCProvider) return
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
    webRTCProvider.awareness.setLocalStateField('user', {
      name: this.plugin.settings.name,
      color: SharedDocument._userColor.dark,
      colorLight: SharedDocument._userColor.light
    })

    const extension = yCollab(this.getContentFragment(), webRTCProvider.awareness, { undoManager })
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

  addStatusBarEntry() {
    if (this.statusBarEntry) return
    const menu = new Menu()
    menu.addItem((item) => {
      item.setTitle("Copy link")
      item.onClick(() => {
        navigator.clipboard.writeText(this.plugin.settings.basePath + "/cm/" + this.shareId)
        showNotice("Link copied to clipboard.")
      })
    })

    menu.addItem((item) => {
      item.setTitle("Stop shared session")
      item.onClick(async () => {
        await this.unshare()
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

  async unshare() {
    const dbEntry = await this.plugin.permanentShareStore.getDocByPath(this.path)
    if (dbEntry) {
      this.plugin.permanentShareStore.removeDoc(this.path)
    }
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.clearData()
      await this._indexedDBProvider.destroy()
    }
    this.destroy()
  }


  destroy() {
    if (!this.isPermanent) {
      showNotice("Stopping collaboration on " + this.path + ".")
    }
    for (const key of this._extensions.keys) {
      this.removeExtensionFromLeaf(key)
    }
    this._extensions.destroy()
    super.destroy()
    this.removeStatusStatusBarEntry()
    SharedDocument._sharedEntites.splice(SharedDocument._sharedEntites.indexOf(this), 1)
  }
}