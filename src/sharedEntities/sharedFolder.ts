import { Mutex } from 'async-mutex';
import { TAbstractFile, TFile, TFolder, Notice, normalizePath } from "obsidian";
import * as path from 'path-browserify';
import PeerDraftPlugin from "src/main";
import { type PermanentShareFolder } from "src/permanentShareStore";
import { add, getFolderByPath, moveFolder, removeFolder } from "src/permanentShareStoreFS";
import { promptForText } from "src/ui/enterText";
import { StopSessionError } from "../peerdraftWebSocketProvider";
import { openLoginModal } from "src/ui/login";
import { removeIsSharedClass, removeStatusClass, setStatusClass } from "src/workspace/explorerView";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from 'yjs';
import { generateRandomString } from "../tools";
import { showNotice } from "../ui";
import { isBinaryContent } from "../utils/fileTypeDetection";
import { BinaryFileSync } from "./binaryFileSync";
import { SharedDocument } from "./sharedDocument";
import { SharedEntity } from "./sharedEntity";
import { SyncableFolder } from "./syncableFolder";
import { folderImportQueue, importedFilePath, withImportFileOperation } from '../folderImport';
import { saveSettingsNow } from '../settings';
import { textSha256 } from '../fastRestart';

const handleUpdate = <T>(ev: Y.YMapEvent<T>, tx: Y.Transaction, folder: SharedFolder, plugin: PeerDraftPlugin) => {

  if (!folder.isActive || !([plugin.serverSync, folder.webRTCProvider?.room].includes(tx.origin))) return

  const changedKeys = ev.changes.keys

  changedKeys.forEach((data, key) => {
    void (async () => {
    if (data.action === "add") {
      const relativePath = tx.doc.getMap<string>("documents").get(key)
      if (typeof relativePath !== 'string') return
      const absolutePath = path.join(folder.path, relativePath)
      const file = plugin.app.vault.getAbstractFileByPath(absolutePath)
      if (file) {

        const existingDoc = SharedDocument.findById(key)
        if (existingDoc) {
          if (existingDoc.file.path === file.path) {
          } else {
            // Duplicate shareId detected - create new share for this file
            if (file instanceof TFile) {
              const newDoc = await SharedDocument.fromTFile(file, { 
                permanent: true, 
                folder: folder.shareId 
              }, plugin)
              if (newDoc) {
                // Update folder Y.Doc with new shareId
                const documentMap = tx.doc.getMap<string>("documents")
                documentMap.delete(key)
                documentMap.set(newDoc.shareId, relativePath)
              }
            }
          }
        } else {
          const inServerShares = plugin.settings.serverShares.files.has(normalizePath(absolutePath))
          if (inServerShares) {
            if (plugin.settings.serverShares.files.get(normalizePath(absolutePath))?.shareId === key) {
              await folder.queueDocumentImport(key)
            }
            return
          }

          // Real conflict - file exists but is not a known permanent share
          showNotice("File " + file.path + " already exists. Renaming local file.")

          const alteredPath = path.join(path.dirname(relativePath), path.basename(relativePath, path.extname(relativePath)) + "_" + generateRandomString() + path.extname(relativePath))
          const alteredAbsolutePath = path.join(folder.root.path, alteredPath)
          await plugin.app.fileManager.renameFile(file, alteredAbsolutePath)
          if (folder.isActive) await folder.queueDocumentImport(key)
        }
      } else {
        await folder.queueDocumentImport(key)
      }
    } else if (data.action === "update") {
      let newPath = tx.doc.getMap<string>("documents").get(key) as string
      // If an "add" for this key is still in flight (fromIdAndPath doing a
      // server round-trip), wait for it to finish before looking up the
      // document — otherwise findById returns undefined and the rename is
      // silently dropped.
      const pendingAdd = folder._pendingAdds.get(key)
      if (pendingAdd) {
        await pendingAdd
      }
      newPath = folder.getDocsFragment().get(key) as string
      if (!folder.isActive || !newPath) return
      const document = SharedDocument.findById(key)
      if (!document) {
        await folder.recoverChangedImport(key, data.oldValue as string, newPath)
        return
      }
      const expectedOldPath = importedFilePath(folder.path, data.oldValue as string)
      const expectedNewPath = importedFilePath(folder.path, newPath)
      if (document.path !== expectedOldPath && document.path !== expectedNewPath) {
        await folder.queueDocumentImport(key)
        return
      }
      const docFolder = SharedFolder.getSharedFolderForSubPath(document.path)
      if (!docFolder) return
      let newAbsolutePath = path.join(docFolder.root.path, newPath)
      await SharedFolder.getOrCreatePath(path.parse(newAbsolutePath).dir, plugin)

      const alreadyExists = SharedDocument.findByPath(newAbsolutePath)
      if (alreadyExists) {
        if (alreadyExists.shareId === key) {
        } else {
          showNotice("File " + newPath + " already exists. Renaming local file.")
          const alteredPath = path.join(path.dirname(newPath), path.basename(newPath, path.extname(newPath)) + "_" + generateRandomString() + path.extname(newPath))
          const alteredAbsolutePath = path.join(docFolder.root.path, alteredPath)
          void plugin.app.fileManager.renameFile(alreadyExists.file, alteredAbsolutePath)
          void SharedDocument.fromIdAndPath(key, alteredAbsolutePath, plugin)
        }
      } else {
        await plugin.app.fileManager.renameFile(document.file, newAbsolutePath)
      }
    } else if (data.action === "delete") {
      const pendingAdd = folder._pendingAdds.get(key)
      if (pendingAdd) {
        await pendingAdd
      }
      if (!folder.isActive || folder.getDocsFragment().has(key)) return
      const document = SharedDocument.findById(key)
      if (!document) {
        await folder.recoverChangedImport(key, data.oldValue as string)
        return
      }
      if (document.path !== importedFilePath(folder.path, data.oldValue as string)) {
        await folder.recoverChangedImport(key, data.oldValue as string)
        return
      }
      const file = plugin.app.vault.getAbstractFileByPath(document.path)
      await document.unshare()
      if (!file || !folder.isActive || folder.getDocsFragment().has(key)) return
      await plugin.app.vault.delete(file)
    }
    })().catch(error => {
      if (folder.isActive) {
        console.error('[Peerdraft] Could not apply shared folder change', error)
        showNotice('Could not apply a shared folder change. Reload to retry.')
      }
    })
  })
}

export class SharedFolder extends SharedEntity {

  root: TFolder
  protected static _sharedEntites: Array<SharedFolder> = new Array<SharedFolder>()

