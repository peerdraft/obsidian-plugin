import * as Y from 'yjs'
import * as time from 'lib0/time'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { ObservableV2 } from 'lib0/observable'
import * as math from 'lib0/math'
import { SyncableDocument, type SyncableEntity } from './sharedEntities/syncableDocument'
import { SyncableFolder } from './sharedEntities/syncableFolder'
import { calculateHash, createRandomId, serialize } from './tools'
import { PendingMessageQueue } from './pendingMessageQueue'
import { canonicalStateUpdate, isSyncProof, sha256, type CheckpointManifest, type SyncProof } from './fastRestart'

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
export const BINARY_PRESIGN_UPLOAD = 12
export const STOP_SESSION_FAILED = 13
export const CHECKPOINTS_REQUEST = 14
export const CHECKPOINTS_RESPONSE = 15
export const CHECKPOINT_CHANGED = 16

export type StopSessionFailureReason = 'unauthenticated' | 'not_found' | 'not_permitted' | 'internal'

export type StopSessionRejectionReason = Exclude<StopSessionFailureReason, 'not_found'> | 'timeout'

/** Rejection from `stopSession` — `reason` tells deterministic answers
 *  (`not_permitted`, `internal`, `unauthenticated` after retry) from a
 *  timeout, so callers can phrase failure notices honestly. */
