<script lang="ts">
	import type PeerdraftPlugin from "src/peerdraftPlugin";
	import { getJWT } from "src/login";
	import fetchStore from "./fetch";
	import { SharedFolder } from "src/sharedEntities/sharedFolder";
	import { SharedDocument } from "src/sharedEntities/sharedDocument";

	interface ApiReply {
		publicAccessKey: string;
		type: "DOCUMENT" | "FOLDER";
	}

	export let plugin: PeerdraftPlugin;

	const url = plugin.settings.basePath + "/group/shares";

	const jwt = getJWT(plugin.settings.oid);
	const { data, loading, error, get } = fetchStore<Array<ApiReply>>(
		url,
		jwt ?? undefined,
	);

	let folders: Array<{
		name: string;
		docIds: Array<string>;
		url: string;
		localPath?: string;
		id: string;
	}> = [];

	let documents: Array<{
		name: string;
		id: string;
		url: string;
		localPath?: string;
	}> = [];

	data.subscribe(async (newData) => {
		const inFolders: Array<string> = [];
		if (newData instanceof Array) {
			const folderData = newData.filter((entry) => {
				return entry.type === "FOLDER";
			});
			folders = await Promise.all(
				folderData.map(async (entry) => {
					const synced = SharedFolder.findById(entry.publicAccessKey);
					if (synced) {
						const docIds = Array.from(synced.getDocsFragment().keys());
						inFolders.push(...docIds);
						return {
							name: synced.getOriginalFolderName(),
							docIds,
							url: synced.getShareURL(),
							localPath: synced.path,
							id: synced.shareId,
						};
					}

					const doc = await plugin.serverSync.requestDocument(
						entry.publicAccessKey,
					);
					const name = doc.getText("originalFoldername").toString();
					const docIds = Array.from(doc.getMap("documents").keys());
					inFolders.push(...docIds);
					return {
						name,
						docIds,
						url: plugin.settings.basePath + "/team/" + entry.publicAccessKey,
						id: entry.publicAccessKey,
					};
				}),
			);
			console.log(inFolders);
			const documentData = newData.filter((entry) => {
				return (
					entry.type === "DOCUMENT" &&
					!inFolders.includes(entry.publicAccessKey)
				);
			});

			documents = await Promise.all(
				documentData.map(async (entry) => {
					const sharedDoc = SharedDocument.findById(entry.publicAccessKey);
					if (sharedDoc)
						return {
							name: "TBD",
							id: entry.publicAccessKey,
							url: sharedDoc.getShareURL(),
							localPath: sharedDoc.path,
						};
					const doc = await plugin.serverSync.requestDocument(
						entry.publicAccessKey,
					);
					return {
						name: doc.getText("originalFilename").toString(),
						id: entry.publicAccessKey,
						url: plugin.settings.basePath + "/cm/" + entry.publicAccessKey
					}
				}),
			);

			console.log(documentData);
			console.log(folders);
		}
	});
</script>

<h1>List of active persistent Peerdraft Shares you created</h1>
<button on:click={get}>Refresh</button>

{#if $loading}
	<div class="ripple-container">
		<div class="lds-ripple">
			<div></div>
			<div></div>
		</div>
	</div>
{:else if $error}
	Error: {$error}
{:else}
	<h2>Folders you are sharing</h2>
	<ul>
		{#each folders as folder}
			<li><a href={folder.url}>{folder.name}</a> ({folder.docIds.length} files)
				{#if folder.localPath}
					(in this vault as {folder.localPath})
				{:else}
					<button
						on:click={async () => {
							await SharedFolder.fromShareURL(folder.url, plugin);
							get();
						}}>Import</button
					>
				{/if}
				<button
					on:click={async () => {
						await SharedFolder.stopSession(folder.id, plugin);
						get();
					}}>Stop Sharing</button
				>
			</li>
		{/each}
	</ul>
	<h2>Single Documents you are sharing</h2>
	<ul>
		{#each documents as doc}
			<li><a href={doc.url}>{doc.name}</a>
				{#if doc.localPath}
				(in this vault as {doc.localPath})
			{:else}
				<button
					on:click={async () => {
						await SharedDocument.fromShareURL(doc.url, plugin)
						get();
					}}>Import</button
				>
			{/if}
			<button
			on:click={async () => {
				await SharedDocument.stopSession(doc.id, plugin);
				get();
			}}>Stop Sharing</button
		>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.ripple-container {
		width: 100%;
		height: 100%;
		display: flex;
		justify-content: center;
		align-items: center;
	}

	.lds-ripple,
	.lds-ripple div {
		box-sizing: border-box;
	}
	.lds-ripple {
		display: inline-block;
		position: relative;
		width: 80px;
		height: 80px;
	}
	.lds-ripple div {
		position: absolute;
		border: 4px solid currentColor;
		opacity: 1;
		border-radius: 50%;
		animation: lds-ripple 1s cubic-bezier(0, 0.2, 0.8, 1) infinite;
	}
	.lds-ripple div:nth-child(2) {
		animation-delay: -0.5s;
	}
	@keyframes lds-ripple {
		0% {
			top: 36px;
			left: 36px;
			width: 8px;
			height: 8px;
			opacity: 0;
		}
		4.9% {
			top: 36px;
			left: 36px;
			width: 8px;
			height: 8px;
			opacity: 0;
		}
		5% {
			top: 36px;
			left: 36px;
			width: 8px;
			height: 8px;
			opacity: 1;
		}
		100% {
			top: 0;
			left: 0;
			width: 80px;
			height: 80px;
			opacity: 0;
		}
	}
</style>
