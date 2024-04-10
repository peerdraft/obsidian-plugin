import PeerDraftPlugin from 'src/main'
import { WebrtcProvider } from 'y-webrtc'
import { IndexeddbPersistence } from "y-indexeddb"
import * as Y from 'yjs'
import { WebsocketProvider } from 'src/webSocketProvider'
export abstract class SharedEntity {

  static DB_PERSISTENCE_PREFIX = "peerdraft_persistence_"

  protected yDoc: Y.Doc
  protected _shareId: string

  protected _webRTCProvider?: WebrtcProvider
  protected _webRTCTimeout: number | null = null
  private _webSocketProvider?: WebsocketProvider
  private _webSocketTimeout: number | null = null

  protected _indexedDBProvider?: IndexeddbPersistence

  protected static _sharedEntites: Array<SharedEntity>;

  protected _path: string

  get shareId() {
    return this._shareId
  }

  get path() {
    return this._path
  }

  static findByPath(path: string) {
    const docs = this._sharedEntites.filter(doc => {
      return doc.path === path
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

  constructor(protected plugin: PeerDraftPlugin) { }

  startWebRTCSync(init?: (provider: WebrtcProvider) => any) {
    this.plugin.log(`WebRTC for ${this.path}: start`)
    if (!this.shareId) return
    if (this._webRTCProvider) {
      if (!this._webRTCProvider.connected) {
        this._webRTCProvider.connect()
      }
      return this._webRTCProvider
    }
    const webRTCProcider = new WebrtcProvider(this._shareId, this.yDoc, { signaling: [this.plugin.settings.signaling], peerOpts: { iceServers: [{ urls: 'stun:freeturn.net:5349' }, { urls: 'turns:freeturn.tel:5349', username: 'free', credential: 'free' }, { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }] } })
    this._webRTCProvider = webRTCProcider
    if (init) {
      init(webRTCProcider)
    }
    return webRTCProcider
  }

  stopWebRTCSync() {
    if (!this._webRTCProvider) return
    this.plugin.log(`WebRTC for ${this.path}: stop`)
    this._webRTCProvider?.awareness.destroy()
    this._webRTCProvider?.disconnect()
    this._webRTCProvider?.destroy()
    this._webRTCProvider = undefined
  }

  async startWebSocketSync() {
    if (!this.shareId) return
    if (this._webSocketProvider) {
      if (!this._webSocketProvider.wsconnected) {
        this._webSocketProvider.connect()
      }
      return this._webSocketProvider
    }
    const webSocketProvider = new WebsocketProvider(this.plugin.settings.sync, this.shareId, this.yDoc, {
      connect: false,
      maxBackoffTime: 300000,
      resyncInterval: -1
    })
    this._webSocketProvider = webSocketProvider

    webSocketProvider.on('status', (event: any) => {
      this.plugin.log(`WebSocket for ${this.path}: ${event.status}`)
    })


    webSocketProvider.once('sync', (state) => {
      // disconnect after initial update from Server
      if (state) {
        webSocketProvider.disconnect()
      }
    })

    webSocketProvider.doc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc, tr: Y.Transaction) => {
      // connect after local changes
      if (tr.local) {
        if (!webSocketProvider.wsconnected) {
          webSocketProvider.connect()
        }
        // disconnect after 30 seconds of inactivity
        if (this._webSocketTimeout != null) {
          window.clearTimeout(this._webSocketTimeout)
        }
        this._webSocketTimeout = window.setTimeout(() => {
          webSocketProvider.disconnect()
        }, 30000)
      }
    })

    webSocketProvider.connect()
    this.plugin.activeStreamClient.add([this.shareId])
    return webSocketProvider
  }

  async stopWebSocketSync() {
    if (!this._webSocketProvider) return
    this.plugin.log(`WebSocket Sync for ${this.path}: stop`)
    this._webSocketProvider.disconnect()
    this._webSocketProvider.destroy()
    this.plugin.activeStreamClient.remove([this.shareId])
    this._webSocketProvider = undefined
  }

  async stopIndexedDBSync() {
    if (!this._indexedDBProvider) return
    await this._indexedDBProvider.destroy()
  }

  destroy() {
    this.stopWebRTCSync()
    this.stopWebSocketSync()
  }

}