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
import { addIsSharedClass, removeIsSharedClass, setStatusClass, removeStatusClass } from 'src/workspace/explorerView';
import { SharedFolder } from './sharedFolder';
import { Mutex } from 'async-mutex';
import { add, getDocByPath, moveDoc, removeDoc } from 'src/permanentShareStoreFS';
import { openLoginModal } from 'src/ui/login';
import { promptForText } from 'src/ui/enterText';
import { addCanvasToYDoc, applyDataChangesToDoc, diffCanvases, yDocToCanvasJSON } from './canvas';
import { addCanvasExtension, type CanvasView, type Node } from 'src/ui/canvas';
import JSONC from "tiny-jsonc"
import { SyncableDocument, type SyncableFileIO, type SyncableClock } from './syncableDocument';

// FileIO adapter wrapping Obsidian's vault API.
class VaultFileIO implements SyncableFileIO {
  constructor(private file: TFile, private plugin: PeerDraftPlugin) {}

  async read(): Promise<string> {
    return await this.plugin.app.vault.read(this.file)
  }

  async modify(content: string, opts?: { mtime?: number }): Promise<void> {
    await this.plugin.app.vault.modify(this.file, content, opts)
  }

  getMTime(): number {
    return this.file.stat.mtime
  }
}

// Clock adapter using Date.now().
class RealClock implements SyncableClock {
  now(): number {
    return Date.now()
  }
}

export class SharedDocument extends SharedEntity {

  public static _userColor = usercolors[randomUint32() % usercolors.length]

  private _isPermanent: boolean
  private _file: TFile

  private _extensions: PeerdraftRecord<Compartment>
  private _canvasExtenstions: PeerdraftRecord<() => any>

  private _initializationGuardPassed = false
  private _initializationGuardMutex = new Mutex()
  private _vaultModifyListenerRegistered = false

  get initializationGuardPassed(): boolean {
    return this._initializationGuardPassed
  }

  private statusBarEntry?: HTMLElement

  protected static _sharedEntites: Array<SharedDocument> = new Array<SharedDocument>()

  private _syncable!: SyncableDocument

  override get indexedDBProvider(): IndexeddbPersistence | undefined {
    return this._syncable?.indexedDBProvider
  }

  get syncable(): SyncableDocument {
    return this._syncable
  }

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
    let file = plugin.app.vault.getAbstractFileByPath(normalizePath(pd.path))
    if (!file) {
      showNotice("File " + pd.path + " not found. Creating it now.")
      await SharedFolder.getOrCreatePath(path.dirname(pd.path), plugin)
      file = await plugin.app.vault.create(pd.path, '')
      if (!file) {
        showNotice("Error creating file " + pd.path + ".")
        return
      }
    }

    const doc = new SharedDocument({
      path: pd.path
    }, plugin)
    doc.setIsPermanentInternal(true)
    doc.setShareIdInternal(pd.shareId)
    doc.isCanvas = "canvas" === (file as TFile).extension
    // Document loaded from DB is not new
    doc._syncable._setIsNewDocument(false)

    doc._setupInitializationGuard()
    doc._setupStatusIndicatorSubscriptions()
    await doc.startIndexedDBSync()
    if (doc.indexedDBProvider) {
      if (!doc.indexedDBProvider.synced) await doc.indexedDBProvider.whenSynced
    }
    doc.syncWithServer()
    plugin.activeStreamClient.add([doc.shareId])
    // Don't add pd-explorer-shared class - status indicators replace it
    // Existing document from permanent share is already confirmed
    doc._syncable._setNewDocConfirmed(true)

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
    // Don't add pd-explorer-shared class - status indicators replace it
    doc._file = file
    doc._path = file.path
    // Set fileIO on the syncable now that the file is available
    doc._syncable.setFileIO(new VaultFileIO(file, plugin))

    if (isPermanent) {
      doc.setIsPermanentInternal(true)
      await add(doc, plugin)
      await doc.startIndexedDBSync()
      plugin.activeStreamClient.add([doc.shareId])
      // Status indicator will update when initialization guard passes via subscriptions
    } else {
      // Update status indicator for non-permanent documents
      await doc._updateWebRTCStatusIndicator()
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
    // Set fileIO on the syncable now that the file is available
    doc._syncable.setFileIO(new VaultFileIO(file, plugin))

    doc.syncWithServer()
    await doc.setPermanent()
    // Set up status indicator system for permanent documents
    doc._setupInitializationGuard()
    doc._setupStatusIndicatorSubscriptions()
    // Update status indicator immediately to show syncing state
    doc._updateStatusIndicator()
    await doc.startIndexedDBSync()
    // Don't use old addIsSharedClass - status indicators replace it
  }