  private _initializationGuardPassed = false
  private _initializationGuardMutex = new Mutex()

  // Tracks in-flight fromIdAndPath promises for keys being added. When an
  // "update" event (rename) arrives for a key whose "add" hasn't finished
  // yet, the update handler awaits this promise before looking up the
  // document — without it, findById returns undefined and the rename is
  // silently dropped (the file stays as Untitled.md forever).
  _pendingAdds = new Map<string, Promise<void>>()
  private _importStopped = false
  private _importTask?: Promise<void>
  private _manifestRefresh?: Promise<void>
  private _manifestRefreshRequested = false
  private _importNotice?: Notice
  private _importProgressTimer?: ReturnType<typeof setTimeout>
  private _importTotal = 0
  private _reconcilingImport = false
  private readonly _importRecovery = new Map<string, Mutex>()
  private readonly _importFailures = new Set<string>()
  // Retry transport failures normally, but leave an unchanged ownership/path
  // conflict paused until its file, registration, or manifest target changes.
  private readonly _importConflicts = new Map<string, { file: TAbstractFile | null; signature: string }>()

  // Sync-engine state delegated to composed SyncableFolder instance.
  private _syncable!: SyncableFolder

  // Binary file sync manager
  private _binaryFileSync?: BinaryFileSync

  override get indexedDBProvider(): IndexeddbPersistence | undefined {
    return this._syncable?.indexedDBProvider
  }

  /**
   * Route a binary file event to BinaryFileSync
   */
  public async handleBinaryFile(file: TFile): Promise<void> {
    await this._binaryFileSync?.handleBinaryFile(file)
  }

  /**
   * Route a binary file rename event to BinaryFileSync
   */
  public handleBinaryFileRename(file: TFile, oldPath: string): void {
    this._binaryFileSync?.handleBinaryFileRename(file, oldPath)
  }

  /** Stops sharing a binary file, leaving it in the vault. Returns false if it was not shared. */
  public unshareBinaryFile(filePath: string): boolean {
    const relativePath = this.relativeBinaryPath(filePath)
    return relativePath !== undefined && (this._binaryFileSync?.unshareFile(relativePath) ?? false)
  }

  /**
   * Check if a file is tracked as binary (by old or new path)
   */
  public isBinaryFileTracked(filePath: string): boolean {
    const relativePath = this.relativeBinaryPath(filePath)
    return relativePath !== undefined && (this._binaryFileSync?.isFileTracked(relativePath) ?? false)
  }

  /**
   * Whether filePath is currently being written to disk as the result of a
   * remote binary-file download - lets vault event handlers skip
   * re-processing the event that write itself produces.
   */
  public isRemoteBinaryUpdateInProgress(filePath: string): boolean {
    const relativePath = this.relativeBinaryPath(filePath)
    return relativePath !== undefined && (this._binaryFileSync?.isRemoteUpdateInProgress(relativePath) ?? false)
  }

  private relativeBinaryPath(filePath: string): string | undefined {
    const normalizedFolderPath = normalizePath(this.root.path)
    const normalizedFilePath = normalizePath(filePath)
    if (normalizedFilePath === normalizedFolderPath || !normalizedFilePath.startsWith(normalizedFolderPath + '/')) {
      return undefined
    }
    return normalizedFilePath.slice(normalizedFolderPath.length + 1)
  }

  static async fromTFolder(root: TFolder, plugin: PeerDraftPlugin) {
    showNotice(`Inititializing share for ${root.path}.`)
    const sharedFolder = new this(root, plugin)
    sharedFolder.initializeYDoc()
    const files = sharedFolder.getFilesInFolder(root)

    for (const file of files) {
      if (SharedDocument.findByPath(file.path)) {
        showNotice("You can not share a directory that already has shared files in it (right now).")
        return
      }
    }

    if(!plugin.serverSync.authenticated) {
      showNotice("Please log in to Peerdraft first.")
      const auth = await openLoginModal(plugin)
      if (!auth) return
    }

    sharedFolder._setupInitializationGuard()
    sharedFolder._setupStatusIndicatorSubscriptions()
    void sharedFolder._updateStatusIndicator()

    // Files already present when the folder is first shared aren't vault
    // 'create'/'modify' events - peerdraftPlugin.ts never sees them, so
    // they need the same content-based binary/text routing done by hand
    // here, or a pre-existing image would get misfiled as a SharedDocument.
    const textFiles: TFile[] = []
    const binaryFiles: TFile[] = []
    for (const file of files) {
      const content = await plugin.app.vault.readBinary(file)
      if (await isBinaryContent(content, file.name)) {
        binaryFiles.push(file)
      } else {
        textFiles.push(file)
      }
    }

    const docs = await Promise.all(textFiles.map((file) => {
      return SharedDocument.fromTFile(file, {
        permanent: true
      }, plugin)
    }))

    for (const doc of docs) {
      if (doc) {
        sharedFolder.addDocument(doc)
      }
    }

    sharedFolder.yDoc.getText("originalFoldername").insert(0, root.name)

    await sharedFolder.initServerYDoc()

    await add(sharedFolder, plugin)
    await sharedFolder.startIndexedDBSync()
    void sharedFolder.syncWithServer()
    void sharedFolder.startWebRTCSync()

    // Initialize binary file sync (sets up the Y.Map observer for remote
    // changes and downloads any binary files already tracked remotely),
    // then upload whichever binary files were already present locally.
    await sharedFolder._binaryFileSync?.initialize()
    for (const file of binaryFiles) {
      await sharedFolder._binaryFileSync?.handleBinaryFile(file)
    }

    void navigator.clipboard.writeText(plugin.settings.basePath + '/team/' + sharedFolder.shareId)
    showNotice(`Folder ${sharedFolder.path} with ${docs.length} documents shared. URL copied to your clipboard.`, 0)
    return sharedFolder
  }

  getShareURL() {
    return this.plugin.settings.basePath + "/team/" + this.shareId
  }

  static async recreate(folder: SharedFolder, plugin: PeerDraftPlugin) {
    const location = folder.root.path
    await folder.unshare()
    await plugin.app.vault.delete(folder.root, true)
    return await this.fromShareURL(plugin.settings.basePath + '/team/' + folder.shareId, plugin, location)
  }

