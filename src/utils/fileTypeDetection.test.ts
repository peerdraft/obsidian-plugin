import { describe, it, expect } from '@jest/globals'
import { isBinaryContent } from './fileTypeDetection'

describe('isBinaryContent', () => {
  it('should detect text files by magic bytes', async () => {
    // JSON file
    const jsonContent = new TextEncoder().encode('{"test": true}')
    expect(await isBinaryContent(jsonContent, 'test.json')).toBe(false)
  })

  it('should detect binary files by extension fallback', async () => {
    // Empty content - no magic bytes
    const emptyContent = new Uint8Array(0)
    expect(await isBinaryContent(emptyContent, 'image.png')).toBe(true)
    expect(await isBinaryContent(emptyContent, 'document.pdf')).toBe(true)
  })

  it('should detect text files by extension fallback', async () => {
    // Empty content - no magic bytes
    const emptyContent = new Uint8Array(0)
    expect(await isBinaryContent(emptyContent, 'note.md')).toBe(false)
    expect(await isBinaryContent(emptyContent, 'data.json')).toBe(false)
  })
})
