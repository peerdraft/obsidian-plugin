import * as Y from 'yjs'
import * as time from 'lib0/time'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { ObservableV2 } from 'lib0/observable'
import * as math from 'lib0/math'
import { SharedDocument } from './sharedEntities/sharedDocument'
import { SharedEntity } from './sharedEntities/sharedEntity'
import { SharedFolder } from './sharedEntities/sharedFolder'
import { calculateHash, serialize } from './tools'

export const MESSAGE_SYNC = 0
export const MESSAGE_QUERY_AWARENESS = 3
export const MESSAGE_AWARENESS = 1
export const MESSAGE_AUTH = 2


export const MESSAGE_MULTIPLEX_SYNC = 4

export const SYNC_STEP_1 = 0
export const SYNC_STEP_2 = 1
export const UPDATE = 3
export const NEW_DOCUMENT = 4
export const NEW_DOCUMENT_CONFIRMED = 5
export const GET_DOCUMENT_AS_UPDATE = 6
export const SEND_DOCUMENT_AS_UPDATE = 7

export const MESSAGE_AUTHENTICATION_REQUEST = 5
export const MESSAGE_AUTHENTICATION_RESPONSE = 6

const messageReconnectTimeout = 30000



const setupWS = (provider: PeerdraftWebsocketProvider) => {
  if (provider.shouldConnect && provider.ws === null) {
    const websocket = new WebSocket(provider.url)
    websocket.binaryType = 'arraybuffer'
    provider.ws = websocket
    provider.wsconnecting = true
    provider.wsconnected = false

    websocket.onmessage = (event) => {
      provider.wsLastMessageReceived = time.getUnixTime()
      const data = new Uint8Array(event.data)
      if (data.length == 0) return
      const decoder = decoding.createDecoder(data)
      const messageType = decoding.readVarUint(decoder)
      if (messageType === MESSAGE_MULTIPLEX_SYNC) {
        const syncMessageType = decoding.readVarUint(decoder)
        switch (syncMessageType) {
          case NEW_DOCUMENT_CONFIRMED:
            {
              const tempId = decoding.readVarString(decoder)
              const id = decoding.readVarString(decoder)
              const checksum = decoding.readVarString(decoder)
              provider.emit('new-doc-confirmed', [tempId, id, checksum])
            }
            break;
          case SYNC_STEP_1: {
            const id = decoding.readVarString(decoder)
            const vector = decoding.readVarUint8Array(decoder)
            const hash = decoding.readVarString(decoder)
            const doc = SharedDocument.findById(id) ?? SharedFolder.findById(id)
            if (doc && hash != doc.calculateHash()) {
              provider.sendSyncStep2(doc, vector)
            }
          } break;
          case SYNC_STEP_2: {
            const id = decoding.readVarString(decoder)
            const update = decoding.readVarUint8Array(decoder)
            const hash = decoding.readVarString(decoder)
            const doc = SharedDocument.findById(id) ?? SharedFolder.findById(id)
            if (doc) {
              Y.applyUpdate(doc.yDoc, update, provider)
              provider.emit('synced', [id, hash])
            }
          }
            break;
          case SEND_DOCUMENT_AS_UPDATE: {
            const id = decoding.readVarString(decoder)
            const update = decoding.readVarUint8Array(decoder)
            const checksum = decoding.readVarString(decoder)
            provider.emit("document-received", [id, update, checksum])
          } break;
          default:
            console.log("unreachable")
            break;
        }
      }
      else if (messageType === MESSAGE_AUTHENTICATION_RESPONSE) {
        const data = JSON.parse(decoding.readVarString(decoder))
        provider.authenticated = true
        provider.emit('authenticated', [data])
      }
    }

    websocket.onerror = (event) => {
      provider.emit('connection-error', [event, provider])
    }

    websocket.onclose = (event) => {
      provider.emit('connection-close', [event, provider])
      if (provider.authenticated) {
        provider.authenticated = false
      }
      provider.ws = null
      provider.wsconnecting = false
      if (provider.wsconnected) {
        provider.wsconnected = false
        provider.emit('status', [{
          status: 'disconnected'
        }])
      } else {
        provider.wsUnsuccessfulReconnects++
      }
      setTimeout(
        setupWS,
        math.min(
          math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
          provider.maxBackoffTime
        ),
        provider
      )
    }

    websocket.onopen = async () => {
      provider.wsLastMessageReceived = time.getUnixTime()
      provider.wsconnecting = false
      provider.wsconnected = true
      provider.wsUnsuccessfulReconnects = 0
      provider.emit('status', [{
        status: 'connected'
      }])

      if (provider.jwt) {
        provider.authenticate(provider.jwt)
      }

      for (const folder of SharedFolder.getAll()) {
        if (folder.indexedDBProvider) {
          if (!folder.indexedDBProvider.synced) await folder.indexedDBProvider.whenSynced
          folder.syncWithServer()
        }
      }

      for (const doc of SharedDocument.getAll()) {
        if (doc.isPermanent && doc.indexedDBProvider) {
          if (!doc.indexedDBProvider.synced) await doc.indexedDBProvider.whenSynced
          doc.syncWithServer()
        }
      }

    }

    provider.emit('status', [{
      status: 'connecting'
    }])
  }
}

interface AuthResponseData {
  plan: {
    type: "hobby" | "professional" | "team"
  }
}