  static async fromShareURL(url: string, plugin: PeerDraftPlugin, location?: string): Promise<SharedFolder | void> {
    const id = url.split('/').pop()
    if (!id || !id.match('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) {
      showNotice("No valid peerdraft link")
      return
    }

    const existingFolder = SharedFolder.findById(id)
    if (existingFolder) {
      showNotice("This share is already active: " + existingFolder.path)
      return
    }

    let folderPath = location
    await plugin.fastRestart?.prepare([id])
    const preFetchedDoc = await plugin.serverSync.requestDocument(id)


    if (!folderPath) {
      let initialRootName = `_peerdraft_team_folder_${generateRandomString()}`
      const docFoldername = preFetchedDoc.getText("originalFoldername").toString()
      if (docFoldername != '') {
        const folderExists = plugin.app.vault.getAbstractFileByPath(path.join(plugin.settings.root, docFoldername))
        if (!folderExists) {
          initialRootName = docFoldername
        } else {
          initialRootName = `_peerdraft_${generateRandomString()}_${docFoldername}`
        }
      }

      folderPath = path.join(plugin.settings.root, initialRootName)
    }

    const folder = await SharedFolder.getOrCreatePath(folderPath!, plugin)

    if (!folder) {
      showNotice("Could not create folder " + folderPath)
      return
    };

    const sFolder = new SharedFolder(folder, plugin, preFetchedDoc)
    sFolder.setShareIdInternal(id)
    plugin.activeStreamClient.add([id])

    await add(sFolder, plugin)
    sFolder._setupInitializationGuard()
    sFolder._setupStatusIndicatorSubscriptions()
    void sFolder._updateStatusIndicator()

    const paths: Array<string> = []
    const documentMap = preFetchedDoc.getMap("documents") as Y.Map<string>

    for (const entry of documentMap.entries()) {
      let docPath = entry[1]
      let absPath = path.join(folderPath!, docPath)
      const normalizedAbsPath = normalizePath(absPath)
      
      // Check if this shareId is already used by a different file (duplicate corruption)
      const existingDoc = SharedDocument.findById(entry[0])
      if (existingDoc && existingDoc.path !== normalizedAbsPath) {
        // Duplicate shareId detected - create new share for this file
        const file = plugin.app.vault.getAbstractFileByPath(absPath)
        if (file instanceof TFile) {
          const newDoc = await SharedDocument.fromTFile(file, { 
            permanent: true, 
            folder: sFolder.shareId 
          }, plugin)
          if (newDoc) {
            // Update folder Y.Doc with new shareId
            documentMap.delete(entry[0])
            documentMap.set(newDoc.shareId, docPath)
          }
        }
        continue
      }
      
      if (docPath && paths.includes(normalizePath(docPath))) {
        if (existingDoc) {
          if (existingDoc.path === normalizedAbsPath) {
          } else {
            void plugin.app.fileManager.renameFile(existingDoc.file, absPath)
          }
        } else {
          docPath = normalizePath(path.join(path.dirname(docPath), path.basename(docPath, path.extname(docPath)) + "_" + generateRandomString() + path.extname(docPath)))
          documentMap.set(entry[0], docPath)
          absPath = path.join(folderPath!, docPath)
        }
      }
      paths.push(normalizePath(docPath))
    }

    // Make the manifest/cache durable first. Recovery must not depend on
    // receiving add events for unchanged entries after a process restart.
    sFolder.beginImportJournal()
    await saveSettingsNow(plugin.settings, plugin)
    await sFolder._syncable.syncWithServer(20000)
    await sFolder.startIndexedDBSync()
    await sFolder._syncable.whenIndexedDBSynced()
    if (!sFolder._syncable.indexedDBLoaded) throw new Error('Could not persist shared folder manifest')
    void sFolder.startWebRTCSync()
    await sFolder.importMissingDocuments()
    
    // Initialize binary file sync
    await sFolder._binaryFileSync?.initialize()
    
    return sFolder
  }

  static async fromPermanentShareFolder(psf: PermanentShareFolder, plugin: PeerDraftPlugin) {
    if (this.findByPath(psf.path)) return
    let tFolder: void | null | TAbstractFile
    tFolder = plugin.app.vault.getAbstractFileByPath(psf.path)
    if (tFolder instanceof TFile) {
      showNotice("Expected " + psf.path + " to be a folder, but it is a file?")
      return
    }
    if (!(tFolder instanceof TFolder)) {
      showNotice("Shared folder " + psf.path + " not found. Creating it now.")
      tFolder = await this.getOrCreatePath(psf.path, plugin)
    }
    if (!(tFolder instanceof TFolder)) {
      showNotice("Could not create folder " + psf.path + ".")
      return
    }

    const folder = new SharedFolder(tFolder, plugin)
    folder.setShareIdInternal(psf.shareId)
    plugin.activeStreamClient.add([psf.shareId])

    folder._setupInitializationGuard()
    folder._setupStatusIndicatorSubscriptions()
    void folder._updateStatusIndicator()
    await folder.startIndexedDBSync()
    folder._syncable.on('serverSynced', () => { void folder.importMissingDocuments() })
    void folder.syncWithServer()

    // Attachment catch-up must not hold up restored editors or other shares.
    void folder._binaryFileSync?.initialize().catch((error: unknown) => {
      if (SharedFolder.findByPath(folder.path) !== folder) return
      console.error('[Peerdraft] Could not initialize attachments for shared folder', folder.path, error)
      showNotice(`Peerdraft could not initialize attachments in ${folder.path}. See the console for details.`)
    })

    return folder
  }

  static findByPath(path: string) {
    return super.findByPath(path) as SharedFolder | undefined
  }

  static findById(id: string) {
    return super.findById(id) as SharedFolder | undefined
  }


  static getAll() {
    return super.getAll() as Array<SharedFolder>
  }

  static getSharedFolderForSubPath(dir: string) {
    const normalizedPath = normalizePath(dir)
    const folders = this.getAll()
    for (const folder of folders) {
      if (folder.root.path === normalizedPath) return folder
      if (folder.isPathSubPath(normalizedPath)) return folder
    }
  }

  private constructor(root: TFolder, plugin: PeerDraftPlugin, ydoc?: Y.Doc) {
    super(plugin)
    this.root = root
    this._path = root.path
    this.yDoc = ydoc ?? new Y.Doc()

    // Restored folders must hydrate without allocating local clocks first.
    // New shares initialize their defaults explicitly in fromTFolder instead.

    this.getDocsFragment().observe((ev, tx) => {
      handleUpdate(ev, tx, this, plugin)
    })

    this._syncable = new SyncableFolder({
      yDoc: this.yDoc,
      shareId: this._shareId,
      serverSync: plugin.serverSync,
      logger: { log: (...args: unknown[]) => plugin.log(args.map((a) => String(a)).join(' ')) }
    })

    // Initialize binary file sync
    this._binaryFileSync = new BinaryFileSync(
      this.yDoc,
      this.root,
      this.plugin,
      () => this.shareId
    )

    SharedFolder._sharedEntites.push(this)
  }

  private setShareIdInternal(id: string) {
    this._shareId = id
    this._syncable?.setShareId(id)
  }

  initServerYDoc(folderKey?: string) {
    return super.initServerYDoc(folderKey).then((checksum) => {
      this._syncable.setShareId(this._shareId)
      return checksum
    })
  }

  syncWithServer() {
    return this._syncable.syncWithServer()
  }

  getDocsFragment() {
    return this.yDoc.getMap<string>('documents')
  }


  getDocByRelativePath(dir: string) {
    const normalizedPath = normalizePath(dir)
    for (const entry of this.getDocsFragment().entries()) {
      if (entry[1] === normalizedPath) return entry[0]
    }
  }

  updatePath(oldPath: string, newPath: string) {
    const oldPathRelative = path.relative(this.root.path, oldPath)
    const newPathRelative = path.relative(this.root.path, newPath)

    const id = this.getDocByRelativePath(oldPathRelative)
    if (id) {
      this.getDocsFragment().set(id, normalizePath(newPathRelative))
    }
    return id
  }

  calculateHash(): string {
    return this._syncable.calculateHash()
  }

  getOriginalFolderName() {
    return this.yDoc.getText("originalFoldername").toString()
  }

  setOriginalFolderName(name: string) {
    const text = this.yDoc.getText("originalFoldername")
    text.delete(0, text.length)
    text.insert(0, name)
  }

  getAutoFillProperty() {
    return this.yDoc.getText("autoFillProperty").toString()
  }

  setAutoFillProperty(property: string) {
    const prop = this.yDoc.getText("autoFillProperty")
    prop.delete(0, prop.length)
    prop.insert(0, property)
  }

  getAutoFillAuthorProperty() {
    return this.yDoc.getText("autoFillAuthorProperty").toString()
  }

  setAutoFillAuthorProperty(property: string) {
    const prop = this.yDoc.getText("autoFillAuthorProperty")
    prop.delete(0, prop.length)
    prop.insert(0, property)
  }

  getAutoFillAuthorPropertyType() {
    const type = this.yDoc.getText("autoFillAuthorPropertyType").toString()
    return type === "array" ? "array" : "string"
  }

  setAutoFillAuthorPropertyType(type: "string" | "array") {
    const prop = this.yDoc.getText("autoFillAuthorPropertyType")
    prop.delete(0, prop.length)
    prop.insert(0, type)
  }

  async updatePropertiesOfAllDocuments(oldPropertyName?: string) {
    const prop = this.getAutoFillProperty()
    if (!prop || prop === "") return
    const docs = this.getDocsFragment()
    for (const entry of docs) {
      const doc = SharedDocument.findById(entry[0])
      if (!doc) return
      doc.updateProperty(prop, doc.getShareURL(), oldPropertyName)
    }
  }

  addDocument(doc: SharedDocument) {
    if (this.getDocsFragment().get(doc.shareId)) return
    const relativePath = path.relative(this.root.path, doc.path)
    if (relativePath.startsWith('..')) return
    this.getDocsFragment().set(doc.shareId, relativePath)
  }

  removeDocument(doc: SharedDocument) {
    this.getDocsFragment().delete(doc.shareId)
    const deleted = this.yDoc.getArray("deleted") as Y.Array<string>
    if (!deleted.toArray().includes(doc.shareId)){
      deleted.push([doc.shareId])
    }
  }

  isPathSubPath(folder: string) {
    const relativePath = path.relative(this.root.path, folder)
    return !(relativePath.startsWith('..'))
  }

  private _fileExtensions: Set<string> = new Set(['md', 'canvas', 'MD'])

  get fileExtensions(): Set<string> {
    if (this.yDoc) {
      const extensions = this.yDoc.getArray<string>('fileExtensions')
      if (extensions.length > 0) {
        return new Set(extensions.toArray())
      }
    }
    return this._fileExtensions
  }
  setFileExtensions(extensions: string[]) {
    const normalized = extensions.map(ext => ext.startsWith('.') ? ext.slice(1) : ext)
    this._fileExtensions = new Set(normalized)
    
    if (this.yDoc) {
      const yExtensions = this.yDoc.getArray<string>('fileExtensions')
      yExtensions.delete(0, yExtensions.length)
      yExtensions.push(normalized)
    }
  }

  private static getAllFilesInFolder(folder: TFolder, allowedExtensions: Set<string>): Array<TFile> {
    const files = folder.children.flatMap((child) => {
      if (child instanceof TFile) {
        const ext = child.extension.toLowerCase()
        return allowedExtensions.has(ext) ? [child] : []
      }
      if (child instanceof TFolder) {
        return this.getAllFilesInFolder(child, allowedExtensions)
      }
      return []
    })
    return files
  }

  get isActive(): boolean { return !this._importStopped }

  /** Import also catches server/API membership changes without requiring a live peer. */
  refreshImportManifest(): Promise<void> {
    if (this._importStopped) return Promise.resolve()
    this._manifestRefreshRequested = true
    if (this._manifestRefresh) return this._manifestRefresh
    const task = (async (): Promise<void> => {
      do {
        this._manifestRefreshRequested = false
        await this._syncable.syncWithServer(20000)
      } while (!this._importStopped && this._manifestRefreshRequested)
    })()
    this._manifestRefresh = task
    const clear = (): void => { if (this._manifestRefresh === task) this._manifestRefresh = undefined }
    void task.then(clear, clear)
    return task
  }

  private beginImportJournal() {
    const sessions = this.plugin.settings.folderImports ??= {}
    const session = sessions[this.shareId] ??= { path: this.path, startedAt: Date.now(), documents: {} }
    session.path = this.path
    session.documents ??= {}
    for (const [id, relative] of this.getDocsFragment().entries()) {
      const target = importedFilePath(this.path, relative)
      const previous = session.documents[id]
      if (!previous) session.documents[id] = { path: target }
    }
    this._importTotal = this.getDocsFragment().size
    return session
  }

  /** Older registrations have no importedFrom marker. Match their ID and
   * owning root before treating an old filename as this manifest's document. */
  private ownsRegisteredImport(id: string, localPath: string): boolean {
    const saved = this.plugin.settings.serverShares.files.get(localPath)
    if (saved?.shareId !== id || !localPath.startsWith(this.path + '/')) return false
    if (saved.importedFrom) return saved.importedFrom === this.shareId
    // Legacy ownership is sufficient for a current member's rename, never for
    // deleting an unmarked local share after remote membership disappeared.
    if (!this.getDocsFragment().has(id)) return false
    const roots = new Set([
      ...this.plugin.settings.serverShares.folders.keys(),
      ...SharedFolder.getAll().map(folder => folder.path),
    ])
    return !Array.from(roots).some(root => root.startsWith(this.path + '/') && localPath.startsWith(root + '/'))
  }

  private importConflictState(id: string): { file: TAbstractFile | null; signature: string } | undefined {
    const relative = this.getDocsFragment().get(id)
    if (!relative) return
    let target: string
    try { target = importedFilePath(this.path, relative) } catch { return }
    const file = this.plugin.app.vault.getAbstractFileByPath(target) ?? null
    const saved = this.plugin.settings.serverShares.files.get(target)
    const model = SharedDocument.findById(id)
    if (!(model && model.path !== target) && !(file && (!(file instanceof TFile) || (saved && saved.shareId !== id)))) return
    return { file, signature: JSON.stringify([
      target, model?.path, saved?.shareId,
      model ? this.ownsRegisteredImport(id, model.path) : false,
    ]) }
  }

  private hasUnchangedImportConflict(id: string): boolean {
    const previous = this._importConflicts.get(id)
    if (!previous) return false
    const current = this.importConflictState(id)
    if (current && current.file === previous.file && current.signature === previous.signature) return true
    this._importConflicts.delete(id)
    return false
  }

  /** Queue both cold-join and live-add work through the same vault-wide budget. */
  queueDocumentImport(id: string): Promise<void> {
    const pending = this._pendingAdds.get(id)
    if (pending) return pending
    if (this._importStopped || !this.getDocsFragment().has(id)) return Promise.resolve()
    if (this.hasUnchangedImportConflict(id)) return Promise.resolve()
    const queue = folderImportQueue(this.plugin)
    let runningRoot: string | undefined
    const run = queue.schedule(this.shareId + ':' + id, async () => {
      if (this._importStopped) return
      runningRoot = this.path
      const relative = this.getDocsFragment().get(id)
      if (!relative) return
      const target = importedFilePath(this.path, relative)
      const current = (): boolean => !this._importStopped && this.getDocsFragment().get(id) === relative &&
        importedFilePath(this.path, relative) === target
      const sessions = this.plugin.settings.folderImports ??= {}
      const session = sessions[this.shareId] ??= { path: this.path, startedAt: Date.now(), documents: {} }
      const entry = session.documents[id] ??= { path: target }
      let allowExistingFile = false
      const file = this.plugin.app.vault.getAbstractFileByPath(target)
      const saved = this.plugin.settings.serverShares.files.get(target)
      if (file instanceof TFile && !saved) {
        if (entry.path === target && (entry.materialized ||
          (entry.contentHash && await textSha256(await this.plugin.app.vault.read(file)) === entry.contentHash))) {
          allowExistingFile = true
        } else {
          if (!current()) return
          // A user-created file at a queued destination is kept as a conflict
          // copy, never silently adopted or uploaded as the remote document.
          const extension = path.extname(target)
          const alternate = target.slice(0, target.length - extension.length) + '_' + generateRandomString() + extension
          await withImportFileOperation(this.plugin, [file.path, alternate],
            () => this.plugin.app.fileManager.renameFile(file, alternate))
          showNotice('Kept an existing local file as ' + alternate)
        }
      }
      if (!current()) return
      const document = await SharedDocument.fromIdAndPath(id, target, this.plugin, {
        quiet: true, isCurrent: current, allowExistingFile,
        beforeCreate: async content => {
          if (!current()) throw new Error('Import stopped before file creation')
          const contentHash = await textSha256(content)
          if (!current()) throw new Error('Import changed while preparing file ownership')
          entry.path = target
          entry.contentHash = contentHash
          entry.materialized = false
          await saveSettingsNow(this.plugin.settings, this.plugin)
        },
        afterCreate: async () => {
          // The pre-create hash already makes a late completed write recoverable.
          // An unloaded plugin must not persist an older settings snapshot.
          if (this._importStopped) return
          entry.materialized = true
          await saveSettingsNow(this.plugin.settings, this.plugin)
        },
      })
      if (!current()) return
      if (document.path !== target) {
        throw new Error('Share is already active at ' + document.path + '; cannot also import at ' + target)
      }
      this._importFailures.delete(id)
      this._importConflicts.delete(id)
      const savedDocument = this.plugin.settings.serverShares.files.get(target)
      if (savedDocument?.shareId === id) savedDocument.importedFrom = this.shareId
      delete session.documents[id]
      await saveSettingsNow(this.plugin.settings, this.plugin)
    })
    const completion = run.catch(error => {
      if (this._importStopped || !this.getDocsFragment().has(id) ||
        (runningRoot !== undefined && runningRoot !== this.path)) return
      // Renames are recovered by their observer after this pending job settles.
      const target = this.plugin.settings.folderImports?.[this.shareId]?.documents[id]?.path
      try {
        if (target && target !== importedFilePath(this.path, this.getDocsFragment().get(id)!)) return
      } catch { /* Invalid current paths are visible failures, not escaped writes. */ }
      this._importFailures.add(id)
      const conflict = this.importConflictState(id)
      if (conflict) this._importConflicts.set(id, conflict)
      console.error('[Peerdraft] Could not import shared document', error)
    }).then(async () => {
      this._pendingAdds.delete(id)
      await this.finishImportIfComplete()
      this.scheduleImportProgress()
    })
    this._pendingAdds.set(id, completion)
    this.scheduleImportProgress()
    return completion
  }

  /** Cache replay does not emit remote add events; explicitly resume missing entries. */
  private importMissingDocuments(): Promise<void> {
    if (this._importTask) return this._importTask
    if (this._importStopped) return Promise.resolve()
    const candidates = SharedDocument.getAll()
    const known = new Map(candidates.map(doc => [doc.shareId, doc]))
    const needsWork = Array.from(this.getDocsFragment().entries()).some(([id, relative]) => {
      const doc = known.get(id)
      return !doc || doc.initialImportInProgress || doc.path !== importedFilePath(this.path, relative)
    }) || Array.from(this.plugin.settings.serverShares.files.entries()).some(([savedPath, saved]) =>
      saved.importedFrom === this.shareId && savedPath.startsWith(this.path + '/') &&
      !this.getDocsFragment().has(saved.shareId))
    const previous = this.plugin.settings.folderImports?.[this.shareId]
    if (!needsWork && !previous) return Promise.resolve()
    const task = (async (): Promise<void> => {
      const session = this.beginImportJournal()
      this._reconcilingImport = true
      try {
        // Preserve an old path/hash until a cached rename/deletion has really
        // reached disk. Cache replay alone emits no remote membership event.
        const entries = new Map(Object.entries(session.documents))
        for (const [savedPath, saved] of this.plugin.settings.serverShares.files) {
          if (saved.importedFrom === this.shareId && savedPath.startsWith(this.path + '/') && !this.getDocsFragment().has(saved.shareId)) {
            entries.set(saved.shareId, { path: savedPath, materialized: true })
          }
        }
        for (const [id, entry] of entries) {
          if (this._importStopped) return
          if (this._pendingAdds.has(id)) continue
          if (this.hasUnchangedImportConflict(id)) continue
          const relative = this.getDocsFragment().get(id)
          const model = SharedDocument.findById(id)
          const sourceAuthorized = model && (this.ownsRegisteredImport(id, model.path) ||
            (entry.path === model.path && (entry.materialized || !!entry.contentHash)))
          const oldPath = sourceAuthorized ? model.path : entry.path
          const target = relative ? importedFilePath(this.path, relative) : undefined
          if (oldPath !== target) {
            await this.recoverChangedImport(id, path.relative(this.path, oldPath), relative, false)
          }
        }
      } finally { this._reconcilingImport = false }
      const restored = new Map(SharedDocument.getAll().map(doc => [doc.shareId, doc]))
      const missing = Array.from(this.getDocsFragment().entries()).filter(([id, relative]) => {
        const doc = restored.get(id)
        return !doc || doc.initialImportInProgress || doc.path !== importedFilePath(this.path, relative)
      }).map(([id]) => id)
      for (const id of Object.keys(session.documents)) {
        const doc = restored.get(id)
        const relative = this.getDocsFragment().get(id)
        if (relative && doc && !doc.initialImportInProgress && doc.path === importedFilePath(this.path, relative)) {
          delete session.documents[id]
          this._importFailures.delete(id)
          this._importConflicts.delete(id)
        }
      }
      await saveSettingsNow(this.plugin.settings, this.plugin)
      if (this._importStopped) return
      if (missing.length && !this._importNotice) {
        this._importNotice = showNotice('Importing ' + this.path + ': ' + (this._importTotal - missing.length) + ' / ' + this._importTotal, 0)
      }
      await this.plugin.fastRestart?.prepare([this.shareId, ...missing])
      if (this._importStopped) return
      await Promise.all(missing.map(id => this.queueDocumentImport(id)))
      await this.finishImportIfComplete()
      this.scheduleImportProgress()
    })().catch(error => {
      if (!this._importStopped) {
        console.error('[Peerdraft] Could not continue folder import', error)
        showNotice('Import paused in ' + this.path + '. Check the connection and developer console for details.')
      }
    })
    this._importTask = task
    void task.then(() => { if (this._importTask === task) this._importTask = undefined })
    return task
  }

  private async finishImportIfComplete(): Promise<void> {
    const session = this.plugin.settings.folderImports?.[this.shareId]
    const complete = (): boolean => !this._importStopped && !this._reconcilingImport && !this._pendingAdds.size &&
      !this._importFailures.size && !!session && !Object.keys(session.documents).length &&
      this.plugin.settings.folderImports?.[this.shareId] === session
    if (!complete()) return
    try {
      await this.plugin.fastRestart?.flushPersistence()
      if (!complete()) return
      delete this.plugin.settings.folderImports![this.shareId]
      await saveSettingsNow(this.plugin.settings, this.plugin)
      if (!this._importStopped && this._importNotice) {
        this._importNotice.hide()
        this._importNotice = undefined
        showNotice('Imported ' + this.getDocsFragment().size + ' documents in ' + this.path)
      }
    } catch (error) {
      console.error('[Peerdraft] Could not persist import completion', error)
    }
  }

  /** Recover a renamed/deleted pending entry even if its initialization was cancelled. */
  async recoverChangedImport(id: string, previousRelative: string, nextRelative?: string, queueNext = true): Promise<void> {
    const mutex = this._importRecovery.get(id) ?? new Mutex()
    this._importRecovery.set(id, mutex)
    try {
      await mutex.runExclusive(() => this.recoverChangedImportLocked(id, previousRelative, nextRelative, queueNext))
    } finally {
      if (!mutex.isLocked() && this._importRecovery.get(id) === mutex) this._importRecovery.delete(id)
    }
  }

  private async recoverChangedImportLocked(id: string, previousRelative: string, nextRelative: string | undefined, queueNext: boolean): Promise<void> {
    if (this._importStopped) return
    const recoveryRoot = this.path
    const session = this.plugin.settings.folderImports?.[this.shareId]
    const entry = session?.documents[id]
    const candidate = SharedDocument.findById(id)
    const sourceAuthorized = candidate && (this.ownsRegisteredImport(id, candidate.path) ||
      (entry?.path === candidate.path && (entry.materialized || !!entry.contentHash)))
    const previousPath = sourceAuthorized ? candidate.path : entry?.path ?? importedFilePath(this.path, previousRelative)
    const model = candidate?.path === previousPath ? candidate : undefined
    const file = this.plugin.app.vault.getAbstractFileByPath(previousPath)
    const saved = this.plugin.settings.serverShares.files.get(previousPath)
    let owned = (entry?.path === previousPath && entry.materialized) ||
      this.ownsRegisteredImport(id, previousPath)
    if (!owned && file instanceof TFile && entry?.contentHash) {
      owned = await textSha256(await this.plugin.app.vault.read(file)) === entry.contentHash
    }
    if (this._importStopped || this.path !== recoveryRoot) return
    // A later rename/delete may supersede the observer that started this work.
    nextRelative = this.getDocsFragment().get(id)
    if (file instanceof TFile && owned) {
      if (nextRelative) {
        let nextPath: string
        // Directory I/O may yield to another remote rename. Keep the per-ID
        // recovery lock and choose the latest manifest target before moving.
        while (true) {
          nextRelative = this.getDocsFragment().get(id)
          if (!nextRelative) {
            return this.recoverDeletedImport(id, file, saved, entry, session)
          }
          nextPath = importedFilePath(this.path, nextRelative)
          await SharedFolder.getOrCreatePath(path.dirname(nextPath), this.plugin)
          if (this._importStopped || this.path !== recoveryRoot) return
          if (this.getDocsFragment().get(id) === nextRelative) break
        }
        const collision = this.plugin.app.vault.getAbstractFileByPath(nextPath)
        if (collision && collision !== file) {
          this._importFailures.add(id)
          showNotice('Import rename conflicts with an existing file: ' + nextPath)
          return
        }
        if (file.path !== nextPath) {
          await withImportFileOperation(this.plugin, [file.path, nextPath],
            () => this.plugin.app.fileManager.renameFile(file, nextPath))
        }
        if (saved) {
          this.plugin.settings.serverShares.files.delete(previousPath)
          if (saved.shareId === id) saved.importedFrom = this.shareId
          this.plugin.settings.serverShares.files.set(nextPath, saved)
        }
        model?.updateFileRef(file)
        if (entry) entry.path = nextPath
      } else {
        if (model) await model.unshare()
        this.plugin.settings.serverShares.files.delete(previousPath)
        if (this._importStopped || this.getDocsFragment().has(id)) return
        await withImportFileOperation(this.plugin, [file.path], () => this.plugin.app.vault.delete(file))
      }
    }
    if (!nextRelative) {
      if (session) delete session.documents[id]
      this._importFailures.delete(id)
      this._importConflicts.delete(id)
      await saveSettingsNow(this.plugin.settings, this.plugin)
    } else {
      if (entry) entry.path = importedFilePath(this.path, nextRelative)
      await saveSettingsNow(this.plugin.settings, this.plugin)
      if (queueNext) await this.queueDocumentImport(id)
    }
    await this.finishImportIfComplete()
    this.scheduleImportProgress()
  }

  private async recoverDeletedImport(
    id: string, file: TFile,
    saved: { shareId: string; persistenceId: string } | undefined,
    entry: { path: string } | undefined,
    session: { documents: Record<string, { path: string }> } | undefined,
  ): Promise<void> {
    if (this._importStopped || this.getDocsFragment().has(id)) return
    const model = SharedDocument.findById(id)
    if (model?.file === file) await model.unshare()
    if (saved) this.plugin.settings.serverShares.files.delete(entry?.path ?? file.path)
    if (this._importStopped || this.getDocsFragment().has(id)) return
    await withImportFileOperation(this.plugin, [file.path], () => this.plugin.app.vault.delete(file))
    if (session) delete session.documents[id]
    this._importFailures.delete(id)
    this._importConflicts.delete(id)
    await saveSettingsNow(this.plugin.settings, this.plugin)
    await this.finishImportIfComplete()
    this.scheduleImportProgress()
  }

  private scheduleImportProgress(): void {
    if (this._importStopped || this._importProgressTimer) return
    this._importProgressTimer = setTimeout(() => {
      this._importProgressTimer = undefined
      if (this._importStopped) return
      this._importTotal = this.getDocsFragment().size
      const remaining = Object.keys(this.plugin.settings.folderImports?.[this.shareId]?.documents ?? {}).length
      this._importNotice?.setMessage('Importing ' + this.path + ': ' + Math.max(0, this._importTotal - remaining) +
        ' / ' + this._importTotal + (this._importFailures.size ?
          (this._importConflicts.size ? ' — paused: local file conflicts; see developer console' :
            ' — some files failed; retrying on the next connection sync') : ''))
      void this._updateStatusIndicator()
    }, 100)
  }

  private getFilesInFolder(folder: TFolder): Array<TFile> {
    return SharedFolder.getAllFilesInFolder(folder, this.fileExtensions)
  }

  protected initializeYDoc() {
    super.initializeYDoc()
    if (!this.yDoc) return
    
    const yExtensions = this.yDoc.getArray<string>('fileExtensions')
    if (yExtensions.length === 0) {
      yExtensions.push(['md', 'MD', 'canvas'])
    }
  }

  async setNewFolderLocation(folder: TFolder) {
    const oldPath = this._path
    this.root = folder
    this._path = normalizePath(folder.path)
    await moveFolder(oldPath, folder.path, this.plugin)
    const session = this.plugin.settings.folderImports?.[this.shareId]
    if (session) {
      session.path = this.path
      for (const entry of Object.values(session.documents)) {
        if (entry.path.startsWith(oldPath + '/')) entry.path = this.path + entry.path.slice(oldPath.length)
      }
      for (const [savedPath, saved] of Array.from(this.plugin.settings.serverShares.files)) {
        if (savedPath.startsWith(oldPath + '/')) {
          this.plugin.settings.serverShares.files.delete(savedPath)
          this.plugin.settings.serverShares.files.set(this.path + savedPath.slice(oldPath.length), saved)
        }
      }
      for (const document of SharedDocument.getAll()) {
        if (document.path.startsWith(oldPath + '/') && document.file) document.updateFileRef(document.file)
      }
      await saveSettingsNow(this.plugin.settings, this.plugin)
      const active = this._importTask
      await Promise.all(Array.from(this._pendingAdds.values()))
      await active
      if (!this._importStopped) {
        this._importFailures.clear()
        this._importConflicts.clear()
        await this.importMissingDocuments()
      }
    }
  }

  async getOrCreateFile(relativePath: string) {
    const absolutePath = path.join(this.root.path, relativePath)
    let file = this.plugin.app.vault.getAbstractFileByPath(absolutePath)
    if (file && file instanceof TFile) return file

    const folder = await SharedFolder.getOrCreatePath(path.parse(absolutePath).dir, this.plugin)
    if (!folder) {
      showNotice("Error creating shares")
      return
    }
    return await this.plugin.app.vault.create(absolutePath, '')
  }

  static async getOrCreatePath(absolutePath: string, plugin: PeerDraftPlugin): Promise<TFolder | void> {
    let folder = plugin.app.vault.getAbstractFileByPath(normalizePath(absolutePath))
    if (folder && folder instanceof TFolder) return folder
    const segments = absolutePath.split(path.sep)
    for (let index = 0; index < segments.length; index++) {
      const subPath = segments.slice(0, index + 1).join(path.sep)
      folder = plugin.app.vault.getAbstractFileByPath(normalizePath(subPath))
      if (!folder) {
        try {
          folder = await plugin.app.vault.createFolder(normalizePath(subPath))
        } catch (error) {
          // Another share may have created the same parent while this call waited.
          folder = plugin.app.vault.getAbstractFileByPath(normalizePath(subPath))
          if (!(folder instanceof TFolder)) throw error
        }
      }
    }
    return folder as TFolder
  }

  isFileInSyncObject(file: TFile) {
    const normalizedPath = normalizePath(file.path)
    for (const value of this.getDocsFragment().values()) {
      if (normalizedPath === path.join(this.root.path, value)) return true
    }
    return false
  }

  startWebRTCSync() {
    return super.startWebRTCSync((provider) => {

      const handleTimeout = () => {
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

  async startIndexedDBSync(): Promise<IndexeddbPersistence | undefined> {
    if (this._syncable.indexedDBProvider) return this._syncable.indexedDBProvider
    const id = getFolderByPath(this.path, this.plugin)?.persistenceId
    if (!id) return
    const provider = await this._syncable.startIndexedDBSync(id)
    return provider
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

        void this.startWebRTCSync()
        void this._updateStatusIndicator()
      } finally {
        release()
      }
    }

    const indexedDBHandler = (data: { wasEmpty: boolean }) => {
      if (this._checkInitializationGuard()) {
        void handleGuardConditionMet()
      }
    }
    this._syncable.on('indexedDBLoaded', indexedDBHandler)

    const serverSyncedHandler = () => {
      if (this._checkInitializationGuard()) {
        void handleGuardConditionMet()
      }
    }
    this._syncable.on('serverSynced', serverSyncedHandler)

    const syncStateChangedHandler = () => {
      if (this._checkInitializationGuard() && !this._initializationGuardPassed) {
        void handleGuardConditionMet()
      }
      void this._updateStatusIndicator()
    }
    this._syncable.on('syncStateChanged', syncStateChangedHandler)
  }

  getSyncStatus(): 'offline' | 'syncing' | 'insync' | 'warning' | 'not-initialized' {
    const wsconnected = this.plugin.serverSync.wsconnected
    const serverSyncing = this._syncable.serverSyncing
    const serverSynced = this._syncable.serverSynced
    const indexedDBWasEmpty = this._syncable.indexedDBWasEmpty

    // Build one lookup for this status pass instead of scanning every document
    // again for each child in large shares. Preserve the first registered match.
    const documents = new Map<string, SharedDocument>()
    for (const document of SharedDocument.getAll()) {
      if (!documents.has(document.shareId)) documents.set(document.shareId, document)
    }
    this._ensureChildSubscriptions(documents)
    const docsMap = this.getDocsFragment()
    let anyChildSyncing = false
    let anyChildNotSynced = false
    for (const [shareId, relativePath] of docsMap.entries()) {
      const doc = documents.get(shareId)
      if (doc) {
        const childStatus = doc.getSyncStatus()
        if (childStatus === 'syncing') {
          anyChildSyncing = true
        }
        if (childStatus !== 'insync') {
          anyChildNotSynced = true
        }
      } else {
        anyChildNotSynced = true
      }
    }

    if (!wsconnected && !serverSynced && (!this._syncable.indexedDBLoaded || indexedDBWasEmpty)) {
      return 'warning'
    }

    if (!wsconnected) {
      if (!this._initializationGuardPassed) {
        return 'not-initialized'
      }
      return 'offline'
    }

    if (!this._initializationGuardPassed) {
      return 'syncing'
    }

    if (this._importFailures.size) return 'warning'
    if (this._pendingAdds.size || serverSyncing || anyChildSyncing) {
      return 'syncing'
    }
    
    if (serverSynced && anyChildNotSynced) {
      return 'syncing'
    }


    if (serverSynced) {
      return 'insync'
    }

    return 'offline'
  }

  private async _updateStatusIndicator() {
    const status = this.getSyncStatus()
    await setStatusClass(this.path, this.plugin, status)
  }

  private _subscribedChildDocs: Set<string> = new Set()

  private _setupStatusIndicatorSubscriptions() {
    this.plugin.serverSync.on('status', () => {
      void this._updateStatusIndicator()
    })

    this._syncable.on('syncStateChanged', () => {
      void this._updateStatusIndicator()
    })
    const docsMap = this.getDocsFragment()
    docsMap.observe((event) => {
      void this._updateStatusIndicator()
    })
  }

  private _ensureChildSubscriptions(documents: ReadonlyMap<string, SharedDocument>) {
    const docsMap = this.getDocsFragment()
    for (const [shareId, relativePath] of docsMap.entries()) {
      if (!this._subscribedChildDocs.has(shareId)) {
        const doc = documents.get(shareId)
        if (doc) {
          this._subscribedChildDocs.add(shareId)
          doc.syncable.on('syncStateChanged', () => {
            void this._updateStatusIndicator()
          })
        }
      }
    }
  }

  static async stopSession(id: string, plugin: PeerDraftPlugin) {

    const text = await promptForText(plugin.app, {
      description: "This folder will not be synced with any vault anymore and can not be accessed via the Peerdraft Web Editor. Enter YES, if you really want to do this.",
      header: "Do you really want to stop sharing?",
      initial: {
        text: "NO"
      }
    })

    if (!text || text.text !=="YES") return

    try {
      await plugin.serverSync.stopSession(id)
    } catch (e) {
      if (e instanceof StopSessionError && (e.reason === 'not_permitted' || e.reason === 'internal')) {
        showNotice(e.reason === 'not_permitted'
          ? "You are not permitted to stop sharing this folder. It is still shared."
          : "The server failed to stop sharing this folder. It is still shared.")
      } else {
        showNotice("The server didn't confirm the session stop. The folder is still shared — please try again.")
      }
      return
    }
    const folder = SharedFolder.findById(id)
    if (folder) await folder.unshare()
  }

  async unshare() {
    const dbEntry = getFolderByPath(this.path, this.plugin)
    if (dbEntry) {
      void removeFolder(this.path, this.plugin)
    }

    if (this._syncable.indexedDBProvider) {
      await this._syncable.indexedDBProvider.destroy()
    }


    this.getDocsFragment().forEach((path: string, shareId: string) => {
      void SharedDocument.findById(shareId)?.unshare()
    })

    this.destroy()
    void removeIsSharedClass(this.path, this.plugin)
    await removeStatusClass(this.path, this.plugin)
  }

  destroy() {
    if (this._importStopped) return
    this._importStopped = true
    if (this._importProgressTimer) clearTimeout(this._importProgressTimer)
    this._importNotice?.hide()
    this._syncable.destroy()
    this._binaryFileSync?.destroy()
    super.destroy()
    const index = SharedFolder._sharedEntites.indexOf(this)
    if (index >= 0) SharedFolder._sharedEntites.splice(index, 1)
  }

}
