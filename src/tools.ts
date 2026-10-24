import * as XXH from 'xxhashjs'


export const createRandomId = (): string => {
  return window.crypto.randomUUID()
}

export const randomUint32 = (): number => {
  return window.crypto.getRandomValues(new Uint32Array(1))[0];
}

export const generateRandomString = function () {
  return Math.random().toString(20).substring(2, 8)
}

export const calculateHash = (text: string) => { return XXH.h32(text, 0xABCD).toString(16) }

export const serialize = (obj: any): string => {
  if (Array.isArray(obj)) {
    return `[${obj.map(el => serialize(el)).join(',')}]`
  } else if (typeof obj === 'object' && obj !== null) {
    let acc = ''
    const keys = Object.keys(obj).sort()
    acc += `{${JSON.stringify(keys)}`
    for (let i = 0; i < keys.length; i++) {
      acc += `${serialize(obj[keys[i]])},`
    }
    return `${acc}}`
  }
  return `${JSON.stringify(obj)}`
}

const inFlightDatabaseNames = new WeakMap<IDBFactory, Promise<Set<string>>>()

/** Share only an in-flight enumeration; never retain a potentially stale database list. */
const currentDatabaseNames = (factory: IDBFactory): Promise<Set<string>> => {
  const existing = inFlightDatabaseNames.get(factory)
  if (existing) return existing
  const pending = Promise.resolve().then(() => factory.databases()).then(databases => {
    const names = new Set<string>()
    for (const database of databases) if (database.name !== undefined) names.add(database.name)
    return names
  })
  inFlightDatabaseNames.set(factory, pending)
  const clear = (): void => {
    if (inFlightDatabaseNames.get(factory) === pending) inFlightDatabaseNames.delete(factory)
  }
  void pending.then(clear, clear)
  return pending
}

export const checkIndexedDBAlreadyExists = async (dbName: string): Promise<boolean> => {
  const factory = globalThis.indexedDB
  if (!factory) return false
  if (typeof factory.databases === 'function') {
    try {
      return (await currentDatabaseNames(factory)).has(dbName)
    } catch (error) {
    }
  }

  return new Promise((resolve) => {
    let existed = true
    const request = factory.open(dbName)
    request.onupgradeneeded = () => {
      existed = false
    }
    request.onsuccess = () => {
      const db = request.result
      db.close()
      if (!existed) {
        factory.deleteDatabase(dbName)
      }
      resolve(existed)
    }
    request.onerror = () => resolve(false)
  })
}
