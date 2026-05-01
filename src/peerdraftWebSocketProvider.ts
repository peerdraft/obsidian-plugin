import * as Y from 'yjs'
import * as time from 'lib0/time'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { ObservableV2 } from 'lib0/observable'
import * as math from 'lib0/math'
import { SyncableDocument, type SyncableEntity } from './sharedEntities/syncableDocument'
import { SyncableFolder } from './sharedEntities/syncableFolder'
import { calculateHash, createRandomId, serialize } from './tools'

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
export const NEW_SESSION = 8
export const NEW_SESSION_CONFIRMED = 9
export const STOP_SESSION = 10
export const STOP_SESSION_CONFIRMED = 11

export const MESSAGE_AUTHENTICATION_REQUEST = 5
export const MESSAGE_AUTHENTICATION_RESPONSE = 6

export const SHOW_MESSAGE_MESSAGE = 8

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
            const doc = SyncableDocument.findById(id) ?? SyncableFolder.findById(id)
            if (doc && hash != doc.calculateHash()) {
              provider.sendSyncStep2(doc, vector)
            }
          } break;
          case SYNC_STEP_2: {
            const id = decoding.readVarString(decoder)
            const update = decoding.readVarUint8Array(decoder)
            const hash = decoding.readVarString(decoder)
            const doc = SyncableDocument.findById(id) ?? SyncableFolder.findById(id)
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
          case NEW_SESSION_CONFIRMED: {
            const tempId = decoding.readVarString(decoder)
            const id = decoding.readVarString(decoder)
            provider.emit("new-session-confirmed", [tempId, id])
            break;
          }
          case STOP_SESSION_CONFIRMED: {
            const id = decoding.readVarString(decoder)
            provider.emit("stop-session-confirmed", [id])
            break;
          }
          default:
            console.log(syncMessageType)
            break;
        }
      }
      else if (messageType === MESSAGE_AUTHENTICATION_RESPONSE) {
        const data = JSON.parse(decoding.readVarString(decoder))
        provider.authenticated = true
        provider.emit('authenticated', [data])
      } else if (messageType === SHOW_MESSAGE_MESSAGE) {
        const title = decoding.readVarString(decoder)
        const content = decoding.readVarString(decoder)
        provider.emit('showMessage', [title, content])
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
      provider.emit('connected', [])

      if (provider.jwt) {
        provider.authenticate(provider.jwt, provider.version)
      }

      // Iterate the syncable registries rather than SharedFolder /
      // SharedDocument. The set of entries is identical (every
      // SharedFolder / SharedDocument owns one syncable registered by
      // id), but this decouples the provider from the Obsidian-side
      // wrapper classes — which is what lets the test harness register
      // syncables without booting the full plugin.

      // Sync folders first (they contain the document map), then documents.
      // Within each group, all items sync in parallel.
      const folderPromises = SyncableFolder.getAll().map(async (folder) => {
        // Folders are always permanent (no isPermanent gate needed).
        // Await IndexedDB sync if provider exists (may be deferred for new folders).
        if (folder.indexedDBProvider) {
          if (!folder.indexedDBProvider.synced) await folder.indexedDBProvider.whenSynced
        }
        folder.syncWithServer()
      })
      await Promise.all(folderPromises)

      const docPromises = SyncableDocument.getAll().map(async (syncable) => {
        if (syncable.isPermanent) {
          // Await IndexedDB sync if provider exists (may be deferred for new documents).
          // Documents with deferred IndexedDB will sync with server first, then create DB.
          if (syncable.indexedDBProvider) {
            if (!syncable.indexedDBProvider.synced) await syncable.indexedDBProvider.whenSynced
          }
          syncable.syncWithServer()
        }
      })
      await Promise.all(docPromises)
      
    }

    provider.emit('status', [{
      status: 'connecting'
    }])
  }
}

interface AuthResponseData {
  plan: {
    type: string  // Display name from backend (e.g., "Free", "Hobby", "Pro", "Business")
  }
}