type Events = {
  synced: (id: string, hash: string) => void
  // sync: (state: boolean) => void
  "connection-error": (event: Event, provider: PeerdraftWebsocketProvider) => void
  "connection-close": (event: Event, provider: PeerdraftWebsocketProvider) => void
  status: (status: { status: string }) => void
  'document-received': (id: string, update: Uint8Array, checksum: string) => void
  // 'sync-confirmed': (id: string, checksum: string) => void
  'new-doc-confirmed': (tempId: string, id: string, checksum: string) => void
  // 'my-update-sent': (id: string, update: Uint8Array, checksum: string) => void
  // 'other-document-received-if-checksum-differs': (id: string, myChecksum: string, yourChecksum: string, update?: Uint8Array) => void
  'authenticated': (data: AuthResponseData) => void
}

export class PeerdraftWebsocketProvider extends ObservableV2<Events> {

  params?: { [s: string]: string };
  WebSocketPolyfill?: typeof WebSocket;
  resyncInterval?: number;
  maxBackoffTime: number;
  url: string
  wsconnected: boolean
  wsconnecting: boolean
  wsUnsuccessfulReconnects: number
  _synced: boolean
  ws: WebSocket | null
  wsLastMessageReceived: number
  shouldConnect: boolean
  _resyncInterval: number
  _updateHandler: (update: Uint8Array, origin: any) => void
  _awarenessUpdateHandler: ({ added, updated, removed }: any, _origin: any) => void
  _exitHandler: () => void
  _checkInterval: number
  authenticated: boolean
  jwt: string | undefined

  constructor(serverUrl: string, {
    connect = true,
    resyncInterval = -1,
    maxBackoffTime = 2500,
    jwt = undefined
  }: { jwt?: string, connect?: boolean; params?: { [s: string]: string }; WebSocketPolyfill?: typeof WebSocket; resyncInterval?: number; maxBackoffTime?: number; disableBc?: boolean } = {}) {
    super()
    this.url = serverUrl
    this.maxBackoffTime = maxBackoffTime
    this.wsconnected = false
    this.wsconnecting = false
    this._resyncInterval = resyncInterval
    this.wsUnsuccessfulReconnects = 0
    this._synced = false
    this.ws = null
    this.wsLastMessageReceived = 0
    this.shouldConnect = connect
    this._resyncInterval = 0
    this.authenticated = false
    this.jwt = jwt

    this._checkInterval = (window.setInterval(() => {
      if (
        this.wsconnected &&
        messageReconnectTimeout <
        time.getUnixTime() - this.wsLastMessageReceived
      ) {
        (this.ws!).close()
      }
    }, messageReconnectTimeout / 10))
    if (connect) {
      this.connect()
    }
  }

  sendSyncStep1(doc: SharedEntity) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, SYNC_STEP_1)
    encoding.writeVarString(encoder, doc.shareId)
    encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc.yDoc))
    encoding.writeVarString(encoder, doc.calculateHash())
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendSyncStep2(doc: SharedEntity, vector?: Uint8Array) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, SYNC_STEP_2)
    encoding.writeVarString(encoder, doc.shareId)
    encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc.yDoc, vector))
    encoding.writeVarString(encoder, doc.calculateHash())
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendUpdate(doc: SharedEntity, update: Uint8Array) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, UPDATE)
    encoding.writeVarString(encoder, doc.shareId)
    encoding.writeVarUint8Array(encoder, update)
    encoding.writeVarString(encoder, doc.calculateHash())
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendUpdateMessage(shareId: string, update: Uint8Array, checksum: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, UPDATE)
    encoding.writeVarString(encoder, shareId)
    encoding.writeVarUint8Array(encoder, update)
    encoding.writeVarString(encoder, checksum)
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendNewDocument(doc: SharedEntity, tempId: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, NEW_DOCUMENT)
    encoding.writeVarString(encoder, tempId)
    encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc.yDoc))
    encoding.writeVarString(encoder, doc.calculateHash())
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendGetDocumentAsUpdate(id: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, GET_DOCUMENT_AS_UPDATE),
      encoding.writeVarString(encoder, id)
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendAuthenicationRequest(jwt: string) {
    this.jwt = jwt
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AUTHENTICATION_REQUEST)
    encoding.writeVarString(encoder, jwt)
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  authenticate(jwt: string) {
    return new Promise<AuthResponseData>(resolve => {
      const handler = async (data: AuthResponseData) => {
        this.off('authenticated', handler)
        resolve(data)
      }
      this.on('authenticated', handler)
      this.sendAuthenicationRequest(jwt)
    })
  }

  sendMessage(buf: ArrayBuffer) {
    if (this.wsconnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf)
    }
  }

  requestDocument(docId: string) {
    return new Promise<Y.Doc>(resolve => {
      const handler = (serverId: string, update: Uint8Array, checksum: string) => {
        if (docId === serverId) {
          this.off('document-received', handler)
          const doc = new Y.Doc()
          Y.applyUpdate(doc, update)

          // correct hash for folders
          const docs = Array.from(doc.getMap("documents"))
          if (docs.length > 0) {
            const serialized = serialize(Array.from(docs))
            const calculatedHash = calculateHash(serialized)
            if (calculatedHash != checksum) {
              this.sendUpdateMessage(docId, Y.encodeStateAsUpdate(doc), calculatedHash)
            }
          }
          resolve(doc)
        }
      }
      this.on('document-received', handler)
      this.sendGetDocumentAsUpdate(docId)
    })
  }

  destroy() {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval)
    }
    clearInterval(this._checkInterval)
    this.disconnect()
    super.destroy()
  }

  disconnect() {
    this.shouldConnect = false
    if (this.ws !== null) {
      this.ws.close()
    }
  }

  connect() {
    this.shouldConnect = true
    if (!this.wsconnected && this.ws === null) {
      setupWS(this)
    }
  }
}
