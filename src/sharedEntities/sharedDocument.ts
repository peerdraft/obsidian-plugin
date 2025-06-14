import { MarkdownView, Menu, TFile, debounce, normalizePath } from 'obsidian'
import * as Y from 'yjs'
import { calculateHash, generateRandomString, randomUint32 } from '../tools'
import { Compartment } from "@codemirror/state";
import PeerDraftPlugin from '../main';
import { openFileInNewTab, pinLeaf, showNotice, usercolors } from '../ui';
import { yCollab } from 'y-codemirror.next';
import { EditorView } from '@codemirror/view';
import { StateEffect } from "@codemirror/state";
import { PeerdraftRecord } from '../utils/peerdraftRecord';
import { type PermanentShareDocument } from '../permanentShareStore';
import { getLeafIdsByPath } from '../workspace/peerdraftWorkspace';
import { SharedEntity } from './sharedEntity';
import * as path from 'path';
import { IndexeddbPersistence } from 'y-indexeddb';
import { addIsSharedClass, removeIsSharedClass } from 'src/workspace/explorerView';
import { SharedFolder } from './sharedFolder';
import { Mutex } from 'async-mutex';
import { diff, diffCleanupEfficiency } from 'diff-match-patch-es'
import { add, getDocByPath, moveDoc, removeDoc } from 'src/permanentShareStoreFS';
import { openLoginModal } from 'src/ui/login';
import { promptForText } from 'src/ui/enterText';
import { addCanvasToYDoc, applyDataChangesToDoc, diffCanvases, yDocToCanvasJSON } from './canvas';
import { addCanvasExtension, type CanvasView, type Node } from 'src/ui/canvas';
import JSONC from "tiny-jsonc"

export class SharedDocument extends SharedEntity {

  public static _userColor = usercolors[randomUint32() % usercolors.length]

  private _isPermanent: boolean
  private _file: TFile

  private _extensions: PeerdraftRecord<Compartment>
  private _canvasExtenstions: PeerdraftRecord<() => any>

  private statusBarEntry?: HTMLElement

  protected static _sharedEntites: Array<SharedDocument> = new Array<SharedDocument>()

  private mutex = new Mutex
  private lastUpdateTriggeredByDocChange: number

  isCanvas: boolean

  static async fromView(view: MarkdownView, plugin: PeerDraftPlugin, opts = { permanent: false }) {
    if (!view.file) return
    if (this.findByPath(view.file.path)) return
    const doc = await this.fromTFile(view.file, opts, plugin)
    if (doc) {
      doc.startWebRTCSync()
      if (doc.isPermanent && doc._webRTCProvider) {
        doc.getOwnerFragment().insert(0, doc._webRTCProvider.awareness.clientID.toFixed(0))
      } else {
        doc.addStatusBarEntry()
        pinLeaf(view.leaf)
      }
      navigator.clipboard.writeText(plugin.settings.basePath + "/cm/" + doc.shareId)
      showNotice("Collaboration started for " + doc.path + ". Link copied to Clipboard.")
    }
    return doc
  }

  static async fromPermanentShareDocument(pd: PermanentShareDocument, plugin: PeerDraftPlugin) {
    if (this.findByPath(pd.path)) return
    //let fileAlreadyThere = false
    // check if path exists
    let file = plugin.app.vault.getAbstractFileByPath(normalizePath(pd.path))
    if (!file) {
      showNotice("File " + pd.path + " not found. Creating it now.")
      await SharedFolder.getOrCreatePath(path.dirname(pd.path), plugin)
      file = await plugin.app.vault.create(pd.path, '')
      if (!file) {
        showNotice("Error creating file " + pd.path + ".")
        return
      }
      // fileAlreadyThere = true
    }

    const doc = new SharedDocument({
      path: pd.path
    }, plugin)
    doc._isPermanent = true
    doc._shareId = pd.shareId
    doc.isCanvas = "canvas" === (file as TFile).extension
    if (doc.isCanvas) {
      doc.setupFileSyncForCanvas()
    } else {
      doc.setupFileSyncForContent()
    }
    await doc.startIndexedDBSync()
    //if (fileAlreadyThere) {
    doc.syncWithServer()
    //}
    plugin.activeStreamClient.add([doc.shareId])
    addIsSharedClass(doc.path, plugin)
    return doc
  }

