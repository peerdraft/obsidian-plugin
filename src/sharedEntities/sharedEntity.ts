import PeerDraftPlugin from 'src/main'
import { WebrtcProvider } from 'y-webrtc'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

export abstract class SharedEntity {

  protected yDoc: Y.Doc
  protected _shareId: string

  protected _webRTCProvider?: WebrtcProvider
  protected _webRTCTimeout: number | null = null
  private _webSocketProvider?: WebsocketProvider
  private _webSocketTimeout: number | null = null

  protected static _sharedEntites: Array<SharedEntity> = new Array<SharedEntity>()

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
    if (!this.shareId) return
    if (this._webRTCProvider) {
      if (!this._webRTCProvider.connected) {
        this._webRTCProvider.connect()
      }
      return this._webRTCProvider
    }
    console.log(`WebRTC for ${this.path}: start`)
    const webRTCProcider = new WebrtcProvider(this._shareId, this.yDoc, { signaling: [this.plugin.settings.signaling], peerOpts: { iceServers: [{ urls: 'stun:freeturn.net:5349' }, { urls: 'turns:freeturn.tel:5349', username: 'free', credential: 'free' }, { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }] } })
    this._webRTCProvider = webRTCProcider
    if (init) {
      init(webRTCProcider)
    }
    return webRTCProcider
  }

  stopWebRTCSync() {
    if (!this._webRTCProvider) return
    console.log(`WebRTC for ${this.path}: stop`)
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
      connect: false
    })
    this._webSocketProvider = webSocketProvider
    
    webSocketProvider.on('status', (event: any) => {
      console.log(`WebSocket for ${this.path}: ${event.status}`)
    })

    webSocketProvider.doc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc, tr: Y.Transaction) => {
      // disconnect after initial sync
      if (origin === webSocketProvider) {
        webSocketProvider.disconnect()
        return
      }

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
    console.log(`WebSocket Sync for ${this.path}: stop` )
    this._webSocketProvider.disconnect()
    this._webSocketProvider.destroy()
    this._webSocketProvider = undefined
  }

  destroy() {
    this.stopWebRTCSync()
    this.stopWebSocketSync()
  }

}