import { TAbstractFile, TFile, TFolder, Vault, Notice, normalizePath, requestUrl } from 'obsidian'
import * as path from 'path-browserify'
import * as Y from 'yjs'
import { calculateFileHash } from '../utils/hashCalculation'
import { isBinaryFile, getMimeType } from '../utils/fileTypeDetection'
import PeerDraftPlugin from '../main'
import { BINARY_PRESIGN_UPLOAD, MESSAGE_MULTIPLEX_SYNC } from '../peerdraftWebSocketProvider'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { SharedFolder } from './sharedFolder'
import { generateRandomString } from '../tools'
import { showNotice } from '../ui'
import { setStatusClass, removeStatusClass } from '../workspace/explorerView'

const BINARY_FILE_SYNC_DEBOUNCE_MS = 5000

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
  private isUpdatingFromRemote = false
  private syncingFiles: Set<string> = new Set()

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

    console.log(`[BinaryFileSync] Initializing for folder: ${folder.path}, shareId: ${getFolderId()}`)
    // Listeners will be set up in initialize() to avoid processing events before ready
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
        const hash = calculateFileHash(content)
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
   * Remove status indicator for a file (e.g. when moved out of folder)
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
   * Initialize binary file sync - scan folder and sync existing files
   */
  async initialize(): Promise<void> {
    console.log(`[BinaryFileSync] initialize() starting for folder: ${this.folder.path}`)
    console.log(`[BinaryFileSync] Current binaryFilesMap entries: ${Array.from(this.binaryFilesMap.keys()).join(', ') || '(none)'}`)

    // Set up listeners now that we're ready to process events
    this.setupListeners()
    this.setupYDocObserver()

    // Scan for existing binary files
    const files = await this.getBinaryFilesInFolder(this.folder)
    console.log(`[BinaryFileSync] Found ${files.length} binary files in folder: ${files.map(f => f.name).join(', ')}`)
    
    for (const file of files) {
      const relativePath = this.getRelativePath(file)
      const metadata = this.binaryFilesMap.get(relativePath)
      console.log(`[BinaryFileSync] Checking ${relativePath} - metadata exists: ${!!metadata}`)
      
      if (!metadata) {
        // Local file not in Y.Map - upload it
        console.log(`[BinaryFileSync] Local file ${relativePath} not in Y.Map - scheduling upload`)
        await this.scheduleUpload(file)
      } else {
        // Compare hashes
        const content = await this.vault.readBinary(file)
        const hash = calculateFileHash(content)
        console.log(`[BinaryFileSync] Comparing hashes for ${relativePath}: local=${hash}, remote=${metadata.hash}, match=${hash === metadata.hash}`)
        
        if (hash !== metadata.hash) {
          // Hashes differ - Y.Doc wins (last-write-wins)
          console.log(`[BinaryFileSync] Hashes differ for ${relativePath} - downloading from remote`)
          await this.downloadFile(relativePath, metadata)
        } else {
          console.log(`[BinaryFileSync] Hashes match for ${relativePath} - no action needed`)
          await this.updateStatus(relativePath)
        }
      }
    }

    // Check for files in Y.Map that don't exist locally
    for (const [relativePath, metadata] of this.binaryFilesMap.entries()) {
      const absolutePath = this.getAbsolutePath(relativePath)
      const file = this.vault.getAbstractFileByPath(absolutePath)
      console.log(`[BinaryFileSync] Checking Y.Map entry ${relativePath} - local exists: ${!!file}`)
      if (!file) {
        // File exists in Y.Map but not locally - download it
        console.log(`[BinaryFileSync] Y.Map entry ${relativePath} missing locally - downloading`)
        await this.downloadFile(relativePath, metadata)
      } else {
        // File exists locally and in Y.Map - ensure status is correct
        await this.updateStatus(relativePath)
      }
    }

    console.log(`[BinaryFileSync] initialize() complete`)
  }

  /**
   * Setup vault file change listeners
   */
  private setupListeners(): void {
    // Handle file creation
    this.plugin.registerEvent(
      this.vault.on('create', (file) => {
        console.log(`[BinaryFileSync] vault 'create' event: ${file.path}, is TFile: ${file instanceof TFile}`)
        if (file instanceof TFile && this.isInFolder(file)) {
          console.log(`[BinaryFileSync] File in folder, isBinaryFile(${file.name}): ${isBinaryFile(file.name)}`)
          if (isBinaryFile(file.name)) {
            console.log(`[BinaryFileSync] Scheduling upload for created file: ${file.path}`)
            this.scheduleUpload(file)
          }
        }
      })
    )

    // Handle file modification
    this.plugin.registerEvent(
      this.vault.on('modify', (file) => {
        console.log(`[BinaryFileSync] vault 'modify' event: ${file.path}, is TFile: ${file instanceof TFile}`)
        if (file instanceof TFile && this.isInFolder(file)) {
          console.log(`[BinaryFileSync] File in folder, isBinaryFile(${file.name}): ${isBinaryFile(file.name)}`)
          if (isBinaryFile(file.name)) {
            console.log(`[BinaryFileSync] Scheduling upload for modified file: ${file.path}`)
            this.scheduleUpload(file)
          }
        }
      })
    )

    // Handle file rename
    this.plugin.registerEvent(
      this.vault.on('rename', (file, oldPath) => {
        console.log(`[BinaryFileSync] vault 'rename' event: ${oldPath} -> ${file.path}`)
        if (!(file instanceof TFile) || !isBinaryFile(file.name)) {
          return
        }

        const normalizedOldPath = normalizePath(oldPath)
        const normalizedFolderPath = normalizePath(this.folder.path)
        const wasInFolder = normalizedOldPath === normalizedFolderPath || normalizedOldPath.startsWith(normalizedFolderPath + '/')
        const isInFolder = this.isInFolder(file)
        console.log(`[BinaryFileSync] wasInFolder: ${wasInFolder}, isInFolder: ${isInFolder}`)

        if (wasInFolder && isInFolder) {
          // Rename within shared folder - update Y.Map path
          if (normalizedOldPath !== normalizedFolderPath) {
            const oldRelativePath = normalizedOldPath.slice(normalizedFolderPath.length + 1)
            const newRelativePath = this.getRelativePath(file)
            const metadata = this.binaryFilesMap.get(oldRelativePath)
            console.log(`[BinaryFileSync] Rename within folder: ${oldRelativePath} -> ${newRelativePath}, metadata exists: ${!!metadata}`)
            if (metadata) {
              this.yDoc.transact(() => {
                this.binaryFilesMap.delete(oldRelativePath)
                this.binaryFilesMap.set(newRelativePath, {
                  ...metadata,
                  path: newRelativePath
                })
              })
            }
          }
        } else if (!wasInFolder && isInFolder) {
          // Moved INTO shared folder - treat as new file upload
          console.log(`[BinaryFileSync] File moved INTO shared folder, scheduling upload: ${file.path}`)
          this.scheduleUpload(file)
        } else if (wasInFolder && !isInFolder) {
          // Moved OUT OF shared folder - remove from Y.Map
          if (normalizedOldPath !== normalizedFolderPath) {
            const oldRelativePath = normalizedOldPath.slice(normalizedFolderPath.length + 1)
            console.log(`[BinaryFileSync] File moved OUT of shared folder, removing: ${oldRelativePath}`)
            if (this.binaryFilesMap.has(oldRelativePath)) {
              this.yDoc.transact(() => {
                this.binaryFilesMap.delete(oldRelativePath)
              })
            }
            this.removeStatus(oldRelativePath)
          }
        }
      })
    )

  }

  /**
   * Setup Y.Doc observer for remote changes
   */
  private setupYDocObserver(): void {
    this.binaryFilesMap.observe((event) => {
      console.log(`[BinaryFileSync] Y.Map observer triggered, isUpdatingFromRemote: ${this.isUpdatingFromRemote}, changes: ${event.changes.keys.size}`)
      if (this.isUpdatingFromRemote) return

      event.changes.keys.forEach((change, key) => {
        console.log(`[BinaryFileSync] Y.Map change: ${change.action} on ${key}`)
        if (change.action === 'add' || change.action === 'update') {
          const metadata = this.binaryFilesMap.get(key)
          if (metadata) {
            const absolutePath = this.getAbsolutePath(key)
            const file = this.vault.getAbstractFileByPath(absolutePath)
            
            if (file instanceof TFile) {
              // File exists locally - check if needs update
              this.vault.readBinary(file).then((content) => {
                const hash = calculateFileHash(content)
                if (hash !== metadata.hash) {
                  this.downloadFile(key, metadata)
                }
              }).catch((error) => {
                console.error('[BinaryFileSync] Error reading file for hash comparison:', error)
              })
            } else {
              // File doesn't exist locally - download it
              this.downloadFile(key, metadata)
            }
          }
        } else if (change.action === 'delete') {
          const absolutePath = this.getAbsolutePath(key)
          this.removeStatus(key)
          const file = this.vault.getAbstractFileByPath(absolutePath)
          if (file) {
            this.vault.delete(file)
          }
        }
      })
    })
  }

  /**
   * Schedule file upload with debounce
   */
  private scheduleUpload(file: TFile): void {
    try {
      const relativePath = this.getRelativePath(file)
      console.log(`[BinaryFileSync] scheduleUpload: ${relativePath}, debounce: ${BINARY_FILE_SYNC_DEBOUNCE_MS}ms`)
      
      // Clear existing timeout
      const existingTimeout = this.uploadTimeouts.get(relativePath)
      if (existingTimeout) {
        console.log(`[BinaryFileSync] Clearing existing timeout for ${relativePath}`)
        window.clearTimeout(existingTimeout)
      }

      // Set new timeout
      const timeoutId = window.setTimeout(async () => {
        console.log(`[BinaryFileSync] Debounce fired for ${relativePath} - starting upload`)
        await this.setSyncing(relativePath, true)
        this.uploadFile(file)
        this.uploadTimeouts.delete(relativePath)
      }, BINARY_FILE_SYNC_DEBOUNCE_MS)

      this.uploadTimeouts.set(relativePath, timeoutId)
      console.log(`[BinaryFileSync] Upload scheduled for ${relativePath}, timeoutId: ${timeoutId}`)
    } catch (error) {
      console.error('[BinaryFileSync] Error scheduling upload:', error)
    }
  }

  /**
   * Upload file to object storage
   */
  private async uploadFile(file: TFile): Promise<void> {
    console.log(`[BinaryFileSync] uploadFile starting for: ${file.path}`)
    const relativePath = this.getRelativePath(file)
    try {
      // Read file content
      const content = await this.vault.readBinary(file)
      console.log(`[BinaryFileSync] Read ${content.byteLength} bytes from ${file.path}`)
      
      const hash = calculateFileHash(content)
      console.log(`[BinaryFileSync] Calculated hash for ${relativePath}: ${hash}`)

      // Check if already up to date
      const existing = this.binaryFilesMap.get(relativePath)
      if (existing && existing.hash === hash) {
        console.log(`[BinaryFileSync] File ${relativePath} already up to date, skipping upload`)
        return
      }
      console.log(`[BinaryFileSync] Existing metadata: ${existing ? `hash=${existing.hash}` : 'none'}`)

      const folderId = this.getFolderId()
      console.log(`[BinaryFileSync] Requesting presigned URL: folderId=${folderId}, path=${relativePath}, size=${file.stat.size}`)

      // Request presigned upload URL from server
      const { uploadUrl, storageKey, downloadUrl } = await this.requestPresignedUpload({
        folderId,
        relativePath,
        hash,
        size: file.stat.size,
        contentType: getMimeType(file.name)
      })
      console.log(`[BinaryFileSync] Got presigned URL, storageKey=${storageKey}, uploadUrl length=${uploadUrl?.length || 0}`)

      // Upload directly to object storage via Obsidian's requestUrl
      // (bypasses CORS by making the request from the main process)
      console.log(`[BinaryFileSync] Uploading to object storage via requestUrl...`)
      const uploadResponse = await requestUrl({
        url: uploadUrl,
        method: 'PUT',
        body: content
      })
      console.log(`[BinaryFileSync] Upload response: ${uploadResponse.status}`)

      if (uploadResponse.status >= 400) {
        throw new Error(`Upload failed: ${uploadResponse.status}`)
      }

      // Update Y.Map with metadata
      console.log(`[BinaryFileSync] Updating Y.Map for ${relativePath}`)
      this.yDoc.transact(() => {
        this.binaryFilesMap.set(relativePath, {
          path: relativePath,
          hash,
          size: file.stat.size,
          storageKey,
          downloadUrl,
          contentType: getMimeType(file.name),
          uploadedAt: Date.now()
        })
      })
      await this.setSyncing(relativePath, false)
      console.log(`[BinaryFileSync] Upload complete: ${file.name}`)
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
    this.setSyncing(relativePath, true)
    console.log(`[BinaryFileSync] downloadFile starting for: ${relativePath}, url=${metadata.downloadUrl}`)
    try {
      const absolutePath = this.getAbsolutePath(relativePath)
      
      // Download from object storage using URL provided by server
      let downloadUrl = metadata.downloadUrl
      console.log(`[BinaryFileSync] Fetching ${downloadUrl}`)
      let response: { status: number; arrayBuffer: ArrayBuffer }
      try {
        response = await requestUrl({
          url: downloadUrl,
          method: 'GET'
        })
      } catch (err) {
        const status = (err as any)?.status ?? 0
        console.log(`[BinaryFileSync] Download failed with status ${status}`)
        if (status === 400 || status === 404) {
          console.log(`[BinaryFileSync] Removing corrupted Y.Map entry for ${relativePath} - will be re-uploaded`)
          this.yDoc.transact(() => {
            this.binaryFilesMap.delete(relativePath)
          })
        }
        return
      }
      
      console.log(`[BinaryFileSync] Download response: ${response.status}`)
      if (response.status >= 400) {
        throw new Error(`Download failed: ${response.status}`)
      }

      const arrayBuffer = response.arrayBuffer
      console.log(`[BinaryFileSync] Downloaded ${arrayBuffer.byteLength} bytes`)
      this.setSyncing(relativePath, false)

      // Check if file exists locally
      const existingFile = this.vault.getAbstractFileByPath(absolutePath)
      console.log(`[BinaryFileSync] Existing file at ${absolutePath}: ${!!existingFile}`)

      // Ensure directory exists (same pattern as handleUpdate in sharedFolder.ts)
      const dir = normalizePath(path.parse(absolutePath).dir)
      if (dir && !this.vault.getAbstractFileByPath(dir)) {
        console.log(`[BinaryFileSync] Creating directory: ${dir}`)
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
      if (existingFile instanceof TFile) {
        // Update existing file
        console.log(`[BinaryFileSync] Modifying existing file: ${absolutePath}`)
        this.isUpdatingFromRemote = true
        await this.vault.modifyBinary(existingFile, fileData)
        this.isUpdatingFromRemote = false
      } else {
        // Create new file
        console.log(`[BinaryFileSync] Creating new file: ${absolutePath}`)
        this.isUpdatingFromRemote = true
        await this.vault.createBinary(absolutePath, fileData)
        this.isUpdatingFromRemote = false
      }

      console.log(`[BinaryFileSync] Download complete: ${relativePath}`)
      new Notice(`Downloaded ${relativePath}`)
    } catch (error) {
      this.isUpdatingFromRemote = false
      this.setSyncing(relativePath, false)
      console.error('[BinaryFileSync] Binary file download error:', error)
      new Notice(`Failed to download ${relativePath}: ${(error as Error).message}`)
    }
  }

  /**
   * Request presigned upload URL from server via WebSocket
   */
  private async requestPresignedUpload(request: {
    folderId: string
    relativePath: string
    hash: string
    size: number
    contentType: string
  }): Promise<{ uploadUrl: string; storageKey: string; downloadUrl: string }> {
    console.log(`[BinaryFileSync] requestPresignedUpload: folderId=${request.folderId}, path=${request.relativePath}, size=${request.size}`)
    return new Promise((resolve, reject) => {
      const ws = this.plugin.serverSync.ws
      console.log(`[BinaryFileSync] WebSocket state: ${ws ? (ws.readyState === WebSocket.OPEN ? 'OPEN' : ws.readyState) : 'null'}`)
      if (!ws) {
        reject(new Error('WebSocket not connected'))
        return
      }

      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'))
        return
      }

      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
      encoding.writeVarUint(encoder, BINARY_PRESIGN_UPLOAD)
      encoding.writeVarString(encoder, request.folderId)
      encoding.writeVarString(encoder, request.hash)
      encoding.writeVarUint(encoder, request.size)
      encoding.writeVarString(encoder, request.contentType)

      const handleResponse = (event: MessageEvent) => {
        const decoder = decoding.createDecoder(new Uint8Array(event.data))
        const messageType = decoding.readVarUint(decoder)
        
        if (messageType === MESSAGE_MULTIPLEX_SYNC) {
          const syncType = decoding.readVarUint(decoder)
          
          if (syncType === BINARY_PRESIGN_UPLOAD) {
            const status = decoding.readVarUint(decoder)
            
            ws.removeEventListener('message', handleResponse)
            
            if (status === 0) {
              // Error response
              const errorMessage = decoding.readVarString(decoder)
              reject(new Error(errorMessage || 'Upload request failed'))
            } else {
              // Success response
              const uploadUrl = decoding.readVarString(decoder)
              const storageKey = decoding.readVarString(decoder)
              const downloadUrl = decoding.readVarString(decoder)
              console.log(`[BinaryFileSync] Got presign response: uploadUrl=${uploadUrl ? 'present' : 'missing'}, storageKey=${storageKey}`)
              resolve({ uploadUrl, storageKey, downloadUrl })
            }
          }
        }
      }

      ws.addEventListener('message', handleResponse)
      ws.send(encoding.toUint8Array(encoder))
      console.log(`[BinaryFileSync] Sent BINARY_PRESIGN_UPLOAD request via WebSocket`)

      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        ws.removeEventListener('message', handleResponse)
        console.log(`[BinaryFileSync] Presign request timeout after 30s`)
        reject(new Error('Upload URL request timeout'))
      }, 30000)

      // Clean up timeout if promise resolves/rejects before timeout
      const originalResolve = resolve
      const originalReject = reject
      resolve = (...args: Parameters<typeof originalResolve>) => {
        clearTimeout(timeoutId)
        return originalResolve(...args)
      }
      reject = (...args: Parameters<typeof originalReject>) => {
        clearTimeout(timeoutId)
        return originalReject(...args)
      }
    })
  }

  /**
   * Get all binary files in a folder recursively
   */
  private async getBinaryFilesInFolder(folder: TFolder): Promise<TFile[]> {
    const files: TFile[] = []
    console.log(`[BinaryFileSync] Scanning folder: ${folder.path}, children: ${folder.children.length}`)
    
    for (const child of folder.children) {
      if (child instanceof TFile && isBinaryFile(child.name)) {
        console.log(`[BinaryFileSync] Found binary file: ${child.path}`)
        files.push(child)
      } else if (child instanceof TFolder) {
        console.log(`[BinaryFileSync] Recursing into subfolder: ${child.path}`)
        files.push(...await this.getBinaryFilesInFolder(child))
      }
    }
    
    console.log(`[BinaryFileSync] Folder scan complete for ${folder.path}: found ${files.length} binary files`)
    return files
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
    const folderPath = normalizePath(this.folder.path)
    const filePath = normalizePath(file.path)
    return filePath.slice(folderPath.length + 1)
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

    // Remove Y.Doc observer
    // (Handled by Yjs garbage collection)
  }
}
