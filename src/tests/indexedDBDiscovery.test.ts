import { checkIndexedDBAlreadyExists } from '../tools'

interface OpenRequest {
  result: { close: jest.Mock }
  onupgradeneeded: (() => void) | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

function createFactory(databases?: () => Promise<IDBDatabaseInfo[]>) {
  const requests: OpenRequest[] = []
  const open = jest.fn(() => {
    const request: OpenRequest = {
      result: { close: jest.fn() }, onupgradeneeded: null, onsuccess: null, onerror: null,
    }
    requests.push(request)
    return request
  })
  const deleteDatabase = jest.fn()
  const factory = { open, deleteDatabase, databases } as unknown as IDBFactory
  return { factory, open, deleteDatabase, requests }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
function useFactory(factory: IDBFactory): void {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: factory })
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'indexedDB', original)
  else Reflect.deleteProperty(globalThis, 'indexedDB')
})

test('1000 concurrent startup checks share one enumeration and preserve every existence result', async () => {
  let finish: (value: IDBDatabaseInfo[]) => void = () => {}
  const databases = jest.fn(() => new Promise<IDBDatabaseInfo[]>(resolve => { finish = resolve }))
  const f = createFactory(databases)
  useFactory(f.factory)
  const pending = Array.from({ length: 1000 }, (_, index) => checkIndexedDBAlreadyExists('cache-' + index))
  await Promise.resolve()
  expect(databases).toHaveBeenCalledTimes(1)
  finish(Array.from({ length: 500 }, (_, index) => ({ name: 'cache-' + index * 2, version: 1 })))
  const results = await Promise.all(pending)
  expect(results).toEqual(Array.from({ length: 1000 }, (_, index) => index % 2 === 0))
  expect(f.open).not.toHaveBeenCalled()
})

test('checks after completion enumerate afresh and see newly created databases', async () => {
  const databases = jest.fn<Promise<IDBDatabaseInfo[]>, []>()
    .mockResolvedValueOnce([{ name: 'old' }])
    .mockResolvedValueOnce([{ name: 'old' }, { name: 'new' }])
  const f = createFactory(databases)
  useFactory(f.factory)
  await expect(checkIndexedDBAlreadyExists('new')).resolves.toBe(false)
  await expect(checkIndexedDBAlreadyExists('new')).resolves.toBe(true)
  expect(databases).toHaveBeenCalledTimes(2)
})

test('different IndexedDB factories do not share an in-flight database list', async () => {
  let finishFirst: (value: IDBDatabaseInfo[]) => void = () => {}
  const firstNames = jest.fn(() => new Promise<IDBDatabaseInfo[]>(resolve => { finishFirst = resolve }))
  const secondNames = jest.fn().mockResolvedValue([{ name: 'second' }])
  const first = createFactory(firstNames)
  const second = createFactory(secondNames)
  useFactory(first.factory)
  const pending = checkIndexedDBAlreadyExists('first')
  await Promise.resolve()
  useFactory(second.factory)
  await expect(checkIndexedDBAlreadyExists('first')).resolves.toBe(false)
  finishFirst([{ name: 'first' }])
  await expect(pending).resolves.toBe(true)
  expect(firstNames).toHaveBeenCalledTimes(1)
  expect(secondNames).toHaveBeenCalledTimes(1)
})

test('a rejected enumeration falls back per database and later enumeration can recover', async () => {
  const databases = jest.fn<Promise<IDBDatabaseInfo[]>, []>()
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce([{ name: 'present' }])
  const f = createFactory(databases)
  useFactory(f.factory)
  const pending = checkIndexedDBAlreadyExists('present')
  for (let index = 0; index < 5; index++) await Promise.resolve()
  expect(f.open).toHaveBeenCalledWith('present')
  f.requests[0].onsuccess?.()
  await expect(pending).resolves.toBe(true)
  expect(f.requests[0].result.close).toHaveBeenCalledTimes(1)
  expect(f.deleteDatabase).not.toHaveBeenCalled()
  await expect(checkIndexedDBAlreadyExists('present')).resolves.toBe(true)
  expect(databases).toHaveBeenCalledTimes(2)
})

test('fallback discovery deletes only the temporary database it had to create', async () => {
  const f = createFactory()
  useFactory(f.factory)
  const missing = checkIndexedDBAlreadyExists('missing')
  f.requests[0].onupgradeneeded?.()
  f.requests[0].onsuccess?.()
  await expect(missing).resolves.toBe(false)
  expect(f.requests[0].result.close).toHaveBeenCalledTimes(1)
  expect(f.deleteDatabase.mock.calls).toEqual([['missing']])

  const present = checkIndexedDBAlreadyExists('present')
  f.requests[1].onsuccess?.()
  await expect(present).resolves.toBe(true)
  expect(f.deleteDatabase.mock.calls).toEqual([['missing']])
})

test('fallback open errors report no cache rather than leaving startup pending', async () => {
  const f = createFactory()
  useFactory(f.factory)
  const pending = checkIndexedDBAlreadyExists('unreadable')
  f.requests[0].onerror?.()
  await expect(pending).resolves.toBe(false)
  expect(f.deleteDatabase).not.toHaveBeenCalled()
})
