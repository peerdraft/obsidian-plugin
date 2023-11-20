export const createRandomId = (): string => {
 return window.crypto.randomUUID()
}

export const randomUint32 = (): number => {
  return window.crypto.getRandomValues(new Uint32Array(1))[0];
}