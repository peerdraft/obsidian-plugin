import { TAbstractFile, TFile, TFolder, Vault, Notice, normalizePath, requestUrl } from 'obsidian'
import * as path from 'path-browserify'
import * as Y from 'yjs'
import { calculateFileHash } from '../utils/hashCalculation'
import { fileTypeFromBuffer } from 'file-type'
import { getMimeTypeFromExtension } from '../utils/fileTypeDetection'
import PeerDraftPlugin from '../main'
import { BINARY_PRESIGN_UPLOAD, MESSAGE_MULTIPLEX_SYNC } from '../peerdraftWebSocketProvider'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { SharedFolder } from './sharedFolder'
import { generateRandomString } from '../tools'
import { showNotice } from '../ui'
import { setStatusClass, removeStatusClass } from '../workspace/explorerView'

const BINARY_FILE_SYNC_DEBOUNCE_MS = 5000
const PRESIGN_REQUEST_TIMEOUT_MS = 30000

export interface BinaryFileMetadata {
  path: string
  hash: string
  size: number
  storageKey: string
  downloadUrl: string
  contentType: string
  uploadedAt: number
}

export class BinaryFileSync {
  private yDoc: Y.Doc
  private binaryFilesMap: Y.Map<BinaryFileMetadata>
  private folder: TFolder
  private vault: Vault
  private plugin: PeerDraftPlugin
  private getFolderId: () => string
  private uploadTimeouts: Map<string, number> = new Map()
  // Paths currently being written to disk as a result of a remote (Y.Map-driven)
  // download, keyed per-file so one in-flight download doesn't cause an
  // unrelated remote change (for a different file) to be ignored, and so
  // peerdraftPlugin.ts can skip re-processing the vault event that write
  // itself produces.
  private remoteUpdatingPaths: Set<string> = new Set()
  private unsharingPaths: Set<string> = new Set()
  private syncingFiles: Set<string> = new Set()
  // Serializes presign requests: the WebSocket response for BINARY_PRESIGN_UPLOAD
  // carries no request id, so at most one request may be in flight at a time or
  // a concurrent second request's response could be mistaken for the first's.
  private presignQueue: Promise<void> = Promise.resolve()
  private yDocObserver?: (event: Y.YMapEvent<BinaryFileMetadata>) => void

  constructor(
    yDoc: Y.Doc,
    folder: TFolder,
    plugin: PeerDraftPlugin,
    getFolderId: () => string
  ) {
    this.yDoc = yDoc
    this.folder = folder
    this.vault = plugin.app.vault
    this.plugin = plugin
    this.getFolderId = getFolderId
    this.binaryFilesMap = yDoc.getMap('binaryFiles')
    // Y.Doc observer is set up in initialize() to avoid processing events before ready
  }

  /**
   * Update status indicator for a binary file in the file explorer
   */
  private async updateStatus(relativePath: string): Promise<void> {
    try {
      const absolutePath = this.getAbsolutePath(relativePath)
      const metadata = this.binaryFilesMap.get(relativePath)
      const file = this.vault.getAbstractFileByPath(absolutePath)

      if (!file) {
        // File doesn't exist locally, remove status
        await removeStatusClass(absolutePath, this.plugin)
        return
      }

      if (this.syncingFiles.has(relativePath)) {
        await setStatusClass(absolutePath, this.plugin, 'syncing')
        return
      }

      if (metadata) {
        const content = await this.vault.readBinary(file as TFile)
        const hash = await calculateFileHash(content)
        if (hash === metadata.hash) {
          await setStatusClass(absolutePath, this.plugin, 'insync')
        } else {
          await setStatusClass(absolutePath, this.plugin, 'warning')
        }
      } else {
        // Local file not in Y.Map
        await setStatusClass(absolutePath, this.plugin, 'warning')
      }
    } catch (error) {
      console.error('[BinaryFileSync] Error updating status:', error)
    }
  }

  /**
   * Mark a file as currently syncing
   */
  private async setSyncing(relativePath: string, isSyncing: boolean): Promise<void> {
    if (isSyncing) {
      this.syncingFiles.add(relativePath)
    } else {
      this.syncingFiles.delete(relativePath)
    }
    await this.updateStatus(relativePath)
  }

