import { requestUrl } from 'obsidian'
import { writable } from 'svelte/store'

export default function <T>(url: string, token?: string) {
	const loading = writable(false)
	const error = writable(false)
	const data = writable<T | null>(null)

	async function get() {
		loading.set(true)
		error.set(false)

		const response = await requestUrl({
			url,
			method: 'GET',
			contentType: "application/json",
			headers: {
				"Authorization": "Bearer " + token
			}
		}).json

		data.set(response)
		loading.set(false)

	
		if (!response) {
			error.set(true)
		}
		return true
	}

	get()

	return { data, loading, error, get }
}