import { createHash } from 'crypto'

/**
 * Calculate SHA-256 hash of file content
 * @param arrayBuffer File content as ArrayBuffer
 * @returns Hex string representation of hash
 */
export function calculateFileHash(arrayBuffer: ArrayBuffer): string {
  const uint8Array = new Uint8Array(arrayBuffer)
  const hash = createHash('sha256').update(uint8Array).digest('hex')
  return hash
}