  static async fromShareURL(url: string, plugin: PeerDraftPlugin): Promise<SharedDocument | void> {
    const id = url.split('/').pop()
    if (!id || !id.match('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) {
      showNotice("No valid peerdraft link")
      return
    }

    const existingDoc = SharedDocument.findById(id)
    if (existingDoc) {
      showNotice("This share is already active: " + existingDoc.path)
      return
    }

    const isPermanent = await plugin.serverAPI.isSessionPermanent(id)

    const yDoc = new Y.Doc()

    showNotice("Trying to initiate sync...")

    const doc = new SharedDocument({
      id,
      yDoc
    }, plugin)

    // wait for first update to make sure it works and to get the filename

    await new Promise<void>((resolve) => {
      doc.startWebRTCSync()
      if (isPermanent) {
        doc.syncWithServer()
      }
      yDoc.once("update", () => {
        resolve()
      })
    })

    if (yDoc.share.has('canvas')) {
      doc.isCanvas = true
      doc.setupFileSyncForCanvas()
    } else {
      doc.isCanvas = false
      doc.setupFileSyncForContent()
    }

    const docFilename = doc.yDoc.getText("originalFilename").toString()
    let initialFileName = `_peerdraft_session_${id}_${generateRandomString()}.${doc.isCanvas ? 'canvas' : 'md'}`
    if (docFilename != '') {
      const fileExists = plugin.app.vault.getAbstractFileByPath(normalizePath(docFilename))
      if (!fileExists) {
        initialFileName = docFilename
      } else {
        initialFileName = `_peerdraft_${generateRandomString()}_${docFilename}`
      }
    }

    const parent = plugin.settings.root || plugin.app.fileManager.getNewFileParent('', initialFileName).path
    const filePath = path.join(parent, initialFileName)
    const folder = await SharedFolder.getOrCreatePath(path.dirname(filePath), plugin)
    const file = await plugin.app.vault.create(filePath, doc.getValue())
    addIsSharedClass(file.path, plugin)
    doc._file = file
    doc._path = file.path

    if (isPermanent) {
      doc._isPermanent = true
      await add(doc, plugin)
      await doc.startIndexedDBSync()
      plugin.activeStreamClient.add([doc.shareId])
    }

    const leaf = await openFileInNewTab(file, plugin.app.workspace)
    if (leaf.view.getViewType() === "markdown") {
      // @ts-expect-error
      doc.addExtensionToLeaf(leaf.id)
    }
    pinLeaf(leaf)
    showNotice("Joined Session in " + doc.path + ".")
    return doc

  }

  static async fromIdAndPath(id: string, location: string, plugin: PeerDraftPlugin) {
    const normalizedPath = normalizePath(location)
    const existingDoc = SharedDocument.findById(id)
    if (existingDoc) {
      showNotice("This share is already active: " + existingDoc.path)
      return
    }
    await SharedFolder.getOrCreatePath(path.dirname(normalizedPath), plugin)
    showNotice("Creating new synced file " + normalizedPath)
    const ydoc = await plugin.serverSync.requestDocument(id)
    const doc = new SharedDocument({
      id, yDoc: ydoc
    }, plugin)
    if (ydoc.share.has("canvas")) {
      doc.isCanvas = true
      doc.setupFileSyncForCanvas()
    } else {
      doc.isCanvas = false
      doc.setupFileSyncForContent
    }
    doc._path = normalizedPath
    const file = await plugin.app.vault.create(normalizedPath, doc.getValue())
    doc._file = file

    doc.syncWithServer()
    await doc.setPermanent()
    await doc.startIndexedDBSync()
    addIsSharedClass(doc.path, plugin)
  }


  static async fromTFile(file: TFile, opts: { permanent?: boolean, folder?: string }, plugin: PeerDraftPlugin) {
    const existing = SharedDocument.findByPath(file.path)
    if (existing) return existing

    if (!(plugin.serverSync.authenticated || opts.folder)) {
      showNotice("Please log in to Peerdraft first.")
      const auth = await openLoginModal(plugin)
      if (!auth) return
    }

    const doc = new SharedDocument({ path: file.path }, plugin)

    if (file.extension === "canvas") {
      doc.isCanvas = true
      doc.setupFileSyncForCanvas()
    } else {
      doc.isCanvas = false
      doc.setupFileSyncForContent()
    }

    const leafIds = getLeafIdsByPath(file.path, plugin.pws.markdown)

    if (leafIds.length > 0) {
      const content = (plugin.app.workspace.getLeafById(leafIds[0])?.view as MarkdownView).editor.getValue()
      doc.getContentFragment().insert(0, content)
    } else {
      const content = await plugin.app.vault.read(file)
      if (doc.isCanvas) {
        addCanvasToYDoc(JSONC.parse(content || '{}'), doc.yDoc)
      } else {
        doc.getContentFragment().insert(0, content)
      }
    }

    doc.yDoc.getText("originalFilename").insert(0, file.name)

    if (opts.permanent) {
      await doc.initServerYDoc(opts.folder)
      await doc.setPermanent()
      // doc.startWebSocketSync()
      doc.startIndexedDBSync()
    } else {
      doc._shareId = await plugin.serverSync.createNewSession()
    }

    for (const id of leafIds) {
      doc.addExtensionToLeaf(id)
    }

    showNotice(`Inititialized share for ${file.path}`)
    addIsSharedClass(file.path, plugin)
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
    id?: string,
    yDoc?: Y.Doc
  }, plugin: PeerDraftPlugin) {
    super(plugin)
    this.yDoc = opts.yDoc ?? new Y.Doc()
    if (opts.path) {
      this._path = normalizePath(opts.path)
      const file = this.plugin.app.vault.getAbstractFileByPath(normalizePath(opts.path))
      if ((file instanceof TFile)) {
        this._file = file
        if (file.extension === "canvas") {
          this.isCanvas = true
          this.setupFileSyncForCanvas()
        } else {
          this.isCanvas = false
          this.setupFileSyncForContent()
        }
      } else {
        showNotice("ERROR creating sharedDoc")
      }
    }
    if (opts.id) {
      this._shareId = opts.id
    }
    const pendingUpdates: Array<Uint8Array> = []

    const sendUpdates = debounce(() => {
      this.mutex.runExclusive(() => {
        plugin.serverSync.sendUpdate(this, Y.mergeUpdates(pendingUpdates))
        pendingUpdates.length = 0
      })
    }, 1000, true)

    this.yDoc.on("update", (update: Uint8Array, origin: any, yDoc: Y.Doc, tr: Y.Transaction) => {
      if (tr.local && this.isPermanent) {
        pendingUpdates.push(update)
        sendUpdates()
      }
    })

    SharedDocument._sharedEntites.push(this)

    this._extensions = new PeerdraftRecord<Compartment>()
    this._extensions.on("delete", () => {
      if (this._extensions.size === 0 && this._webRTCProvider) {
        this._webRTCProvider.awareness.setLocalState({})
      }
    })

    this._extensions.on("add", () => {
      if (this._extensions.size === 1 && this._webRTCProvider) {
        this._webRTCProvider.awareness.setLocalStateField('user', {
          name: this.plugin.settings.name,
          color: SharedDocument._userColor.dark,
          colorLight: SharedDocument._userColor.light
        })
      }
    })

    this._canvasExtenstions = new PeerdraftRecord<any>()

    // addIsSharedClass(this.path, this.plugin)
  }


