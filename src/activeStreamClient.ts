import * as time from 'lib0/time'
import { ObservableV2 } from 'lib0/observable'
import * as math from 'lib0/math'
import { SharedDocument } from './sharedEntities/sharedDocument'
import { SharedFolder } from './sharedEntities/sharedFolder'

type ClientMessage = {
  type: "add" | "remove" | "full",
  docs: Array<string>
}

type ServerMessage = {
  type: "add" | "full" | "delete",
  docs: Array<string>
}

type Events = {
  "connection-error": (event: Event, client: ActiveStreamClient) => void,
  "connection-close": (event: Event, client: ActiveStreamClient) => void,
  status: (status: { status: string }) => void
}

const messageReconnectTimeout = 30000

const handleMessage = async (data: string) => {
  const message = JSON.parse(data) as ServerMessage
  if (["add", "full"].includes(message.type)) {
    for (const id of message.docs) {
      SharedDocument.findById(id)?.startWebRTCSync()
      SharedFolder.findById(id)?.startWebRTCSync()
    }
  } else if (message.type === "delete") {
    for (const id of message.docs) {
      SharedDocument.findById(id)?.unshare()
      SharedFolder.findById(id)?.unshare()
    }
  }
}

const setupWS = (client: ActiveStreamClient) => {
  if (client.shouldConnect && client.ws === null) {
    const websocket = new WebSocket(client.url)
    client.ws = websocket
    client.wsconnecting = true
    client.wsconnected = false

    websocket.onmessage = (event) => {
      client.wsLastMessageReceived = time.getUnixTime()
      handleMessage(event.data)
    }

    websocket.onerror = (event) => {
      client.emit('connection-error', [event, client])
    }

    websocket.onclose = (event) => {
      client.emit('connection-close', [event, client])
      client.ws = null
      client.wsconnecting = false
      if (client.wsconnected) {
        client.wsconnected = false

        client.emit('status', [{
          status: 'disconnected'
        }])

      } else {
        client.wsUnsuccessfulReconnects++
      }
      // Start with no reconnect timeout and increase timeout by
      // using exponential backoff starting with 100ms
      setTimeout(
        setupWS,
        math.min(
          math.pow(2, client.wsUnsuccessfulReconnects) * 100,
          client.maxBackoffTime
        ),
        client
      )
    }
    websocket.onopen = () => {
      client.wsLastMessageReceived = time.getUnixTime()
      client.wsconnecting = false
      client.wsconnected = true
      client.wsUnsuccessfulReconnects = 0
      client.emit('status', [{
        status: 'connected'
      }])

      client.send(JSON.stringify({
        type: "full",
        docs: Array.from(client.docIds)
      } satisfies ClientMessage))

    }
    client.emit('status', [{
      status: 'connecting'
    }])
  }
}

export class ActiveStreamClient extends ObservableV2<Events> {

  maxBackoffTime: number
  url: string
  wsconnected: boolean
  wsconnecting: boolean
  wsUnsuccessfulReconnects: number
  ws: WebSocket | null
  wsLastMessageReceived: number
  shouldConnect: boolean
  _resyncInterval: number

  docIds: Set<string>

  constructor(url: string, opts: {
    connect: boolean,
    resyncInterval: number,
    maxBackoffTime: number,
  } = {
      connect: true,
      resyncInterval: -1,
      maxBackoffTime: 2500
    }) {
    super()
    this.maxBackoffTime = opts.maxBackoffTime
    this.url = url

    this.wsconnected = false
    this.wsconnecting = false
    this.wsUnsuccessfulReconnects = 0

    this.ws = null
    this.wsLastMessageReceived = 0
    this.shouldConnect = opts.connect
    this._resyncInterval = 0

    this.docIds = new Set<string>()

    if (opts.resyncInterval > 0) {
      this._resyncInterval = (window.setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.send(JSON.stringify({
            type: "full",
            docs: Array.from(this.docIds)
          } satisfies ClientMessage))
        }
      }, opts.resyncInterval))
    }

    if (opts.connect) {
      this.connect()
    }
  }

  send(data: string) {
    if (this.ws && this.ws.readyState !== this.ws.CONNECTING && this.ws.readyState !== this.ws.OPEN) {
      this.ws.close()
    }
    try {
      this.ws?.send(data)
    } catch (e) {
      this.ws?.close()
    }
  }


  destroy() {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval)
    }
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

  add(ids: Array<string>) {
    for (const id of ids) {
      this.docIds.add(id)
    }
    this.send(JSON.stringify({
      type: "add",
      docs: ids
    } satisfies ClientMessage))
  }

  remove(ids: Array<string>) {
    for (const id of ids) {
      this.docIds.delete(id)
    }
    this.send(JSON.stringify({
      type: "remove",
      docs: ids
    } satisfies ClientMessage))
  }
}
