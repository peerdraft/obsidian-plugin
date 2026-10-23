import { describe, it, expect } from '@jest/globals'
import { calculateFileHash } from './hashCalculation'

describe('calculateFileHash', () => {
  it('should calculate SHA-256 hash of ArrayBuffer', async () => {
    const data = new TextEncoder().encode('test content')
    const hash = await calculateFileHash(data.buffer)

    // SHA-256 of "test content"
    expect(hash).toBe('6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72')
  })

  it('should return same hash for same content', async () => {
    const data = new TextEncoder().encode('same content')
    const hash1 = await calculateFileHash(data.buffer)
    const hash2 = await calculateFileHash(data.buffer)

    expect(hash1).toBe(hash2)
  })

  it('should return different hash for different content', async () => {
    const data1 = new TextEncoder().encode('content 1')
    const data2 = new TextEncoder().encode('content 2')

    const hash1 = await calculateFileHash(data1.buffer)
    const hash2 = await calculateFileHash(data2.buffer)

    expect(hash1).not.toBe(hash2)
  })
})