  static async fromTFile(file: TFile, opts: { permanent?: boolean, folder?: string }, plugin: PeerDraftPlugin) {
    const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB in bytes
    if (file.stat.size > MAX_FILE_SIZE) {
      showNotice(`File is too large to share (${(file.stat.size / (1024 * 1024)).toFixed(2)}MB). Maximum size is 1MB.`);
      return null;
    }
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
      // Mark as new document - should show syncing even before guard passes
      doc._syncable._setIsNewDocument(true)
      doc._setupInitializationGuard()
      doc._setupStatusIndicatorSubscriptions()
      // Sync with server to set serverSynced=true
      doc.syncWithServer()
      // Status indicator will update when initialization guard passes via subscriptions
      await doc._updateStatusIndicator()
    } else {
      doc.setShareIdInternal(await plugin.serverSync.createNewSession())
    }

    for (const id of leafIds) {
      doc.addExtensionToLeaf(id)
    }

    showNotice(`Inititialized share for ${file.path}`)
    // Don't add pd-explorer-shared class - status indicators replace it

    // Update status indicator for non-permanent documents
    if (!opts.permanent) {
      await doc._updateWebRTCStatusIndicator()
    }

    // Add author property if configured
    if (opts.folder) {
      const folder = SharedFolder.findById(opts.folder)
      if (folder) {
        const authorProp = folder.getAutoFillAuthorProperty()
        const authorPropType = folder.getAutoFillAuthorPropertyType()
        if (authorProp && authorProp !== "") {
          doc.updateProperty(authorProp, plugin.settings.name, undefined, authorPropType)
        }
      }
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
        } else {
          this.isCanvas = false
        }
      } else {
        showNotice("ERROR creating sharedDoc")
      }
    }
    if (opts.id) {
      this._shareId = opts.id
    }

    const fileIO = this._file ? new VaultFileIO(this._file, plugin) : undefined
    const clock = new RealClock()
    this._syncable = new SyncableDocument({
      yDoc: this.yDoc,
      shareId: this._shareId,
      isPermanent: this._isPermanent ?? false,
      serverSync: plugin.serverSync,
      fileIO,
      clock,
      editorAttachedCount: () => this._extensions.size,
      logger: { log: (...args: unknown[]) => plugin.log(args.map((a) => String(a)).join(' ')) }
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

  }


  setupFileSyncForCanvas() {
    if (this._vaultModifyListenerRegistered) {
      return
    }

    const canvasMutex = new Mutex()
    let lastCanvasUpdateMtime = 0

    const updateFile = debounce(() => {
      canvasMutex.runExclusive(async () => {
        const yCanvas = yDocToCanvasJSON(this.yDoc)
        const fileContent = await this.plugin.app.vault.read(this._file)
        const fileCanvas = JSONC.parse(fileContent || '{}')
        const diffs = diffCanvases(fileCanvas, yCanvas)
        if (diffs.length != 0) {
          lastCanvasUpdateMtime = new Date().valueOf()
          await this.plugin.app.vault.modify(this._file, JSON.stringify(yCanvas), {
            mtime: lastCanvasUpdateMtime
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
      if (this.file === file && this.file.stat.mtime != lastCanvasUpdateMtime && this._canvasExtenstions.size === 0) {
        canvasMutex.runExclusive(async () => {
          const fileContent = await this.plugin.app.vault.read(this._file)
          applyDataChangesToDoc(JSONC.parse(fileContent || '{}'), this.yDoc)
        })
      }
    }))

    this._vaultModifyListenerRegistered = true
  }


  setupFileSyncForContent() {
    if (this._vaultModifyListenerRegistered) {
      return
    }

    this.plugin.registerEvent(this.plugin.app.vault.on("modify", async (file) => {
      if (this.file === file) {
        const fileContent = await this.plugin.app.vault.read(this._file)
        await this._syncable.reconcileWithFileContent(fileContent)
      }
    }))
    this._vaultModifyListenerRegistered = true
  }

  private _checkInitializationGuard(): boolean {
    return this._syncable.serverSynced || (this._syncable.indexedDBLoaded && !this._syncable.indexedDBWasEmpty)
  }

  private _setupInitializationGuard() {
    const handleGuardConditionMet = async () => {
      const release = await this._initializationGuardMutex.acquire()
      try {
        if (this._initializationGuardPassed) return
        this._initializationGuardPassed = true

        if (this.isCanvas) {
          this.setupFileSyncForCanvas()
        } else {
          this.setupFileSyncForContent()
        }

        const leafIds = getLeafIdsByPath(this.path, this.plugin.pws.markdown)
        if (leafIds.length > 0) {
          for (const id of leafIds) {
            this.addExtensionToLeaf(id)
          }
        } else {
          const fileContent = await this.plugin.app.vault.read(this._file)
          await this._syncable.reconcileWithFileContent(fileContent)
        }

        this.plugin.log(`Initialization guard passed for ${this.path}`)
        
        // Set initial status after initialization
        if (this.isPermanent) {
          this._updateStatusIndicator()
        }
      } finally {
        release()
      }
    }

    const indexedDBHandler = (data: { wasEmpty: boolean }) => {
      if (this._checkInitializationGuard()) {
        handleGuardConditionMet()
      }
    }
    this._syncable.on('indexedDBLoaded', indexedDBHandler)

    const serverSyncedHandler = () => {
      if (this._checkInitializationGuard()) {
        handleGuardConditionMet()
      }
    }
    this._syncable.on('serverSynced', serverSyncedHandler)

    const syncStateChangedHandler = () => {
      if (this._checkInitializationGuard() && !this._initializationGuardPassed) {
        handleGuardConditionMet()
      }
      // Update status indicator when sync state changes
      if (this.isPermanent && this._initializationGuardPassed) {
        this._updateStatusIndicator()
      }
    }
    this._syncable.on('syncStateChanged', syncStateChangedHandler)
  }

  private _setupStatusIndicatorSubscriptions() {
    // Subscribe to WebSocket connection state changes
    this.plugin.serverSync.on('status', () => {
      if (this.isPermanent) {
        this._updateStatusIndicator()
      }
    })

    // Subscribe to sync state changes
    this._syncable.on('syncStateChanged', () => {
      if (this.isPermanent) {
        this._updateStatusIndicator()
      }
    })
  }

  private async _updateStatusIndicator() {
    const status = this.getSyncStatus()
    await setStatusClass(this.path, this.plugin, status)
  }

  private async _updateWebRTCStatusIndicator() {
    const status = this.getWebRTCStatus()
    await setStatusClass(this.path, this.plugin, status)
  }

  private getWebRTCStatus(): 'disconnected' | 'connected' | 'not-initialized' {
    if (!this._webRTCProvider) {
      return 'not-initialized'
    }

    const states = this._webRTCProvider.awareness.getStates()
    const peerCount = states.size - 1 // Exclude self
    
    return peerCount > 0 ? 'connected' : 'disconnected'
  }

  get file() {
    return this._file
  }

  calculateHash() {
    return this._syncable.calculateHash()
  }

  private setShareIdInternal(id: string) {
    this._shareId = id
    this._syncable?.setShareId(id)
  }

  private setIsPermanentInternal(value: boolean) {
    this._isPermanent = value
    this._syncable?.setPermanent(value)
  }

  async initServerYDoc(folderKey?: string) {
    return new Promise<string>(resolve => {
      const tempId = generateRandomString()
      const handler = (confirmedTempId: string, id: string, checksum: string) => {
        if (confirmedTempId === tempId) {
          this.plugin.serverSync.off('new-doc-confirmed', handler)
          this._syncable._setNewDocConfirmed(true)
          this._shareId = id
          this._syncable.setShareId(id)
          resolve(checksum)
        }
      }
      this.plugin.serverSync.on('new-doc-confirmed', handler)
      this.plugin.serverSync.sendNewDocument(this, tempId, folderKey)
    })
  }

  syncWithServer() {
    return this._syncable.syncWithServer()
  }

  startWebRTCSync() {
    return super.startWebRTCSync((provider) => {
      provider.awareness.on("update", async (msg: { added: Array<number>, removed: Array<number> }) => {
        const removed = msg.removed ?? [];
        if (removed && removed.length > 0) {
          const removedStrings = removed.map((n) => n.toString())
          const owner = this.getOwnerFragment().toString()
          if (owner != provider.awareness.clientID.toString()) {
            if (removedStrings.includes(owner) && !this.isPermanent) {
              showNotice("Shared session for " + this.path + " stopped by owner")
              this.unshare()
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

        // Update status indicator for non-permanent documents
        if (!this.isPermanent) {
          await this._updateWebRTCStatusIndicator()
        }
      })
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
    // Use status indicator system instead of old addIsSharedClass
    this._updateStatusIndicator()
  }

  async setPermanent() {
    if (!this._isPermanent) {
      this.setIsPermanentInternal(true)
      await add(this, this.plugin)
      this.plugin.activeStreamClient.add([this.shareId])
    }
  }

  get isPermanent() {
    return this._isPermanent
  }

  getSyncStatus(): 'offline' | 'syncing' | 'insync' | 'warning' | 'not-initialized' {
    const wsconnected = this.plugin.serverSync.wsconnected
    const serverSyncing = this._syncable.serverSyncing
    const serverSynced = this._syncable.serverSynced
    const indexedDBWasEmpty = this._syncable.indexedDBWasEmpty
    const isNewDocument = this._syncable.isNewDocument

    // Warning takes precedence - show even if guard hasn't passed.
    // With deferred IndexedDB creation, IndexedDB may not exist at all
    // (!indexedDBLoaded) if server never synced, which also means no
    // reliable local data.
    if (!wsconnected && !serverSynced && (!this._syncable.indexedDBLoaded || indexedDBWasEmpty)) {
      return 'warning'
    }

    // If this is a newly created permanent document, show syncing even if guard hasn't passed
    if (isNewDocument && this.isPermanent) {
      return 'syncing'
    }

    // Check initialization guard for offline state
    if (!wsconnected) {
      if (!this._initializationGuardPassed) {
        return 'not-initialized'
      }
      return 'offline'
    }

    // When connected but guard hasn't passed, show syncing instead of not-initialized
    // This handles the transition from warning state when going online
    if (!this._initializationGuardPassed) {
      return 'syncing'
    }

    if (serverSyncing) {
      return 'syncing'
    }

    if (serverSynced) {
      return 'insync'
    }

    return 'offline'
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

  async startIndexedDBSync(): Promise<IndexeddbPersistence | undefined> {
    if (this._syncable.indexedDBProvider) return this._syncable.indexedDBProvider
    const id = (getDocByPath(this.path, this.plugin))?.persistenceId
    if (!id) return
    const provider = await this._syncable.startIndexedDBSync(id)
    return provider
  }

  addExtensionToLeaf(leafId: string) {
    const webRTCProvider = this.startWebRTCSync()
    if (!webRTCProvider) return
    if (this._extensions.get(leafId)) return
    const pLeaf = this.plugin.pws.markdown.get(leafId)
    if (!pLeaf) return

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

    this.plugin.log(`Attaching collaborative extension to leaf ${leafId} for ${this.path}`)
    editor.setValue(this.getValue())

    const undoManager = new Y.UndoManager(this.getContentFragment())

    const extension = yCollab(this.getContentFragment(), webRTCProvider.awareness, { undoManager })
    const compartment = new Compartment()

    const editorView = (editor as any).cm as EditorView;
    editorView.dispatch({
      effects: StateEffect.appendConfig.of(compartment.of(extension))
    })

    this._extensions.set(leafId, compartment)

    pLeaf.once("changeIsPreview", () => {
      this.removeExtensionFromLeaf(leafId)
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
    const webRTCProvider = this.startWebRTCSync()
    if (!webRTCProvider) return
    if (this._canvasExtenstions.get(leafId)) return
    const pCanvas = this.plugin.pws.canvas.get(leafId)
    if (!pCanvas) return

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
    const webRTCProvider = this.startWebRTCSync()
    if (!webRTCProvider) return
    if (this._extensions.get(node.id)) return
    if (node.file.path != this._path) return
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
    if (this._syncable.indexedDBProvider) {
      await this._syncable.indexedDBProvider.clearData()
      await this._syncable.indexedDBProvider.destroy()
    }
    this.destroy()
    await removeStatusClass(this.path, this.plugin)
    // Don't add back pd-explorer-shared since we're replacing it with status indicators
  }

  getShareURL() {
    return this.plugin.settings.basePath + "/cm/" + this.shareId
  }

  updateProperty(name: string, value: string, oldProperty?: string, type?: "string" | "array") {
    this.plugin.app.fileManager.processFrontMatter(this.file, (fm) => {
      if (oldProperty) {
        delete fm[oldProperty]
      }

      if (type === "array") {
        const trimmedValue = value.trim()

        if (fm[name] !== undefined) {
          if (Array.isArray(fm[name])) {
            // Property exists as array - check for duplicates and append
            const existingArray = fm[name] as string[]
            const normalizedArray = existingArray.map(v => v.trim().toLowerCase())
            if (!normalizedArray.includes(trimmedValue.toLowerCase())) {
              existingArray.push(trimmedValue)
            }
          } else {
            // Property exists as string - convert to array
            fm[name] = [fm[name], trimmedValue]
          }
        } else {
          // Property doesn't exist - create array
          fm[name] = [trimmedValue]
        }
      } else {
        // Default string behavior - overwrite
        fm[name] = value
      }
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
    this._syncable.destroy()
    super.destroy()
    this.removeStatusStatusBarEntry()

    this._initializationGuardPassed = false
    this._vaultModifyListenerRegistered = false
    SharedDocument._sharedEntites.splice(SharedDocument._sharedEntites.indexOf(this), 1)
  }
}