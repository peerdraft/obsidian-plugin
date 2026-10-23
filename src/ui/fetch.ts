import { requestUrl } from 'obsidian'
import { writable } from 'svelte/store'

/**
 * A store for one GET endpoint, exposing the request's progress as `loading`,
 * its failure as a readable `error` message, and its body as `data`.
 *
 * `loading` is cleared in a `finally` rather than on the success path. It used
 * to be set false only after a successful parse, with no try/catch around
 * `requestUrl` — and `requestUrl` throws on any 400+ status (its `throw`
 * option defaults to true). So an expired token or a server hiccup left the
 * store loading forever: the share panel span with no error and no way for
 * anyone to find out why.
 */
export default function <T>(url: string, token?: string) {
	const loading = writable(false)
	const error = writable<string | null>(null)
	const data = writable<T | null>(null)

	async function get(): Promise<boolean> {
		loading.set(true)
		error.set(null)

		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				contentType: "application/json",
				headers: {
					"Authorization": "Bearer " + token
				},
				// Read the status rather than throwing on it: an expired login is a
				// different thing to tell someone than a server that is down, and
				// only the status tells the two apart.
				throw: false
			})

			if (response.status === 401 || response.status === 403) {
				error.set("Your Peerdraft login has expired. Please log in again in the Peerdraft settings.")
				data.set(null)
				return false
			}

			if (response.status >= 400) {
				error.set(`The server could not be reached for your shares (error ${response.status}).`)
				data.set(null)
				return false
			}

			// `requestUrl` types the parsed body as `any`; this endpoint's shape is
			// the caller's `T`.
			data.set(response.json as T)
			return true
		} catch {
			// Network-level failure — offline, DNS, TLS. `throw: false` suppresses
			// status errors, not these.
			error.set("Could not reach the Peerdraft server. Please check your connection.")
			data.set(null)
			return false
		} finally {
			// Every path clears the spinner, including the ones added later.
			loading.set(false)
		}
	}

	void get()

	return { data, loading, error, get }
}
