import PeerDraftPlugin from 'src/main'
import { WebrtcProvider } from 'y-webrtc'
import { IndexeddbPersistence } from "y-indexeddb"
import * as Y from 'yjs'
import { createRandomId } from 'src/tools'
import { normalizePath } from 'obsidian'
export abstract class SharedEntity {

  static DB_PERSISTENCE_PREFIX = "peerdraft_persistence_"

  yDoc: Y.Doc
  protected _shareId: string

  protected _webRTCProvider?: WebrtcProvider
  protected _webRTCTimeout: number | null = null

  protected _indexedDBProvider?: IndexeddbPersistence

  protected static _sharedEntites: Array<SharedEntity>;

  protected _path: string

  get shareId() {
    return this._shareId
  }

  get path() {
    return this._path
  }

  get indexedDBProvider() {
    return this._indexedDBProvider
  }

  get webRTCProvider(){
    return this._webRTCProvider
  }

  static findByPath(path: string) {
    const normalizedPath = normalizePath(path)
    const docs = this._sharedEntites.filter(doc => {
      return doc.path === normalizedPath
    })
    if (docs.length >= 1) {
      return docs[0]
    } else {
      return
    }
  }

  static findById(id: string) {
    const docs = this._sharedEntites.filter(doc => {
      return doc.shareId === id
    })
    if (docs.length >= 1) {
      return docs[0]
    } else {
      return
    }
  }

  static getAll() {
    return Object.assign([], this._sharedEntites) as Array<SharedEntity>
  }

  constructor(public plugin: PeerDraftPlugin) {}
  
  /**
   * Initialize the Y.Doc with default values
   * Should be called by subclasses after the Y.Doc is created
   */
  protected initializeYDoc() {
    // Base implementation does nothing
    // Subclasses should override this to initialize their Y.Doc
  }

  abstract calculateHash (): string

  initServerYDoc(folderKey?: string) {
    return new Promise<string>(resolve => {
      const tempId = createRandomId()
      const handler = (serverTempId: string, id: string, checksum: string) => {
        if (serverTempId === tempId) {
          this.plugin.serverSync.off('new-doc-confirmed', handler)
          this._shareId = id
          resolve(checksum)
        }
      }
      this.plugin.serverSync.on('new-doc-confirmed', handler)
      this.plugin.serverSync.sendNewDocument(this, tempId, folderKey)
    })
  }

  syncWithServer() {
    return new Promise<string>(resolve => {
      const handler = async (id: string, hash: string) => {
        if (id === this.shareId) {
          this.plugin.serverSync.off('synced', handler)
          this.plugin.log("synced " + this.path)
          resolve(hash)
        }
      }
      this.plugin.serverSync.on('synced', handler)
      
      this.plugin.serverSync.sendSyncStep1(this)
      this.plugin.log("syncing " + this.path)
    })
  }


  startWebRTCSync(init?: (provider: WebrtcProvider) => any) {
    this.plugin.log(`WebRTC for ${this.path}: start`)
    if (!this.shareId) return
    if (this._webRTCProvider) {
      this._webRTCProvider.connect()
      return this._webRTCProvider
    }
    const webRTCProvider = new WebrtcProvider(this._shareId, this.yDoc, { signaling: [this.plugin.settings.signaling], peerOpts: { iceServers: [{ urls: 'stun:freeturn.net:5349' }, { urls: 'turns:freeturn.net:5349', username: 'free', credential: 'free' }, { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }] } })
    this._webRTCProvider = webRTCProvider
    if (init) {
      init(webRTCProvider)
    }
    return webRTCProvider
  }

  stopWebRTCSync() {
    if (!this._webRTCProvider) return
    this.plugin.log(`WebRTC for ${this.path}: stop`)
    this._webRTCProvider?.awareness.destroy()
    this._webRTCProvider?.disconnect()
    this._webRTCProvider?.destroy()
    this._webRTCProvider = undefined
  }

  async stopIndexedDBSync() {
    if (!this._indexedDBProvider) return
    await this._indexedDBProvider.destroy()
  }

  destroy() {
    this.stopWebRTCSync()
  }

}