  /**
   * Remove status indicator for a file (e.g. when deleted remotely)
   */
  private async removeStatus(relativePath: string): Promise<void> {
    try {
      const absolutePath = this.getAbsolutePath(relativePath)
      this.syncingFiles.delete(relativePath)
      await removeStatusClass(absolutePath, this.plugin)
    } catch (error) {
      console.error('[BinaryFileSync] Error removing status:', error)
    }
  }

  /**
   * Initialize binary file sync - sets up the Y.Doc observer and syncs
   * files already tracked in Y.Map (from previous sessions or remote
   * peers). New local files are handled by peerdraftPlugin's create event
   * handler, not scanned here.
   */
  async initialize(): Promise<void> {
    this.setupYDocObserver()

    for (const [relativePath, metadata] of this.binaryFilesMap.entries()) {
      const absolutePath = this.getAbsolutePath(relativePath)
      const file = this.vault.getAbstractFileByPath(absolutePath)
      if (!file) {
        // File exists in Y.Map but not locally - download it
        await this.downloadFile(relativePath, metadata)
      } else if (file instanceof TFile) {
        // File exists locally and in Y.Map - compare hashes
        const content = await this.vault.readBinary(file)
        const hash = await calculateFileHash(content)
        if (hash !== metadata.hash) {
          await this.downloadFile(relativePath, metadata)
        } else {
          await this.updateStatus(relativePath)
        }
      }
    }
  }

  /**
   * PUBLIC API: Check if a file is tracked (in binaryFilesMap or currently syncing)
   */
  public isFileTracked(relativePath: string): boolean {
    return this.binaryFilesMap.has(relativePath) || this.syncingFiles.has(relativePath)
  }

  /**
   * PUBLIC API: Whether relativePath is currently being written to disk as
   * the result of a remote download - lets callers (peerdraftPlugin.ts)
   * skip re-processing the vault event that write itself produces instead
   * of paying for a content read + MIME sniff only to be told nothing
   * changed.
   */
  public isRemoteUpdateInProgress(relativePath: string): boolean {
    return this.remoteUpdatingPaths.has(relativePath)
  }

  /**
   * Stops sharing a file without touching it on disk. Removing the map entry makes every other
   * client delete its copy, which is what unsharing a file from a shared folder means.
   * @returns true if the file was shared
   */
  public unshareFile(relativePath: string): boolean {
    const wasShared = this.binaryFilesMap.has(relativePath)

    const pendingUpload = this.uploadTimeouts.get(relativePath)
    if (pendingUpload) {
      window.clearTimeout(pendingUpload)
      this.uploadTimeouts.delete(relativePath)
    }

    if (wasShared) {
      // The observer deletes the local file when an entry disappears, so it must skip this one
      this.unsharingPaths.add(relativePath)
      try {
        this.yDoc.transact(() => {
          this.binaryFilesMap.delete(relativePath)
        })
      } finally {
        this.unsharingPaths.delete(relativePath)
      }
    }

    void this.removeStatus(relativePath)
    return wasShared
  }

  /** True when a text document, not a binary attachment, now owns this path. */
  private isOwnedByTextDocument(relativePath: string): boolean {
    const normalizedPath = normalizePath(relativePath)
    for (const documentPath of this.yDoc.getMap<string>('documents').values()) {
      if (normalizePath(documentPath) === normalizedPath) return true
    }
    return false
  }

  /**
   * PUBLIC API: Handle a binary file that was created or modified
   * Called by peerdraftPlugin after determining file is binary
   */
  public async handleBinaryFile(file: TFile): Promise<void> {
    if (!this.isInFolder(file)) return

    const relativePath = this.getRelativePath(file)
    if (this.remoteUpdatingPaths.has(relativePath)) {
      // This write was caused by our own downloadFile(), not a local edit
      return
    }

    const metadata = this.binaryFilesMap.get(relativePath)

    if (metadata) {
      // File already tracked - check if hash changed
      const content = await this.vault.readBinary(file)
      const hash = await calculateFileHash(content)
      if (hash !== metadata.hash) {
        this.scheduleUpload(file)
      } else {
        await this.updateStatus(relativePath)
      }
    } else {
      // New binary file - schedule upload
      this.scheduleUpload(file)
    }
  }

