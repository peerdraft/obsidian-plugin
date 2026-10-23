/**
 * Calculate SHA-256 hash of file content using the standard Web Crypto API
 * (available in Obsidian's Electron and mobile runtimes alike, unlike Node's
 * `crypto` module which mobile does not provide).
 * @param arrayBuffer File content as ArrayBuffer
 * @returns Hex string representation of hash
 */
export async function calculateFileHash(arrayBuffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
