/**
 * `fetch.ts` set `loading` to false only on the success path, with no
 * try/catch around `requestUrl`. Obsidian's `requestUrl` throws on any 400+
 * status (its `throw` option defaults to true), so an expired JWT or a server
 * hiccup left the store loading forever — the share panel's spinner span with
 * no error shown and no way for the user to learn what happened. The e2e
 * identity suite saw this as "Active shares panel never finished loading
 * after Refresh" in teardown.
 */

const requestUrl = jest.fn()
jest.mock('obsidian', () => ({ requestUrl: (...args: unknown[]): unknown => requestUrl(...args) }), { virtual: true })

// Svelte 4 ships `svelte/store` as ESM only and this Jest setup transforms
// TypeScript alone, so the real module cannot be loaded here. `writable`'s
// contract is small enough to stand in for exactly: set notifies subscribers,
// subscribe fires immediately with the current value.
jest.mock('svelte/store', () => ({
  writable<T>(initial: T) {
    let value = initial
    const subscribers = new Set<(v: T) => void>()
    return {
      set(next: T) {
        value = next
        subscribers.forEach((notify) => notify(value))
      },
      subscribe(notify: (v: T) => void) {
        subscribers.add(notify)
        notify(value)
        return () => subscribers.delete(notify)
      }
    }
  }
}))

import fetchStore from '../ui/fetch'

/** The current value of a store, read through its subscribe contract. */
function readStore<T>(store: { subscribe(run: (value: T) => void): () => void }): T {
  let current!: T
  store.subscribe((value) => {
    current = value
  })()
  return current
}

/** Models Obsidian's RequestUrlResponsePromise: a promise for the response
 *  that also exposes `.json` as a promise of the parsed body. */
function responds(response: { status: number; json?: unknown }) {
  const promise = Promise.resolve(response) as Promise<unknown> & { json: Promise<unknown> }
  promise.json = Promise.resolve(response.json)
  return promise
}

function rejects(error: Error) {
  const promise = Promise.reject(error) as Promise<unknown> & { json: Promise<unknown> }
  promise.catch(() => undefined)
  const json = Promise.reject(error)
  json.catch(() => undefined)
  promise.json = json
  return promise
}

beforeEach(() => {
  requestUrl.mockReset()
})

describe('fetchStore', () => {
  test('clears loading when the request throws', async () => {
    requestUrl.mockReturnValue(rejects(new Error('Request failed, status 500')))

    const store = fetchStore<unknown[]>('https://example.invalid/group/shares', 'jwt')
    await store.get().catch(() => undefined)

    expect(readStore(store.loading)).toBe(false)
  })

  test('reports a failed request instead of failing silently', async () => {
    requestUrl.mockReturnValue(rejects(new Error('net::ERR_CONNECTION_REFUSED')))

    const store = fetchStore<unknown[]>('https://example.invalid/group/shares', 'jwt')
    await store.get().catch(() => undefined)

    expect(readStore(store.error)).toEqual(expect.stringContaining('reach'))
  })

  test('names an expired login rather than a generic failure', async () => {
    requestUrl.mockReturnValue(responds({ status: 401 }))

    const store = fetchStore<unknown[]>('https://example.invalid/group/shares', 'jwt')
    await store.get().catch(() => undefined)

    expect(readStore(store.loading)).toBe(false)
    expect(readStore(store.error)).toEqual(expect.stringContaining('log in'))
  })

  test('reports a server error with its status', async () => {
    requestUrl.mockReturnValue(responds({ status: 503 }))

    const store = fetchStore<unknown[]>('https://example.invalid/group/shares', 'jwt')
    await store.get().catch(() => undefined)

    expect(readStore(store.error)).toEqual(expect.stringContaining('503'))
  })

  test('drops the previous list so a stale one is never shown as current', async () => {
    requestUrl.mockReturnValue(responds({ status: 200, json: [{ publicAccessKey: 'a', type: 'DOCUMENT' }] }))
    const store = fetchStore<unknown[]>('https://example.invalid/group/shares', 'jwt')
    await store.get()
    expect(readStore(store.data)).toHaveLength(1)

    requestUrl.mockReturnValue(responds({ status: 500 }))
    await store.get().catch(() => undefined)

    expect(readStore(store.data)).toBeNull()
  })

  test('still loads the share list on success', async () => {
    const shares = [{ publicAccessKey: 'abc', type: 'FOLDER' }]
    requestUrl.mockReturnValue(responds({ status: 200, json: shares }))

    const store = fetchStore<unknown[]>('https://example.invalid/group/shares', 'jwt')
    await store.get()

    expect(readStore(store.data)).toEqual(shares)
    expect(readStore(store.loading)).toBe(false)
    expect(readStore(store.error)).toBeNull()
  })
})