  /**
   * PUBLIC API: Handle a binary file rename/move
   * Called by peerdraftPlugin after determining file is binary
   */
  public handleBinaryFileRename(file: TFile, oldPath: string): void {
    const normalizedOldPath = normalizePath(oldPath)
    const normalizedFolderPath = normalizePath(this.folder.path)
    const wasInFolder = normalizedOldPath === normalizedFolderPath || normalizedOldPath.startsWith(normalizedFolderPath + '/')
    const isInFolder = this.isInFolder(file)

    if (normalizedOldPath === normalizedFolderPath) {
      // The shared folder itself was renamed, not a file within it
      return
    }

    if (wasInFolder && isInFolder) {
      // Rename within folder - update Y.Map path
      const oldRelativePath = this.relativePathFromAbsolute(normalizedOldPath)
      const newRelativePath = this.getRelativePath(file)
      const metadata = this.binaryFilesMap.get(oldRelativePath)
      if (metadata) {
        this.yDoc.transact(() => {
          this.binaryFilesMap.delete(oldRelativePath)
          this.binaryFilesMap.set(newRelativePath, {
            ...metadata,
            path: newRelativePath
          })
        })
      }
    } else if (wasInFolder && !isInFolder) {
      // Moved out of folder - remove from Y.Map and cancel pending uploads
      const oldRelativePath = this.relativePathFromAbsolute(normalizedOldPath)
      if (this.binaryFilesMap.has(oldRelativePath)) {
        this.yDoc.transact(() => {
          this.binaryFilesMap.delete(oldRelativePath)
        })
      }
      // Cancel pending upload if any
      const existingTimeout = this.uploadTimeouts.get(oldRelativePath)
      if (existingTimeout) {
        window.clearTimeout(existingTimeout)
        this.uploadTimeouts.delete(oldRelativePath)
      }
      // Use file.path (new path) because Obsidian re-keys fileItems to the new path after rename
      void removeStatusClass(file.path, this.plugin)
      this.syncingFiles.delete(oldRelativePath)
    } else if (!wasInFolder && isInFolder) {
      // Moved into folder - schedule upload
      this.scheduleUpload(file)
    }
  }

  /**
   * Setup Y.Doc observer for remote changes
   */
  private setupYDocObserver(): void {
    this.yDocObserver = (event) => {
      event.changes.keys.forEach((change, key) => {
        if (this.remoteUpdatingPaths.has(key) || this.unsharingPaths.has(key)) return

        if (change.action === 'add' || change.action === 'update') {
          const metadata = this.binaryFilesMap.get(key)
          if (metadata) {
            const absolutePath = this.getAbsolutePath(key)
            const file = this.vault.getAbstractFileByPath(absolutePath)

            if (file instanceof TFile) {
              // File exists locally - check if needs update
              this.vault.readBinary(file).then(async (content) => {
                const hash = await calculateFileHash(content)
                if (hash !== metadata.hash) {
                  void this.downloadFile(key, metadata)
                } else {
                  // Hashes match - update status to show in sync
                  void this.updateStatus(key)
                }
              }).catch((error) => {
                console.error('[BinaryFileSync] Error reading file for hash comparison:', error)
              })
            } else {
              // File doesn't exist locally - download it
              void this.downloadFile(key, metadata)
            }
          }
        } else if (change.action === 'delete') {
          const absolutePath = this.getAbsolutePath(key)
          void this.removeStatus(key)
          // A file that moved to a text document is still shared, so its copy must stay
          if (this.isOwnedByTextDocument(key)) return
          const file = this.vault.getAbstractFileByPath(absolutePath)
          if (file) {
            void this.vault.delete(file)
          }
        }
      })
    }
    this.binaryFilesMap.observe(this.yDocObserver)
  }

  /**
   * Schedule file upload with debounce
   */
  private scheduleUpload(file: TFile): void {
    try {
      const relativePath = this.getRelativePath(file)

      // Show syncing status immediately - don't wait for debounce
      void this.setSyncing(relativePath, true)

      // Clear existing timeout
      const existingTimeout = this.uploadTimeouts.get(relativePath)
      if (existingTimeout) {
        window.clearTimeout(existingTimeout)
      }

      // Set new timeout
      const timeoutId = window.setTimeout(() => {
        this.uploadTimeouts.delete(relativePath)
        void this.uploadFile(file, relativePath)
      }, BINARY_FILE_SYNC_DEBOUNCE_MS)

      this.uploadTimeouts.set(relativePath, timeoutId)
    } catch (error) {
      console.error('[BinaryFileSync] Error scheduling upload:', error)
    }
  }

