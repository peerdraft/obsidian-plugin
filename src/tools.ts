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

export const checkIndexedDBAlreadyExists = async (dbName: string): Promise<boolean> => {
  if (typeof indexedDB?.databases === 'function') {
    try {
      const dbs = await indexedDB.databases()
      return dbs.some(db => db.name === dbName)
    } catch (error) {
    }
  }

  return new Promise((resolve) => {
    let existed = true
    const request = indexedDB.open(dbName)
    request.onupgradeneeded = () => {
      existed = false
    }
    request.onsuccess = () => {
      const db = request.result
      db.close()
      if (!existed) {
        indexedDB.deleteDatabase(dbName)
      }
      resolve(existed)
    }
    request.onerror = () => resolve(false)
  })
}