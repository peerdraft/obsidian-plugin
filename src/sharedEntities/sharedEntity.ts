import PeerDraftPlugin from 'src/main'
import { WebrtcProvider } from 'y-webrtc'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { SharedDocument } from './sharedDocument'

export abstract class SharedEntity {

  protected yDoc: Y.Doc
  protected _shareId: string

  protected _webRTCProvider?: WebrtcProvider
  private _webSocketProvider?: WebsocketProvider

  protected _path: string

  static async fromShareURL(url: string, plugin: PeerDraftPlugin): Promise<SharedEntity | void> {
    const splittedUrl = url.split('/')
    if (!splittedUrl?.contains('cm')) return

    // we assume a p2p doc now


    return SharedDocument.fromShareURL(url, plugin)



    // TODO: Call backend API if id is permanent doc or dir
    // if found: act accordingly

    // if not: Must be p2p doc... mh...
    // OR: build doc/dir into the path
    // cm --> doc
    // dir --> dir
    // ???
    // TODO: try to sync. Wait X seconds.
    
    // If received something -> check if doc or or dir

    // Create from URL



    // create thing

  }

  get shareId() {
    return this._shareId
  }

  get path() {
    return this._path
  }

  constructor(protected plugin: PeerDraftPlugin) { }

  startWebRTCSync(init?: (provider: WebrtcProvider) => any) {
    if (this._webRTCProvider) return this._webRTCProvider
    const webRTCProcider = new WebrtcProvider(this._shareId, this.yDoc, { signaling: [this.plugin.settings.signaling], peerOpts: { iceServers: [ { urls: 'stun:freeturn.net:5349' }, { urls: 'turns:freeturn.tel:5349', username: 'free', credential: 'free' }, { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478?transport=udp' } ]} })
    this._webRTCProvider = webRTCProcider
    if(init) {
      init(webRTCProcider)
    }
    return webRTCProcider
  }

  stopWebRTCSync() {
    if (!this._webRTCProvider) return
    this._webRTCProvider?.awareness.destroy()
    this._webRTCProvider?.disconnect()
    this._webRTCProvider?.destroy()
    this._webRTCProvider = undefined
  }

  async startWebSocketSync() {
    if (!this.shareId) return
    if (this._webSocketProvider) return this._webSocketProvider
    const webSocketProvider = new WebsocketProvider(this.plugin.settings.sync, this.shareId, this.yDoc)
    this._webSocketProvider = webSocketProvider
    webSocketProvider.on('status', (event: any) => {
      console.log(event.status) // logs "connected" or "disconnected"
    })
    return webSocketProvider
  }

  async stopWebSocketSync() {
    if (!this._webSocketProvider) return
    this._webSocketProvider.disconnect()
    this._webSocketProvider.destroy()
    this._webSocketProvider = undefined
  }
  
}