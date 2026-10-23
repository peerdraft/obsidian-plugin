/** @jest-environment node */

/**
 * Delete-menu contract through the real provider and a loopback WebSocket peer.
 * Only Obsidian/UI and entity lookup/storage boundaries are substituted. The
 * peer speaks the production stop protocol; no stop promise is pre-resolved.
 */
import type { Menu, TFile } from 'obsidian'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Doc } from 'yjs'
import { createMenu } from '../ui/createMenu'
import { PeerdraftWebsocketProvider } from '../peerdraftWebSocketProvider'

const events: string[] = []
const notices: string[] = []
const folderDoc = new Doc()
const documents = folderDoc.getMap<string>('documents')
let shared = true
let fileExists = true
let cleanupFailure: 'unshare' | 'delete' | undefined
const sharedDocument = {
  shareId: 'menu-wire-document',
  file: { basename: 'probe' },
  unshare: async (): Promise<void> => {
    events.push('unshare')
    if (cleanupFailure === 'unshare') throw new Error('unshare failed')
    shared = false
  },
}
const sharedFolder = {
  removeDocument: (): void => {
    events.push('remove')
    documents.delete('probe.md')
  },
}

jest.mock('src/peerdraftPlugin', () => ({ __esModule: true, default: class {} }))
jest.mock('src/sharedEntities/sharedDocument', () => ({
  SharedDocument: { findByPath: () => sharedDocument },
}))
jest.mock('src/sharedEntities/sharedFolder', () => ({
  SharedFolder: { getSharedFolderForSubPath: () => sharedFolder },
}))
jest.mock('../sharedEntities/syncableDocument', () => ({ SyncableDocument: { getAll: () => [] } }))
jest.mock('../sharedEntities/syncableFolder', () => ({ SyncableFolder: { getAll: () => [] } }))
jest.mock('../ui/folderOptions', () => ({ openFolderOptions: jest.fn() }))
jest.mock('../ui/chooseSessionType', () => ({ promptForSessionType: jest.fn() }))
jest.mock('src/ui', () => ({
  showNotice: (message: string): void => { notices.push(message) },
  openFileInNewTab: jest.fn(),
}))
jest.mock('obsidian', () => ({
  TFile: class { path = 'probe.md' },
  TFolder: class {},
  normalizePath: (path: string): string => path,
}), { virtual: true })

interface WireSocket {
  on(event: 'message', callback: (data: Uint8Array) => void): void
  send(data: Uint8Array): void
  terminate(): void
}

interface WireServer {
  address(): { port: number }
  on(event: 'connection', callback: (socket: WireSocket) => void): void
  once(event: 'listening', callback: () => void): void
  once(event: 'error', callback: (error: Error) => void): void
  close(callback: (error?: Error) => void): void
  clients: Set<WireSocket>
}

// ws is already a y-websocket dependency. Its Node entry provides a real peer.
const ws = require('ws') as {
  WebSocket: typeof WebSocket
  WebSocketServer: new (options: { host: string; port: number }) => WireServer
}
type Outcome = 'confirmed' | 'not_found' | 'not_permitted' | 'internal' | 'unauthenticated' | 'timeout'
const deadlineMs = 150
const failureNotice = 'Could not confirm the session stop. The document was kept in the shared folder. Please try again.'

const message = (outer: number, subtype: number | undefined, fields: string[]): Uint8Array => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, outer)
  if (subtype !== undefined) encoding.writeVarUint(encoder, subtype)
  for (const field of fields) encoding.writeVarString(encoder, field)
  return encoding.toUint8Array(encoder)
}

const state = (): { inFolder: boolean; shared: boolean; fileExists: boolean } => ({
  inFolder: documents.has('probe.md'), shared, fileExists,
})

