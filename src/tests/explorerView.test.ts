import type { WorkspaceLeaf } from 'obsidian'
import type PeerdraftPlugin from '../peerdraftPlugin'
import { removeStatusClass, setStatusClass, setStatusClasses } from '../workspace/explorerView'

interface ExplorerView {
  getViewType: () => string
  fileItems: Record<string, { innerEl: HTMLElement }>
}

interface ExplorerLeaf {
  view: ExplorerView
  loadIfDeferred: jest.Mock<Promise<void>, []>
}

function createItem(...classes: string[]): HTMLElement {
  const element = document.createElement('div')
  element.addClass = (...names: string[]): void => { element.classList.add(...names) }
  element.removeClass = (...names: string[]): void => { element.classList.remove(...names) }
  element.classList.add(...classes)
  return element
}

function createExplorer(items: Record<string, HTMLElement>): ExplorerLeaf {
  const fileItems: ExplorerView['fileItems'] = {}
  for (const [path, innerEl] of Object.entries(items)) fileItems[path] = { innerEl }
  return {
    view: { getViewType: () => 'file-explorer', fileItems },
    loadIfDeferred: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  }
}

function createPlugin(leaves: ExplorerLeaf[]): {
  plugin: PeerdraftPlugin
  iterateAllLeaves: jest.Mock<void, [(leaf: WorkspaceLeaf) => void]>
} {
  const iterateAllLeaves = jest.fn<void, [(leaf: WorkspaceLeaf) => void]>(callback => {
    for (const leaf of leaves) callback(leaf as unknown as WorkspaceLeaf)
  })
  // Obsidian owns the remaining plugin/workspace implementation; these are
  // the only methods the explorer adapter is allowed to use.
  const plugin = { app: { workspace: { iterateAllLeaves } } } as unknown as PeerdraftPlugin
  return { plugin, iterateAllLeaves }
}