  /**
   * Upload file to object storage
   */
  private async uploadFile(file: TFile, relativePath: string): Promise<void> {
    try {
      // Read file content
      const content = await this.vault.readBinary(file)
      const hash = await calculateFileHash(content)

      // Check if already up to date
      const existing = this.binaryFilesMap.get(relativePath)
      if (existing && existing.hash === hash) {
        return
      }

      const folderId = this.getFolderId()

      // Detect MIME type from file content using magic bytes
      const fileTypeResult = await fileTypeFromBuffer(content)
      const contentType = fileTypeResult?.mime || getMimeTypeFromExtension(file.name)

      // Request presigned upload URL from server
      const { uploadUrl, storageKey, downloadUrl } = await this.requestPresignedUpload({
        folderId,
        relativePath,
        hash,
        size: file.stat.size,
        contentType
      })

      // Upload directly to object storage via Obsidian's requestUrl
      // (bypasses CORS by making the request from the main process)
      const uploadResponse = await requestUrl({
        url: uploadUrl,
        method: 'PUT',
        body: content
      })

      if (uploadResponse.status >= 400) {
        throw new Error(`Upload failed: ${uploadResponse.status}`)
      }

      // Update Y.Map with metadata
      this.yDoc.transact(() => {
        this.binaryFilesMap.set(relativePath, {
          path: relativePath,
          hash,
          size: file.stat.size,
          storageKey,
          downloadUrl,
          contentType,
          uploadedAt: Date.now()
        })
      })
      await this.setSyncing(relativePath, false)
      new Notice(`Uploaded ${file.name}`)
    } catch (error) {
      await this.setSyncing(relativePath, false)
      console.error('[BinaryFileSync] Binary file upload error:', error)
      new Notice(`Failed to upload ${file.name}: ${(error as Error).message}`)
    }
  }

  /**
   * Download file from object storage
   */
  private async downloadFile(
    relativePath: string,
    metadata: BinaryFileMetadata
  ): Promise<void> {
    void this.setSyncing(relativePath, true)
    try {
      const absolutePath = this.getAbsolutePath(relativePath)

      // Download from object storage using URL provided by server
      const downloadUrl = metadata.downloadUrl
      let response: { status: number; arrayBuffer: ArrayBuffer }
      try {
        response = await requestUrl({
          url: downloadUrl,
          method: 'GET'
        })
      } catch (err) {
        const status = (err as any)?.status ?? 0
        if (status === 400 || status === 404) {
          // Stale/corrupted Y.Map entry - drop it so the file gets re-uploaded
          this.yDoc.transact(() => {
            this.binaryFilesMap.delete(relativePath)
          })
        }
        return
      }

      if (response.status >= 400) {
        throw new Error(`Download failed: ${response.status}`)
      }

      const arrayBuffer = response.arrayBuffer
      void this.setSyncing(relativePath, false)

      // Check if file exists locally
      const existingFile = this.vault.getAbstractFileByPath(absolutePath)

      // Ensure directory exists (same pattern as handleUpdate in sharedFolder.ts)
      const dir = normalizePath(path.parse(absolutePath).dir)
      if (dir && !this.vault.getAbstractFileByPath(dir)) {
        await SharedFolder.getOrCreatePath(dir, this.plugin)
      }

      // Check for collisions (same pattern as handleUpdate)
      const collision = this.vault.getAbstractFileByPath(absolutePath)
      if (collision && collision !== existingFile) {
        // File exists but is not the expected file - rename
        showNotice(`File ${relativePath} already exists. Renaming local file.`)
        const alteredPath = path.join(
          path.dirname(relativePath),
          path.basename(relativePath, path.extname(relativePath)) + "_" + generateRandomString() + path.extname(relativePath)
        )
        const alteredAbsolutePath = normalizePath(path.join(this.folder.path, alteredPath))
        await this.plugin.app.fileManager.renameFile(collision, alteredAbsolutePath)
      }

      const fileData = new Uint8Array(arrayBuffer).buffer
      this.remoteUpdatingPaths.add(relativePath)
      try {
        if (existingFile instanceof TFile) {
          await this.vault.modifyBinary(existingFile, fileData)
        } else {
          await this.vault.createBinary(absolutePath, fileData)
        }
      } finally {
        this.remoteUpdatingPaths.delete(relativePath)
      }

      new Notice(`Downloaded ${relativePath}`)
    } catch (error) {
      this.remoteUpdatingPaths.delete(relativePath)
      void this.setSyncing(relativePath, false)
      console.error('[BinaryFileSync] Binary file download error:', error)
      new Notice(`Failed to download ${relativePath}: ${(error as Error).message}`)
    }
  }

