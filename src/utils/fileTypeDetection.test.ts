import { describe, it, expect } from '@jest/globals'
import { isBinaryByExtension } from './extensionCheck'

/**
 * NOTE: We cannot test isBinaryContent() from fileTypeDetection.ts because it imports 'file-type',
 * which is a pure ESM module that Jest cannot handle.
 * 
 * The magic bytes detection is provided by the well-tested 'file-type' library.
 * Our code just calls it and falls back to extension checking.
 * 
 * We test the extension fallback logic here, which is used when magic bytes detection fails.
 */

describe('Extension-Based Binary Detection', () => {
  it('should detect binary files by extension', () => {
    expect(isBinaryByExtension('image.png')).toBe(true)
    expect(isBinaryByExtension('photo.jpg')).toBe(true)
    expect(isBinaryByExtension('document.pdf')).toBe(true)
    expect(isBinaryByExtension('video.mp4')).toBe(true)
    expect(isBinaryByExtension('archive.zip')).toBe(true)
  })

  it('should detect text files by extension', () => {
    expect(isBinaryByExtension('note.md')).toBe(false)
    expect(isBinaryByExtension('data.json')).toBe(false)
    expect(isBinaryByExtension('file.txt')).toBe(false)
    expect(isBinaryByExtension('style.css')).toBe(false)
    expect(isBinaryByExtension('script.js')).toBe(false)
    expect(isBinaryByExtension('code.ts')).toBe(false)
    expect(isBinaryByExtension('page.html')).toBe(false)
    expect(isBinaryByExtension('config.yaml')).toBe(false)
    expect(isBinaryByExtension('diagram.canvas')).toBe(false)
  })

  it('should treat unknown extensions as binary', () => {
    expect(isBinaryByExtension('unknown.xyz')).toBe(true)
    expect(isBinaryByExtension('file.unknown')).toBe(true)
  })

  it('should treat files without extension as binary', () => {
    expect(isBinaryByExtension('README')).toBe(true)
    expect(isBinaryByExtension('Makefile')).toBe(true)
  })

  it('should be case-insensitive', () => {
    expect(isBinaryByExtension('IMAGE.PNG')).toBe(true)
    expect(isBinaryByExtension('Note.MD')).toBe(false)
    expect(isBinaryByExtension('File.TXT')).toBe(false)
  })
})

/**
 * Magic bytes detection (isBinaryContent) is tested in production.
 * The file-type library itself is well-tested and we're just calling it.
 * 
 * Integration test: Create a real PNG file in Obsidian vault and verify it syncs as binary.
 */