  setupFileSyncForCanvas() {

    const updateFile = debounce(() => {
      this.mutex.runExclusive(async () => {
        const yCanvas = yDocToCanvasJSON(this.yDoc)
        const fileContent = await this.plugin.app.vault.read(this._file)
        const fileCanvas = JSONC.parse(fileContent || '{}')
        const diffs = diffCanvases(fileCanvas, yCanvas)
        if (diffs.length != 0) {
          this.lastUpdateTriggeredByDocChange = new Date().valueOf()
          await this.plugin.app.vault.modify(this._file, JSON.stringify(yCanvas), {
            mtime: this.lastUpdateTriggeredByDocChange
          })
        }
      })
    }, 1000, true)

    this.yDoc.getMap('canvas').observeDeep(async (events, tx) => {
      if (this._file && !tx.local && this._canvasExtenstions.size === 0) {
        updateFile()
      }
    })

    this.plugin.registerEvent(this.plugin.app.vault.on("modify", async (file) => {
      if (this.file === file && this.file.stat.mtime != this.lastUpdateTriggeredByDocChange && this._canvasExtenstions.size === 0) {
        // check if document and content actually are out of sync
        this.mutex.runExclusive(async () => {

          const fileContent = await this.plugin.app.vault.read(this._file)

          applyDataChangesToDoc(JSONC.parse(fileContent || '{}'), this.yDoc)

        })
      }
    }))
  }


