import { describe, it, expect } from '@jest/globals'
import { isBinaryContent } from './fileTypeDetection'

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const PDF_HEADER = new TextEncoder().encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')

describe('isBinaryContent', () => {
  it('treats JSON content as text', async () => {
    const jsonContent = new TextEncoder().encode('{"test": true}')
    expect(await isBinaryContent(jsonContent, 'test.json')).toBe(false)
  })

  it('detects binary content by magic bytes', async () => {
    expect(await isBinaryContent(PNG_HEADER, 'header.png')).toBe(true)
    expect(await isBinaryContent(PDF_HEADER, 'paper.pdf')).toBe(true)
  })

  it('believes the bytes over a misleading extension', async () => {
    expect(await isBinaryContent(PNG_HEADER, 'notes.md')).toBe(true)
  })

  it('accepts an ArrayBuffer as readily as a Uint8Array', async () => {
    const buffer = PNG_HEADER.slice().buffer
    expect(await isBinaryContent(buffer, 'header.png')).toBe(true)
  })

  it('should detect binary files by extension fallback', async () => {
    const emptyContent = new Uint8Array(0)
    expect(await isBinaryContent(emptyContent, 'image.png')).toBe(true)
    expect(await isBinaryContent(emptyContent, 'document.pdf')).toBe(true)
  })

  it('should detect text files by extension fallback', async () => {
    const emptyContent = new Uint8Array(0)
    expect(await isBinaryContent(emptyContent, 'note.md')).toBe(false)
    expect(await isBinaryContent(emptyContent, 'data.json')).toBe(false)
  })

  describe('text formats without a signature or a listed extension', () => {
    const BASE_FILE = new TextEncoder().encode(
      'filters:\n  and:\n    - file.hasLink(this.file)\nviews:\n  - type: list\n    name: Backlinks ❖\n'
    )

    it('stores a .base file as text', async () => {
      expect(await isBinaryContent(BASE_FILE, 'db Backlinks (scoped).base')).toBe(false)
    })

    it('stores an empty .base file as text', async () => {
      expect(await isBinaryContent(new Uint8Array(0), 'new.base')).toBe(false)
    })

    it('stores other unlisted text formats as text', async () => {
      const tex = new TextEncoder().encode('\\section{Intro}\nCafé ✓\n')
      expect(await isBinaryContent(tex, 'paper.tex')).toBe(false)
      expect(await isBinaryContent(tex, 'Makefile')).toBe(false)
    })

    it('keeps content with NUL bytes binary', async () => {
      const bytes = new Uint8Array([0x61, 0x62, 0x00, 0x63])
      expect(await isBinaryContent(bytes, 'data.dat')).toBe(true)
    })

    it('keeps invalid UTF-8 binary', async () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x41, 0x42])
      expect(await isBinaryContent(bytes, 'data.dat')).toBe(true)
    })

    it('does not split a multi-byte character at the end of the sample', async () => {
      const text = new TextEncoder().encode('a'.repeat(8191) + '❖' + ' tail')
      expect(await isBinaryContent(text, 'long.base')).toBe(false)
      expect(await isBinaryContent(text, 'long.unlisted')).toBe(false)
    })

    it('keeps known attachment extensions binary even when the bytes are text', async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      expect(await isBinaryContent(svg, 'diagram.svg')).toBe(true)
    })

    it('keeps unlisted files over 1 MiB as attachments', async () => {
      const big = new Uint8Array(1024 * 1024 + 1).fill(0x61)
      expect(await isBinaryContent(big, 'huge.log')).toBe(true)
    })

    it('leaves empty files with an unlisted extension as attachments', async () => {
      expect(await isBinaryContent(new Uint8Array(0), 'blank.dat')).toBe(true)
    })
  })
})