describe('Delete and remove from Shared Folder over the stop wire protocol', () => {
  const originalWebSocket = global.WebSocket
  const originalWindow = Object.getOwnPropertyDescriptor(global, 'window')

  beforeAll(() => {
    global.WebSocket = ws.WebSocket
    Object.defineProperty(global, 'window', { configurable: true, value: globalThis })
  })

  afterAll(() => {
    global.WebSocket = originalWebSocket
    if (originalWindow) Object.defineProperty(global, 'window', originalWindow)
    else Reflect.deleteProperty(global, 'window')
    folderDoc.destroy()
  })

  const exercise = async (outcome: Outcome): Promise<{
    wireStops: number; menuStops: number; pending: ReturnType<typeof state>
  }> => {
    events.length = 0
    notices.length = 0
    documents.set('probe.md', sharedDocument.shareId)
    shared = true
    fileExists = true
    const server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
    let wireStops = 0
    let menuStops = 0
    const stopTasks: Promise<string>[] = []
    let receivedStop: (() => void) | undefined
    const firstStop = new Promise<void>(resolve => { receivedStop = resolve })
    server.on('connection', socket => {
      socket.on('message', data => {
        const decoder = decoding.createDecoder(new Uint8Array(data))
        const outer = decoding.readVarUint(decoder)
        if (outer === 5) {
          socket.send(message(6, undefined, [JSON.stringify({ plan: { type: 'Free' } })]))
        } else if (outer === 4 && decoding.readVarUint(decoder) === 10) {
          const id = decoding.readVarString(decoder)
          expect(id).toBe(sharedDocument.shareId)
          wireStops++
          receivedStop?.()
          // Let the test observe local state while the real stop is pending.
          if (outcome !== 'timeout') setTimeout(() => {
            socket.send(outcome === 'confirmed'
              ? message(4, 11, [id])
              : message(4, 13, [id, outcome]))
          }, 10)
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const provider = new PeerdraftWebsocketProvider(`ws://127.0.0.1:${server.address().port}/sync`, {
      connect: false, jwt: 'loopback-fixture-only',
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('auth timeout')), 2000)
        provider.on('authenticated', () => { clearTimeout(timer); resolve() })
        provider.connect()
      })
      const plugin = {
        serverSync: {
          stopSession: (id: string): Promise<string> => {
            menuStops++
            const task = provider.stopSession(id, deadlineMs).finally(() => { events.push('stop-settled') })
            stopTasks.push(task)
            return task
          },
        },
        app: { vault: { delete: async (): Promise<void> => {
          events.push('delete')
          if (cleanupFailure === 'delete') throw new Error('delete failed')
          fileExists = false
        } } },
      }
      const callbacks = new Map<string, () => Promise<void>>()
      const menu = { addItem(callback: (item: unknown) => void) {
        let title = ''
        const item = {
          setTitle(value: string) { title = value; return item },
          setIcon() { return item },
          onClick(fn: () => Promise<void>) { callbacks.set(title, fn); return item },
        }
        callback(item)
        return menu
      } }
      const File = (require('obsidian') as { TFile: new () => TFile }).TFile
      createMenu(menu as unknown as Menu, new File(), plugin as unknown as Parameters<typeof createMenu>[2])
      const click = callbacks.get('Delete and remove from Shared Folder')
      expect(click).toBeDefined()
      const completed = click!()
      await firstStop
      const pending = state()
      await completed
      // A menu-triggered fire-and-forget retry would be visible here as a
      // second menu call and additional wire requests for transient failures.
      await new Promise(resolve => setTimeout(resolve, 30))
      await Promise.allSettled(stopTasks)
      return { wireStops, menuStops, pending }
    } finally {
      const closed = provider.ws
        ? new Promise<void>(resolve => provider.ws!.addEventListener('close', () => resolve(), { once: true }))
        : Promise.resolve()
      provider.destroy()
      for (const socket of server.clients) socket.terminate()
      await closed
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }

  test.each<Outcome>(['confirmed', 'not_found', 'not_permitted', 'internal', 'unauthenticated', 'timeout'])(
    '%s: preserve all local state until stop; only achieved stops delete', async outcome => {
      cleanupFailure = undefined
      const result = await exercise(outcome)
      const achieved = outcome === 'confirmed' || outcome === 'not_found'
      expect({ ...result, final: state(), events, notices }).toEqual({
        pending: { inFolder: true, shared: true, fileExists: true },
        final: { inFolder: !achieved, shared: !achieved, fileExists: !achieved },
        events: achieved ? ['stop-settled', 'remove', 'unshare', 'delete'] : ['stop-settled'],
        notices: [achieved ? 'probe removed from shared folder.' : failureNotice],
        menuStops: 1,
        wireStops: outcome === 'timeout' || outcome === 'unauthenticated' ? 2 : 1,
      })
    }, 5000,
  )

  test.each(['unshare', 'delete'] as const)('confirmed stop preserves %s failure notice without success toast', async failure => {
    cleanupFailure = failure
    const result = await exercise('confirmed')
    expect(result.pending).toEqual({ inFolder: true, shared: true, fileExists: true })
    expect(events).toEqual(['stop-settled', 'remove', 'unshare', 'delete'])
    expect(state()).toEqual({ inFolder: false, shared: failure === 'unshare', fileExists: failure === 'delete' })
    expect(notices).toEqual([failure === 'unshare'
      ? 'Local cleanup failed after removing the document from the shared folder.'
      : 'The file could not be deleted from this vault.'])
    expect(result.menuStops).toBe(1)
    expect(result.wireStops).toBe(1)
  })
})
