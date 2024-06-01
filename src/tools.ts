import { Platform } from 'obsidian';

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

export const normalizePathPD = (() => {
  if (Platform.isWin) {
    return (path: string) => {
      return path.split('\\').join('/')
    }
  } else {
    return (path: string) => {
      return path
    }
  }
})()