  setupFileSyncForContent() {

    const updateFile = debounce(() => {
      this.mutex.runExclusive(async () => {
        const yDocContent = this.getValue()
        const fileContent = await this.plugin.app.vault.read(this._file)
        if (yDocContent != fileContent) {
          this.lastUpdateTriggeredByDocChange = new Date().valueOf()
          await this.plugin.app.vault.modify(this._file, yDocContent, {
            mtime: this.lastUpdateTriggeredByDocChange
          })
        }
      })
    }, 1000, true)

    this.getContentFragment().observe(async () => {
      if (this._file && this._extensions.size === 0) {
        updateFile()
      }
    })

    this.plugin.registerEvent(this.plugin.app.vault.on("modify", async (file) => {
      // only react to changes of this file, and only if it didn't happen within the editor.
      // The editor extension takes care of updates in that case.
      if (this.file === file && this._extensions.size === 0 && this.file.stat.mtime != this.lastUpdateTriggeredByDocChange) {
        // check if document and content actually are out of sync
        this.mutex.runExclusive(async () => {
          const yDocContent = this.getValue()
          const fileContent = await this.plugin.app.vault.read(this._file)
          if (yDocContent != fileContent) {
            const diffs = diff(yDocContent, fileContent)
            diffCleanupEfficiency(diffs)
            const content = this.getContentFragment()
            let pos = 0
            this.yDoc.transact(() => {
              for (const diff of diffs) {
                const text = diff[1] as string
                const length = text.length
                switch (diff[0]) {
                  // keep
                  case 0:
                    {
                      pos += length
                    }
                    break;
                  // remove
                  case -1:
                    {
                      content.delete(pos, length)
                    }
                    break;
                  // add
                  case 1:
                    {
                      content.insert(pos, text)
                      pos += length
                    }
                    break;
                }
              }
            })
          }
        })
      }
    }))
  }

  get file() {
    return this._file
  }