describe('explorer status batches', () => {
  test('waits until a deferred explorer exposes its file items', async () => {
    const item = createItem()
    const explorer = createExplorer({})
    let finishLoading: () => void = () => {}
    explorer.loadIfDeferred.mockImplementation(() => new Promise<void>(resolve => {
      finishLoading = () => {
        explorer.view.fileItems['Shared/note.md'] = { innerEl: item }
        resolve()
      }
    }))
    const { plugin } = createPlugin([explorer])
    let completed = false
    const pending = setStatusClasses(['Shared/note.md'], plugin, 'syncing').then(() => {
      completed = true
    })

    await Promise.resolve()
    expect(completed).toBe(false)
    expect(item.classList.contains('pd-status-syncing')).toBe(false)

    finishLoading()
    await pending

    expect(item.classList.contains('pd-status-syncing')).toBe(true)
    expect(item.title).toBe('Syncing - Synchronizing with Peerdraft')
  })

  test('paints every path in every explorer with one discovery per batch', async () => {
    const firstFile = createItem()
    const firstFolder = createItem()
    const secondFile = createItem()
    const secondFolder = createItem()
    const first = createExplorer({ 'Shared/note.md': firstFile, Shared: firstFolder })
    const second = createExplorer({ 'Shared/note.md': secondFile, Shared: secondFolder })
    // A leaf can appear twice in manually traversed layouts. Load it once.
    const { plugin, iterateAllLeaves } = createPlugin([first, first, second])
    function* paths(): Iterable<string> {
      yield 'Shared/note.md'
      yield 'Shared'
    }

    await setStatusClasses(paths(), plugin, 'syncing')

    for (const item of [firstFile, firstFolder, secondFile, secondFolder]) {
      expect(item.classList.contains('pd-status-syncing')).toBe(true)
    }
    expect(iterateAllLeaves).toHaveBeenCalledTimes(1)
    expect(first.loadIfDeferred).toHaveBeenCalledTimes(1)
    expect(second.loadIfDeferred).toHaveBeenCalledTimes(1)
  })

  test('paints a ready explorer without waiting for another deferred explorer', async () => {
    const delayedItem = createItem()
    const readyItem = createItem()
    const delayed = createExplorer({ 'note.md': delayedItem })
    let finishLoading: () => void = () => {}
    delayed.loadIfDeferred.mockReturnValue(new Promise<void>(resolve => { finishLoading = resolve }))
    const { plugin } = createPlugin([delayed, createExplorer({ 'note.md': readyItem })])

    const painting = setStatusClasses(['note.md'], plugin, 'syncing')
    await Promise.resolve()
    expect(readyItem.classList.contains('pd-status-syncing')).toBe(true)
    expect(delayedItem.classList.contains('pd-status-syncing')).toBe(false)
    finishLoading()
    await painting
    expect(delayedItem.classList.contains('pd-status-syncing')).toBe(true)
  })

  test.each(['new status', 'removal'])('does not overwrite a %s with an older deferred update', async action => {
    const item = createItem()
    const explorer = createExplorer({ 'note.md': item })
    let finishFirstLoading: () => void = () => {}
    explorer.loadIfDeferred.mockReturnValueOnce(new Promise<void>(resolve => { finishFirstLoading = resolve }))
    const { plugin } = createPlugin([explorer])
    const stalePaint = setStatusClass('note.md', plugin, 'syncing')

    if (action === 'new status') await setStatusClass('note.md', plugin, 'insync')
    else await removeStatusClass('note.md', plugin)
    finishFirstLoading()
    await stalePaint

    expect(item.classList.contains('pd-status-syncing')).toBe(false)
    expect(item.classList.contains('pd-status-insync')).toBe(action === 'new status')
  })

  test('logs failed explorer loading and still paints healthy explorers', async () => {
    const failedItem = createItem()
    const healthyItem = createItem()
    const failed = createExplorer({ 'note.md': failedItem })
    const healthy = createExplorer({ 'note.md': healthyItem })
    const failure = new Error('Deferred explorer failed to load')
    failed.loadIfDeferred.mockRejectedValue(failure)
    const { plugin } = createPlugin([failed, healthy])
    const reportError = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(setStatusClasses(['note.md'], plugin, 'syncing')).resolves.toBeUndefined()

      expect(healthyItem.classList.contains('pd-status-syncing')).toBe(true)
      expect(failedItem.classList.contains('pd-status-syncing')).toBe(false)
      expect(reportError).toHaveBeenCalledWith(
        '[Peerdraft] Could not load a file explorer for status updates.', failure,
      )
    } finally {
      reportError.mockRestore()
    }
  })

  test('skips missing paths without skipping later paths or other explorers', async () => {
    const firstItem = createItem()
    const secondItem = createItem()
    const { plugin } = createPlugin([
      createExplorer({ 'first.md': firstItem }),
      createExplorer({ 'second.md': secondItem }),
    ])

    await setStatusClasses(['missing.md', 'first.md', 'second.md'], plugin, 'syncing')

    expect(firstItem.classList.contains('pd-status-syncing')).toBe(true)
    expect(secondItem.classList.contains('pd-status-syncing')).toBe(true)
  })

  test('replaces every old status and the shared icon while preserving unrelated classes', async () => {
    const item = createItem(
      'unrelated', 'pd-explorer-shared', 'pd-status-offline', 'pd-status-syncing',
      'pd-status-insync', 'pd-status-warning', 'pd-status-disconnected', 'pd-status-connected',
    )
    item.title = 'Old status'
    const { plugin } = createPlugin([createExplorer({ 'note.md': item })])

    await setStatusClass('note.md', plugin, 'insync')

    expect(Array.from(item.classList)).toEqual(['unrelated', 'pd-status-insync'])
    expect(item.title).toBe('In sync - Synchronized with Peerdraft')
  })

  test('clears a previous status and tooltip when the document is not initialized', async () => {
    const item = createItem('pd-status-warning')
    item.title = 'Old warning'
    const { plugin } = createPlugin([createExplorer({ 'note.md': item })])

    await setStatusClasses(['note.md'], plugin, 'not-initialized')

    expect(item.classList.length).toBe(0)
    expect(item.hasAttribute('title')).toBe(false)
  })

  test('uses the supplied failure tooltip instead of describing an offline connection', async () => {
    const item = createItem()
    const { plugin } = createPlugin([createExplorer({ 'note.md': item })])

    await setStatusClass('note.md', plugin, 'warning', 'Could not initialize this share.')

    expect(item.title).toBe('Could not initialize this share.')
    expect(item.classList.contains('pd-status-warning')).toBe(true)
  })

  test('clearing status preserves a separate shared icon and unrelated classes', async () => {
    const item = createItem('pd-explorer-shared', 'pd-status-syncing', 'unrelated')
    item.title = 'Syncing'
    const { plugin } = createPlugin([createExplorer({ 'note.md': item })])

    await removeStatusClass('note.md', plugin)

    expect(Array.from(item.classList)).toEqual(['pd-explorer-shared', 'unrelated'])
    expect(item.hasAttribute('title')).toBe(false)
  })

  test('ignores non-explorer leaves and handles an absent explorer', async () => {
    const editor = createExplorer({})
    editor.view.getViewType = () => 'markdown'
    const { plugin } = createPlugin([editor])

    await expect(setStatusClasses(['note.md'], plugin, 'syncing')).resolves.toBeUndefined()
    expect(editor.loadIfDeferred).not.toHaveBeenCalled()
  })
})