  /**
   * Request a presigned upload URL from the server via WebSocket. Requests
   * are serialized (see presignQueue) because the response carries no
   * request id, so at most one may be in flight at a time.
   */
  private requestPresignedUpload(request: {
    folderId: string
    relativePath: string
    hash: string
    size: number
    contentType: string
  }): Promise<{ uploadUrl: string; storageKey: string; downloadUrl: string }> {
    const run = () => this.sendPresignRequest(request)
    const result = this.presignQueue.then(run, run)
    // Keep the queue moving regardless of whether this request succeeded
    this.presignQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private sendPresignRequest(request: {
    folderId: string
    relativePath: string
    hash: string
    size: number
    contentType: string
  }): Promise<{ uploadUrl: string; storageKey: string; downloadUrl: string }> {
    const ws = this.plugin.serverSync.ws
    if (!ws) {
      return Promise.reject(new Error('WebSocket not connected'))
    }
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not open'))
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeoutId)
        ws.removeEventListener('message', handleResponse)
      }

      const handleResponse = (event: MessageEvent) => {
        const decoder = decoding.createDecoder(new Uint8Array(event.data))
        const messageType = decoding.readVarUint(decoder)
        if (messageType !== MESSAGE_MULTIPLEX_SYNC) return

        const syncType = decoding.readVarUint(decoder)
        if (syncType !== BINARY_PRESIGN_UPLOAD) return

        cleanup()
        const status = decoding.readVarUint(decoder)
        if (status === 0) {
          const errorMessage = decoding.readVarString(decoder)
          reject(new Error(errorMessage || 'Upload request failed'))
        } else {
          resolve({
            uploadUrl: decoding.readVarString(decoder),
            storageKey: decoding.readVarString(decoder),
            downloadUrl: decoding.readVarString(decoder)
          })
        }
      }

      ws.addEventListener('message', handleResponse)

      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
      encoding.writeVarUint(encoder, BINARY_PRESIGN_UPLOAD)
      encoding.writeVarString(encoder, request.folderId)
      encoding.writeVarString(encoder, request.hash)
      encoding.writeVarUint(encoder, request.size)
      encoding.writeVarString(encoder, request.contentType)
      ws.send(encoding.toUint8Array(encoder))

      const timeoutId = window.setTimeout(() => {
        cleanup()
        reject(new Error('Upload URL request timeout'))
      }, PRESIGN_REQUEST_TIMEOUT_MS)
    })
  }

  /**
   * Check if a file is within the shared folder
   */
  private isInFolder(file: TAbstractFile): boolean {
    const folderPath = normalizePath(this.folder.path)
    const filePath = normalizePath(file.path)
    return filePath === folderPath || filePath.startsWith(folderPath + '/')
  }

  /**
   * Get relative path from shared folder root
   */
  private getRelativePath(file: TAbstractFile): string {
    return this.relativePathFromAbsolute(file.path)
  }

  /**
   * Derive a path relative to the shared folder root from an absolute vault
   * path (shared by getRelativePath and the rename handler, which only has
   * the old path as a string, not a TAbstractFile).
   */
  private relativePathFromAbsolute(absolutePath: string): string {
    const folderPath = normalizePath(this.folder.path)
    const normalizedPath = normalizePath(absolutePath)
    return normalizedPath.slice(folderPath.length + 1)
  }

  /**
   * Get absolute path from relative path
   */
  private getAbsolutePath(relativePath: string): string {
    return normalizePath(path.join(this.folder.path, relativePath))
  }

  /**
   * Stop binary file sync - clean up listeners and timeouts
   */
  destroy(): void {
    // Clear all upload timeouts
    this.uploadTimeouts.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })
    this.uploadTimeouts.clear()

    // The Y.Doc outlives this instance (SharedFolder doesn't destroy it on
    // teardown), so the observer must be removed explicitly or it keeps
    // firing - and keeps this whole instance alive - after this folder is
    // unshared.
    if (this.yDocObserver) {
      this.binaryFilesMap.unobserve(this.yDocObserver)
      this.yDocObserver = undefined
    }
  }
}