  calculateHash() {
    const text = this.getContentFragment().toString()
    return calculateHash(text)
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
            if (peer && peer.cursor && this.path && key != this._webRTCProvider?.awareness.clientID) {
              showNotice(`${peer.user?.name} is working on ${this.path}`, 10000)
            }
          }
        }
      })


      /*
      if (!this._webRTCTimeout) {

        const handleTimeout = () => {
          if (this._extensions.size > 0 || getLeafIdsByPath(this.path, this.plugin.pws).length > 0) {
            this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)
          } else {
            this.stopWebRTCSync()
          }
        }

        this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)

        provider.doc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc, tr: Y.Transaction) => {
          if (this._webRTCTimeout != null) {
            window.clearTimeout(this._webRTCTimeout)
          }
          this._webRTCTimeout = window.setTimeout(handleTimeout, 60000)
        })
      }
      */

    })

  }

  async setNewFileLocation(file: TFile) {
    const oldPath = this._path
    this._file = file
    this._path = normalizePath(file.path)
    if (this.statusBarEntry) {
      this.removeStatusStatusBarEntry()
      this.addStatusBarEntry()
    }
    await moveDoc(oldPath, file.path, this.plugin)
    removeIsSharedClass(oldPath, this.plugin)
    addIsSharedClass(this.path, this.plugin)
  }

  async setPermanent() {
    if (!this._isPermanent) {
      this._isPermanent = true
      await add(this, this.plugin)
      this.plugin.activeStreamClient.add([this.shareId])
    }
  }

  get isPermanent() {
    return this._isPermanent
  }

  getValue() {
    if (!this.isCanvas) {
      return this.getContentFragment().toString()
    } else {
      return JSON.stringify(yDocToCanvasJSON(this.yDoc))
    }

  }

  getContentFragment() {
    return this.yDoc.getText("content")
  }

  getOwnerFragment() {
    return this.yDoc.getText("owner")
  }

  async startIndexedDBSync() {
    if (this._indexedDBProvider) return this._indexedDBProvider
    const id = (getDocByPath(this.path, this.plugin))?.persistenceId
    if (!id) return
    const provider = new IndexeddbPersistence(SharedEntity.DB_PERSISTENCE_PREFIX + id, this.yDoc)
    this._indexedDBProvider = provider
    if (!provider.synced) await provider.whenSynced

    return this._indexedDBProvider
  }

  addExtensionToLeaf(leafId: string) {
    // only makes sense if we have a webrct provider to sync with
    const webRTCProvider = this.startWebRTCSync()
    if (!webRTCProvider) return
    // already there
    if (this._extensions.get(leafId)) return
    // need a pleaf
    const pLeaf = this.plugin.pws.markdown.get(leafId)
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
      try {
        const editor = (leaf.view as MarkdownView).editor
        const editorView = (editor as any).cm as EditorView;
        const compartment = this._extensions.get(leafId)
        if (compartment) {
          editorView.dispatch({
            effects: compartment.reconfigure([])
          })
        }
      } catch (error) {
        this.plugin.log("editor already gone")
      }
    }
    this._extensions.delete(leafId)
  }

  addCanvasExtensionToLeaf(leafId: string) {
    // only makes sense if we have a webrct provider to sync with
    const webRTCProvider = this.startWebRTCSync()
    if (!webRTCProvider) return
    // already there
    if (this._canvasExtenstions.get(leafId)) return
    // need a pcanvas
    const pCanvas = this.plugin.pws.canvas.get(leafId)
    if (!pCanvas) return
    // path needs to match

    if (pCanvas.path != this._path) return
    const leaf = this.plugin.app.workspace.getLeafById(leafId)
    if (!leaf) return

    const view = leaf.view as CanvasView
    const canvas = view.canvas
    const extension = addCanvasExtension(this, view)
    if (extension) {
      this._canvasExtenstions.set(leafId, extension)
    }
  }

  removeCanvasExtensionFromLeaf(leafId: string) {

    const leaf = this.plugin.app.workspace.getLeafById(leafId)
    if (leaf) {
      const uninstall = this._canvasExtenstions.get(leafId)
      if (uninstall) {
        uninstall()
      }
    }
    this._canvasExtenstions.delete(leafId)
  }

  addExtensionToCanvasFileNode(node: Node) {
    // only makes sense if we have a webrct provider to sync with
    const webRTCProvider = this.startWebRTCSync()
    if (!webRTCProvider) return
    // already there
    if (this._extensions.get(node.id)) return
    // path needs to match
    if (node.file.path != this._path) return
    // there needs to be an editor
    const editor = node.child?.editor
    if (!editor) return
    editor.setValue(this.getValue())
    const undoManager = new Y.UndoManager(this.getContentFragment())
    const extension = yCollab(this.getContentFragment(), webRTCProvider.awareness, { undoManager })
    const compartment = new Compartment()
    const editorView = (editor as any).cm as EditorView;
    editorView.dispatch({
      effects: StateEffect.appendConfig.of(compartment.of(extension))
    })
    this._extensions.set(node.id, compartment)
    return Compartment
  }

  removeExtensionFromCanvasFileNode(node: Node) {
    const editor = node.child?.editor
    if (editor) {
      const editorView = (editor as any).cm as EditorView;
      const compartment = this._extensions.get(node.id)
      if (compartment) {
        editorView.dispatch({
          effects: compartment.reconfigure([])
        })
      }
    }
    this._extensions.delete(node.id)
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
    const dbEntry = getDocByPath(this.path, this.plugin)
    if (dbEntry) {
      removeDoc(this.path, this.plugin)
    }
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.clearData()
    }
    this.destroy()
    removeIsSharedClass(this.path, this.plugin)
  }

  getShareURL() {
    return this.plugin.settings.basePath + "/cm/" + this.shareId
  }

  updateProperty(name: string, value: string, oldProperty?: string) {
    this.plugin.app.fileManager.processFrontMatter(this.file, (fm) => {
      if (oldProperty) {
        delete fm[oldProperty]
      }
      fm[name] = value
    })
  }

  static async stopSession(id: string, plugin: PeerDraftPlugin) {

    const text = await promptForText(plugin.app, {
      description: "This document will not be synced with any vault anymore and can not be accessed via the Peerdraft Web Editor. Enter YES, if you really want to do this.",
      header: "Do you really want to stop sharing?",
      initial: {
        text: "NO"
      }
    })

    if (!text || text.text !== "YES") return

    await plugin.serverSync.stopSession(id)
    const doc = SharedDocument.findById(id)
    if (doc) await doc.unshare()
  }


  async destroy() {
    for (const key of this._extensions.keys) {
      this.removeExtensionFromLeaf(key)
    }
    this._extensions.destroy()
    super.destroy()
    this.removeStatusStatusBarEntry()
    SharedDocument._sharedEntites.splice(SharedDocument._sharedEntites.indexOf(this), 1)
  }
}