type Events = {
  synced: (id: string, hash: string) => void
  // sync: (state: boolean) => void
  "connection-error": (event: Event, provider: PeerdraftWebsocketProvider) => void
  "connection-close": (event: Event, provider: PeerdraftWebsocketProvider) => void
  status: (status: { status: string }) => void
  connected: () => void
  'document-received': (id: string, update: Uint8Array, checksum: string) => void
  // 'sync-confirmed': (id: string, checksum: string) => void
  'new-doc-confirmed': (tempId: string, id: string, checksum: string) => void
  'new-session-confirmed': (tempId: string, id: string) => void
  'stop-session-confirmed': (id: string) => void
  // 'my-update-sent': (id: string, update: Uint8Array, checksum: string) => void
  // 'other-document-received-if-checksum-differs': (id: string, myChecksum: string, yourChecksum: string, update?: Uint8Array) => void
  'authenticated': (data: AuthResponseData) => void
  'showMessage': (title: string, content: string) => void
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
  _checkInterval: number
  authenticated: boolean
  jwt: string | undefined
  version: string
  registry?: Map<string, import('./sharedEntities/syncableDocument').SyncableDocument>

  constructor(serverUrl: string, {
    connect = true,
    resyncInterval = -1,
    maxBackoffTime = 2500,
    jwt = undefined,
    version = '',
    registry
  }: { version?: string; jwt?: string, connect?: boolean; params?: { [s: string]: string }; WebSocketPolyfill?: typeof WebSocket; resyncInterval?: number; maxBackoffTime?: number; disableBc?: boolean; registry?: Map<string, import('./sharedEntities/syncableDocument').SyncableDocument> } = {}) {
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
    this.registry = registry
    this.shouldConnect = connect
    this._resyncInterval = 0
    this.authenticated = false
    this.jwt = jwt
    this.version = version

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

  // Send methods accept any `SyncableEntity` (the structural shape
  // `{ shareId, yDoc, calculateHash() }`). `SharedFolder` and
  // `SyncableDocument` both satisfy it; `SharedDocument` does too via
  // its composed syncable.
  sendSyncStep1(doc: SyncableEntity) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, SYNC_STEP_1)
    encoding.writeVarString(encoder, doc.shareId)
    encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc.yDoc))
    encoding.writeVarString(encoder, doc.calculateHash())
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendSyncStep2(doc: SyncableEntity, vector?: Uint8Array) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, SYNC_STEP_2)
    encoding.writeVarString(encoder, doc.shareId)
    encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc.yDoc, vector))
    encoding.writeVarString(encoder, doc.calculateHash())
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendUpdate(doc: SyncableEntity, update: Uint8Array) {
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

  sendNewDocument(doc: SyncableEntity, tempId: string, folderKey?: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, NEW_DOCUMENT)
    encoding.writeVarString(encoder, tempId)
    encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc.yDoc))
    encoding.writeVarString(encoder, doc.calculateHash())
    if (folderKey) {
      encoding.writeVarString(encoder, folderKey)
    }
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendGetDocumentAsUpdate(id: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, GET_DOCUMENT_AS_UPDATE)
    encoding.writeVarString(encoder, id)
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendAuthenicationRequest(jwt: string, version: string) {
    this.jwt = jwt
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AUTHENTICATION_REQUEST)
    encoding.writeVarString(encoder, jwt)
    encoding.writeVarString(encoder, version)
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendCreateNewSession(tempId: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, NEW_SESSION)
    encoding.writeVarString(encoder, tempId)
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendStopSession(id: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, STOP_SESSION)
    encoding.writeVarString(encoder, id)
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  authenticate(jwt: string, version: string) {
    return new Promise<AuthResponseData>(resolve => {
      const handler = async (data: AuthResponseData) => {
        this.off('authenticated', handler)
        resolve(data)
      }
      this.on('authenticated', handler)
      this.sendAuthenicationRequest(jwt, version)
    })
  }

  sendMessage(buf: Uint8Array) {
    if (this.wsconnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf)
    }
  }

  connected() {
    return new Promise<void>((resolve) => {
      if (this.wsconnected) return resolve()
      this.once('connected', () => {
        resolve()
      })
    })
  }

  requestDocument(docId: string) {
    return new Promise<Y.Doc>(async resolve => {
      await this.connected()
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

  createNewSession() {
    const tempId = createRandomId()
    return new Promise<string>(resolve => {
      const handler = (serverTempId: string, id: string) => {
        if (serverTempId === tempId) {
          this.off("new-session-confirmed", handler)
          resolve(id)
        }
      }
      this.on("new-session-confirmed", handler)
      this.sendCreateNewSession(tempId)
    })
  }

  stopSession(id: string) {
    return new Promise<string>(resolve => {
      const handler = (sessionId: string) => {
        if (sessionId === id) {
          this.off("stop-session-confirmed", handler)
          resolve(id)
        }
      }
      this.on("stop-session-confirmed", handler)
      this.sendStopSession(id)
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
