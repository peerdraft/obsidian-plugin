import type { App, PluginManifest } from 'obsidian'
import type { Settings } from '../settings'
import { migrateSettings, saveSettingsNow } from '../settings'
import { promptForName } from '../ui/enterText'
import { showNotice } from '../ui'

// Exercise the actual plugin's load hook; substitute Obsidian UI, transports,
// settings storage and editor integrations. The lifecycle ordering is real.
jest.mock('../settings', () => ({
  migrateSettings: jest.fn(), createSettingsTab: jest.fn(() => ({})),
  saveSettings: jest.fn(), saveSettingsNow: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../ui/enterText', () => ({ promptForName: jest.fn(), promptForURL: jest.fn() }))
jest.mock('../cookie', () => ({ prepareCommunication: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../login', () => ({ getJWT: jest.fn() }))
jest.mock('../activeStreamClient', () => ({ ActiveStreamClient: class { destroy(): void {} } }))
jest.mock('../peerdraftWebSocketProvider', () => ({
  PeerdraftWebsocketProvider: class {
    on(): void {}
    connect(): void {}
    connected(): Promise<void> { return new Promise<void>(() => {}) }
    destroy(): void {}
  },
}))
jest.mock('../serverAPI', () => ({ ServerAPI: class {} }))
jest.mock('../signalingSocketGuard', () => ({ installSignalingSocketGuard: () => () => {} }))
jest.mock('../sharedEntities/sharedDocument', () => ({ SharedDocument: {
  getAll: () => [], findByPath: () => undefined,
} }))
jest.mock('../sharedEntities/sharedFolder', () => ({ SharedFolder: {
  getAll: () => [], findByPath: () => undefined,
} }))
jest.mock('../sharedEntities/sharedEntityFactory', () => ({}))
jest.mock('../sharedEntities/renameWithinFolder', () => ({}))
jest.mock('../ui', () => ({ showNotice: jest.fn() }))
jest.mock('../utils/fileTypeDetection', () => ({}))
jest.mock('../ui/chooseSessionType', () => ({}))
jest.mock('../ui/createMenu', () => ({}))
jest.mock('../ui/shareView', () => ({ PEERDRAFT_SHARE_VIEW_TYPE: 'peerdraft-share-view', PeerdraftShareView: class {} }))
jest.mock('../workspace/peerdraftLeaf', () => ({}))
jest.mock('../workspace/peerdraftWorkspace', () => ({ updatePeerdraftWorkspace: jest.fn() }))
jest.mock('../workspace/explorerView', () => ({
  setStatusClasses: jest.fn().mockResolvedValue(undefined), removeStatusClass: jest.fn(),
}))

const PeerdraftPlugin = (require(process.env.PEERDRAFT_PLUGIN_TEST_MODULE ?? '../peerdraftPlugin') as typeof import('../peerdraftPlugin')).default
const prompt = jest.mocked(promptForName)
const save = jest.mocked(saveSettingsNow)

function settings(name = ''): Settings {
  return {
    name, oid: 'test-vault', basePath: 'http://localhost:5174',
    signaling: 'ws://localhost:5174/signal', sync: 'ws://localhost:5174/sync',
    actives: 'ws://localhost:5174/actives', subscriptionAPI: '', connectAPI: '', sessionAPI: '',
    plan: { type: 'Free' }, root: '', duration: 0, debug: false, version: '2.24.0',
    serverShares: { files: new Map(), folders: new Map() },
  }
}

function fixture(layoutReady = false, name = '') {
  const pendingLayout: Array<() => unknown> = []
  const disposers: Array<() => void> = []
  const onLayoutReady = jest.fn((callback: () => unknown): void => {
    if (layoutReady) callback()
    else pendingLayout.push(callback)
  })
  const plugin = new PeerdraftPlugin({} as App, { version: '2.24.0' } as PluginManifest)
  const addSettingTab = jest.fn()
  Object.assign(plugin, {
    app: { workspace: { onLayoutReady, on: jest.fn() }, vault: { on: jest.fn() } },
    manifest: { version: '2.24.0' },
    register: (dispose: () => void): void => { disposers.push(dispose) },
    registerEvent: jest.fn(), registerView: jest.fn(), addRibbonIcon: jest.fn(),
    addCommand: jest.fn(), registerObsidianProtocolHandler: jest.fn(), addSettingTab,
  })
  jest.mocked(migrateSettings).mockResolvedValue(settings(name))
  return {
    plugin, addSettingTab,
    openWorkspace: (): void => {
      layoutReady = true
      for (const callback of pendingLayout.splice(0)) callback()
    },
    unload: (): void => {
      plugin.onunload()
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  jest.clearAllMocks()
  prompt.mockReset()
  prompt.mockImplementation(() => new Promise(() => {}))
  save.mockReset().mockResolvedValue(undefined)
})

it('returns from onload before a cold workspace can display the name prompt', async () => {
  const f = fixture()
  let loaded = false
  void f.plugin.onload().then(() => { loaded = true })
  await flush()

  expect(loaded).toBe(true)
  expect(f.addSettingTab).toHaveBeenCalledTimes(1)
  expect(prompt).not.toHaveBeenCalled()
  f.openWorkspace()
  await flush()
  expect(prompt).toHaveBeenCalledTimes(1)
  f.unload()
})

it('returns from onload when the workspace is ready but the name prompt never completes', async () => {
  const f = fixture(true)
  let loaded = false
  void f.plugin.onload().then(() => { loaded = true })
  await flush()

  expect(prompt).toHaveBeenCalledTimes(1)
  expect(loaded).toBe(true)
  expect(f.addSettingTab).toHaveBeenCalledTimes(1)
  f.unload()
})

it('does not prompt when the stored name is already set', async () => {
  const f = fixture(true, 'Existing name')
  await f.plugin.onload()
  expect(prompt).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  f.unload()
})

it('skips a queued prompt if a name is set before layout readiness', async () => {
  const f = fixture()
  await f.plugin.onload()
  f.plugin.settings.name = 'From settings'
  f.openWorkspace()
  expect(prompt).not.toHaveBeenCalled()
  f.unload()
})

it('does not overwrite a name set while the prompt was pending', async () => {
  const f = fixture(true)
  let answer: (value: { text: string }) => void = () => {}
  prompt.mockReturnValue(new Promise(resolve => { answer = resolve }))
  await f.plugin.onload()
  f.plugin.settings.name = 'From settings'
  answer({ text: 'Stale prompt' })
  await flush()
  expect(f.plugin.settings.name).toBe('From settings')
  expect(save).not.toHaveBeenCalled()
  f.unload()
})

it('saves a confirmed name once after loading has completed', async () => {
  const f = fixture()
  let answer: (value: { text: string } | void) => void = () => {}
  prompt.mockReturnValue(new Promise(resolve => { answer = resolve }))
  await f.plugin.onload()
  f.openWorkspace()
  answer({ text: 'Dominik' })
  await flush()

  expect(f.plugin.settings.name).toBe('Dominik')
  expect(save).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledWith(f.plugin.settings, f.plugin)
  f.unload()
})

it.each([undefined, { text: '' }])('does not save a dismissed or empty name (%p)', async answer => {
  const f = fixture(true)
  prompt.mockResolvedValue(answer)
  await f.plugin.onload()
  await flush()
  expect(f.plugin.settings.name).toBe('')
  expect(save).not.toHaveBeenCalled()
  f.unload()
})

it('does not open the deferred prompt after unload', async () => {
  const f = fixture()
  await f.plugin.onload()
  f.unload()
  f.openWorkspace()
  expect(prompt).not.toHaveBeenCalled()
})

it('does not mutate or save the name if the answer arrives after unload', async () => {
  const f = fixture(true)
  let answer: (value: { text: string }) => void = () => {}
  prompt.mockReturnValue(new Promise(resolve => { answer = resolve }))
  await f.plugin.onload()
  f.unload()
  answer({ text: 'Too late' })
  await flush()
  expect(f.plugin.settings.name).toBe('')
  expect(save).not.toHaveBeenCalled()
})

it.each(['prompt', 'save'])('reports a %s failure without rejecting onload', async stage => {
  const f = fixture(true)
  const error = new Error('Name operation failed')
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  if (stage === 'prompt') prompt.mockRejectedValue(error)
  else {
    prompt.mockResolvedValue({ text: 'Dominik' })
    save.mockRejectedValue(error)
  }
  try {
    await expect(f.plugin.onload()).resolves.toBeUndefined()
    await flush()
    expect(log).toHaveBeenCalledWith('[Peerdraft] Could not set the display name', error)
    expect(showNotice).toHaveBeenCalledTimes(1)
  } finally {
    f.unload()
    log.mockRestore()
  }
})

it('does not show a stale error if the name prompt fails after unload', async () => {
  const f = fixture(true)
  let fail: (error: Error) => void = () => {}
  prompt.mockReturnValue(new Promise((_resolve, reject) => { fail = reject }))
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await f.plugin.onload()
    f.unload()
    fail(new Error('Late prompt failure'))
    await flush()
    expect(log).not.toHaveBeenCalled()
    expect(showNotice).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})