export class StopSessionError extends Error {
  constructor(public readonly reason: StopSessionRejectionReason, id: string) {
    super(`stop-session for ${id} ${reason === 'timeout' ? 'timed out' : `failed: ${reason}`}`)
    this.name = 'StopSessionError'
  }
}

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
      if (provider.ws !== websocket) return
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
            if (doc) provider.handleSyncStep1(doc, vector, hash)
          } break;
          case SYNC_STEP_2: {
            const id = decoding.readVarString(decoder)
            const update = decoding.readVarUint8Array(decoder)
            const hash = decoding.readVarString(decoder)
            const doc = SyncableDocument.findById(id) ?? SyncableFolder.findById(id)
            if (doc) {
              Y.applyUpdate(doc.yDoc, update, provider)
              provider.emit('synced', [id, hash])
              if (decoding.hasContent(decoder)) {
                try {
                  const proof: unknown = JSON.parse(decoding.readVarString(decoder))
                  if (isSyncProof(proof)) provider.receiveSyncProof(id, proof)
                } catch { /* Optional proof never prevents ordinary synchronization. */ }
              }
            }
          }
            break;
          case SEND_DOCUMENT_AS_UPDATE: {
            const id = decoding.readVarString(decoder)
            const update = decoding.readVarUint8Array(decoder)
            const checksum = decoding.readVarString(decoder)
            let proof: SyncProof | undefined
            if (decoding.hasContent(decoder)) {
              try {
                const value: unknown = JSON.parse(decoding.readVarString(decoder))
                if (isSyncProof(value)) proof = value
              } catch { /* Old servers and optional malformed proofs use normal synchronization. */ }
            }
            provider.emit("document-received", [id, update, checksum, proof])
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
          case STOP_SESSION_FAILED: {
            const id = decoding.readVarString(decoder)
            const reason = decoding.readVarString(decoder)
            provider.emit("stop-session-failed", [id, reason])
            break;
          }
          case CHECKPOINTS_RESPONSE: {
            const requestId = decoding.readVarString(decoder)
            const payload = decoding.readVarString(decoder)
            provider.receiveCheckpointManifest(requestId, payload)
            break;
          }
          case CHECKPOINT_CHANGED: {
            const id = decoding.readVarString(decoder)
            const checkpoint = decoding.readVarString(decoder)
            provider.receiveCheckpointChange(id, checkpoint || null)
            break;
          }
          default:
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
      if (provider.ws !== websocket) return
      provider.clearCheckpointRequests()
      provider.clearDocumentRequests()
      for (const document of SyncableDocument.getAll()) document.resetServerSyncFlight()
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
      window.setTimeout(
        setupWS,
        math.min(
          math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
          provider.maxBackoffTime
        ),
        provider
      )
    }

    websocket.onopen = async () => {
      // Connected listeners start restoring models. Their factories own the
      // initial cache-first sync, so only reconnect models already registered.
      const reconnectFolders = SyncableFolder.getAll()
      const reconnectDocuments = SyncableDocument.getAll().filter(syncable => syncable.isPermanent)
      provider.wsLastMessageReceived = time.getUnixTime()
      provider.wsconnecting = false
      provider.wsconnected = true
      provider.wsUnsuccessfulReconnects = 0
      provider.emit('status', [{
        status: 'connected'
      }])
      provider.emit('connected', [])

      if (provider.jwt) {
        void provider.authenticate(provider.jwt, provider.version)
      }

      provider.flushPendingMessages()

      const folderPromises = reconnectFolders.map(async (folder) => {
        if (folder.indexedDBProvider) {
          if (!folder.indexedDBProvider.synced) await folder.indexedDBProvider.whenSynced
        }
        void folder.syncWithServer()
      })
      await Promise.all(folderPromises)

      const docPromises = reconnectDocuments.map(async (syncable) => {
        if (syncable.isPermanent) {
          if (syncable.indexedDBProvider) {
            if (!syncable.indexedDBProvider.synced) await syncable.indexedDBProvider.whenSynced
          }
          if (syncable.canStartServerSync) void syncable.syncWithServer()
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

export interface DocumentSnapshot {
  doc: Y.Doc
  checksum: string
  proof?: SyncProof
  /** False once the socket that supplied this snapshot has been lost. */
  isCurrent(): boolean
}

type Events = {
  synced: (id: string, hash: string) => void
  "connection-error": (event: Event, provider: PeerdraftWebsocketProvider) => void
  "connection-close": (event: Event, provider: PeerdraftWebsocketProvider) => void
  status: (status: { status: string }) => void
  connected: () => void
  'document-received': (id: string, update: Uint8Array, checksum: string, proof?: SyncProof) => void
  'new-doc-confirmed': (tempId: string, id: string, checksum: string) => void
  'new-session-confirmed': (tempId: string, id: string) => void
  'stop-session-confirmed': (id: string) => void
  'stop-session-failed': (id: string, reason: string) => void
  'authenticated': (data: AuthResponseData) => void
  'showMessage': (title: string, content: string) => void
  'sync-proof': (id: string, proof: SyncProof) => void
  'checkpoint-changed': (id: string, checkpoint: string | null) => void
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
  private pendingMessages = new PendingMessageQueue()
  private destroyed = false
  private connectionGeneration = 0
  private readonly documentRequests = new Set<(error: Error) => void>()
  private readonly checkpointRequests = new Map<string, {
    ids: string[]; resolve: (manifest: CheckpointManifest) => void;
    reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>
  }>()
  private readonly checkpointSubscriptions = new Set<string>()
  private readonly proofEnabledSubscriptions = new Set<string>()
  private readonly syncProofs = new Map<string, SyncProof>()

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

  /** Request a bounded manifest on the already-open sync socket. */
  requestCheckpoints(ids: string[], timeoutMs = 5000): Promise<CheckpointManifest> {
    const unique = Array.from(new Set(ids))
    if (unique.length > 2000 || unique.some(id => typeof id !== 'string' || !id || id.length > 256)) {
      return Promise.reject(new Error('Invalid checkpoint request'))
    }
    if (unique.length === 0) return Promise.resolve({ supported: true, checkpoints: {} })
    if (!this.wsconnected) return Promise.reject(new Error('Sync socket is not connected'))
    const requestId = createRandomId()
    return new Promise<CheckpointManifest>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.checkpointRequests.delete(requestId)
        reject(new Error('Checkpoint request timed out'))
      }, timeoutMs)
      this.checkpointRequests.set(requestId, { ids: unique, resolve, reject, timer })
      for (const id of unique) this.checkpointSubscriptions.add(id)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
      encoding.writeVarUint(encoder, CHECKPOINTS_REQUEST)
      encoding.writeVarString(encoder, requestId)
      encoding.writeVarString(encoder, JSON.stringify(unique))
      try { this.sendMessage(encoding.toUint8Array(encoder)) } catch (error) {
        clearTimeout(timer)
        this.checkpointRequests.delete(requestId)
        reject(error)
      }
    })
  }

  receiveCheckpointManifest(requestId: string, payload: string): void {
    const pending = this.checkpointRequests.get(requestId)
    if (!pending) return
    this.checkpointRequests.delete(requestId)
    clearTimeout(pending.timer)
    try {
      const value: unknown = JSON.parse(payload)
      if (!value || typeof value !== 'object') throw new Error('Invalid checkpoint manifest')
      const result = value as Partial<CheckpointManifest>
      if (typeof result.supported !== 'boolean' || !result.checkpoints || typeof result.checkpoints !== 'object' || Array.isArray(result.checkpoints)) {
        throw new Error('Invalid checkpoint manifest')
      }
      const checkpoints: Record<string, string | null> = Object.create(null)
      for (const id of pending.ids) {
        const checkpoint = result.checkpoints[id] ?? null
        if (checkpoint !== null && (typeof checkpoint !== 'string' || !checkpoint || checkpoint.length > 256)) {
          throw new Error('Invalid checkpoint token')
        }
        checkpoints[id] = checkpoint
      }
      for (const id of pending.ids) {
        const checkpoint = checkpoints[id]
        if (result.supported && checkpoint) this.proofEnabledSubscriptions.add(id)
        else this.proofEnabledSubscriptions.delete(id)
      }
      pending.resolve({ supported: result.supported, checkpoints })
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('Invalid checkpoint manifest'))
    }
  }

  receiveCheckpointChange(id: string, checkpoint: string | null): void {
    if (!this.checkpointSubscriptions.has(id) || (checkpoint !== null && (!checkpoint || checkpoint.length > 256))) return
    this.syncProofs.delete(id)
    this.emit('checkpoint-changed', [id, checkpoint])
  }

  receiveSyncProof(id: string, proof: SyncProof): void {
    if (!isSyncProof(proof)) return
    this.syncProofs.set(id, proof)
    this.emit('sync-proof', [id, proof])
  }

  /** Text equality alone cannot suppress metadata/deletion-history synchronization. */
  handleSyncStep1(doc: SyncableEntity, vector: Uint8Array, hash: string): void | Promise<void> {
    if (!this.proofEnabledSubscriptions.has(doc.shareId)) {
      this.sendSyncStep2(doc, vector, { remoteChecksum: hash })
      return
    }
    const proof = this.syncProofs.get(doc.shareId)
    if (!proof) {
      this.sendSyncStep2(doc, vector)
      return
    }
    const socket = this.ws
    let changed = false
    const onUpdate = (): void => { changed = true }
    doc.yDoc.on('update', onUpdate)
    let state: Uint8Array
    try { state = canonicalStateUpdate(doc.yDoc) } catch {
      doc.yDoc.off('update', onUpdate)
      this.sendSyncStep2(doc, vector)
      return
    }
    return sha256(state).then(stateHash => {
      if (!this.wsconnected || this.ws !== socket || this.syncProofs.get(doc.shareId) !== proof) return
      if (changed || stateHash !== proof.stateHash) this.sendSyncStep2(doc, vector)
    }).catch(() => {
      if (this.wsconnected && this.ws === socket) this.sendSyncStep2(doc, vector)
    }).finally(() => { doc.yDoc.off('update', onUpdate) })
  }

  clearCheckpointRequests(): void {
    for (const pending of this.checkpointRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Sync socket disconnected'))
    }
    this.checkpointRequests.clear()
    this.checkpointSubscriptions.clear()
    this.proofEnabledSubscriptions.clear()
    this.syncProofs.clear()
  }

  sendSyncStep1(doc: SyncableEntity) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, SYNC_STEP_1)
    encoding.writeVarString(encoder, doc.shareId)
    encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc.yDoc))
    encoding.writeVarString(encoder, doc.calculateHash())
    this.sendMessage(encoding.toUint8Array(encoder))
  }

  sendSyncStep2(doc: SyncableEntity, vector?: Uint8Array, options: { remoteChecksum?: string } = {}) {
    const update = Y.encodeStateAsUpdate(doc.yDoc, vector)
    const checksum = doc.calculateHash()
    // Equal visible content can still hide missing causal state. Only skip a
    // truly empty diff when the remote checksum already matches as well.
    if (update.length === 2 && update[0] === 0 && update[1] === 0 && options.remoteChecksum === checksum) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_MULTIPLEX_SYNC)
    encoding.writeVarUint(encoder, SYNC_STEP_2)
    encoding.writeVarString(encoder, doc.shareId)
    encoding.writeVarUint8Array(encoder, update)
    encoding.writeVarString(encoder, checksum)
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
    } else {
      this.pendingMessages.push(buf)
    }
  }

  get pendingMessageCount(): number {
    return this.pendingMessages.size
  }

  flushPendingMessages(): void {
    this.pendingMessages.flush((buf) => this.sendMessage(buf))
  }

  connected() {
    return new Promise<void>((resolve) => {
      if (this.wsconnected) return resolve()
      this.once('connected', () => {
        resolve()
      })
    })
  }

  /** Download complete state once; callers own the returned document. */
  requestDocumentSnapshot(docId: string, timeoutMs = 20000): Promise<DocumentSnapshot> {
    if (this.destroyed) return Promise.reject(new Error('Sync provider was destroyed'))
    if (!docId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('Invalid document snapshot request'))
    }
    return new Promise<DocumentSnapshot>((resolve, reject) => {
      let settled = false
      let requestedSocket: WebSocket | null = null
      let requestedGeneration = this.connectionGeneration
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('connected', send)
        this.off('document-received', receive)
        this.documentRequests.delete(fail)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const receive = (id: string, update: Uint8Array, checksum: string, proof?: SyncProof): void => {
        if (id !== docId || settled || !requestedSocket) return
        if (!this.wsconnected || this.ws !== requestedSocket || this.connectionGeneration !== requestedGeneration) {
          fail(new Error('Document snapshot socket changed'))
          return
        }
        const doc = new Y.Doc()
        try {
          Y.applyUpdate(doc, update)
        } catch (error) {
          doc.destroy()
          fail(error instanceof Error ? error : new Error('Invalid document snapshot'))
          return
        }
        settled = true
        cleanup()
        const socket = requestedSocket
        const generation = requestedGeneration
        resolve({
          doc, checksum, proof,
          isCurrent: () => !this.destroyed && this.wsconnected && this.ws === socket && this.connectionGeneration === generation,
        })
      }
      const send = (): void => {
        if (settled || !this.wsconnected || !this.ws) return
        this.off('connected', send)
        requestedSocket = this.ws
        requestedGeneration = this.connectionGeneration
        try { this.sendGetDocumentAsUpdate(docId) } catch (error) {
          fail(error instanceof Error ? error : new Error('Document snapshot request failed'))
        }
      }
      const timer = setTimeout(() => fail(new Error(`Document snapshot ${docId} timed out`)), timeoutMs)
      this.documentRequests.add(fail)
      this.on('document-received', receive)
      this.on('connected', send)
      send()
    })
  }

  clearDocumentRequests(): void {
    this.connectionGeneration++
    for (const fail of Array.from(this.documentRequests)) fail(new Error('Sync socket disconnected'))
  }

  async requestDocument(docId: string): Promise<Y.Doc> {
    const { doc, checksum } = await this.requestDocumentSnapshot(docId)
    // Preserve folder checksum repair for existing callers. Initial document
    // imports use the snapshot API and verify complete state before acceptance.
    const docs = Array.from(doc.getMap("documents"))
    if (docs.length > 0) {
      const calculatedHash = calculateHash(serialize(Array.from(docs)))
      if (calculatedHash !== checksum) {
        this.sendUpdateMessage(docId, Y.encodeStateAsUpdate(doc), calculatedHash)
      }
    }
    return doc
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

  stopSession(id: string, timeoutMs = 20000) {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let retried = false
      let timer = 0

      const cleanup = () => {
        this.off("stop-session-confirmed", onConfirmed)
        this.off("stop-session-failed", onFailed)
        this.off("authenticated", onAuthenticated)
        window.clearTimeout(timer)
      }
      const settle = (action: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        action()
      }
      const send = () => {
        timer = window.setTimeout(onTimeout, timeoutMs)
        this.sendStopSession(id)
      }
      const scheduleRetry = (failure: () => void) => {
        if (retried) {
          settle(failure)
          return
        }
        retried = true
        window.clearTimeout(timer)
        if (this.authenticated) {
          send()
        } else {
          this.on("authenticated", onAuthenticated)
          timer = window.setTimeout(() => settle(failure), timeoutMs)
        }
      }
      const onTimeout = () => scheduleRetry(() => reject(new StopSessionError('timeout', id)))
      const onAuthenticated = () => {
        if (settled) return
        this.off("authenticated", onAuthenticated)
        send()
      }
      const onConfirmed = (sessionId: string) => {
        if (sessionId === id) settle(() => resolve(id))
      }
      const onFailed = (sessionId: string, reason: string) => {
        if (sessionId !== id) return
        if (reason === 'unauthenticated') {
          scheduleRetry(() => reject(new StopSessionError('unauthenticated', id)))
        } else if (reason === 'not_found') {
          // The share is already gone server-side — the stop is achieved.
          settle(() => resolve(id))
        } else {
          settle(() => reject(new StopSessionError(reason as 'not_permitted' | 'internal', id)))
        }
      }

      this.on("stop-session-confirmed", onConfirmed)
      this.on("stop-session-failed", onFailed)
      send()
    })
  }

  destroy() {
    this.destroyed = true
    if (this._resyncInterval !== 0) {
      window.clearInterval(this._resyncInterval)
    }
    window.clearInterval(this._checkInterval)
    this.disconnect()
    super.destroy()
  }

  disconnect() {
    this.clearCheckpointRequests()
    this.clearDocumentRequests()
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
