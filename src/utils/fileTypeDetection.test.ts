import { describe, it, expect } from '@jest/globals'
import { isBinaryFile, getMimeType } from './fileTypeDetection'

describe('isBinaryFile', () => {
  it('should return true for image files', () => {
    expect(isBinaryFile('photo.png')).toBe(true)
    expect(isBinaryFile('photo.jpg')).toBe(true)
    expect(isBinaryFile('photo.jpeg')).toBe(true)
    expect(isBinaryFile('animation.gif')).toBe(true)
  })

  it('should return true for document files', () => {
    expect(isBinaryFile('document.pdf')).toBe(true)
    expect(isBinaryFile('report.docx')).toBe(true)
  })

  it('should return true for audio files', () => {
    expect(isBinaryFile('music.mp3')).toBe(true)
    expect(isBinaryFile('sound.wav')).toBe(true)
  })

  it('should return true for video files', () => {
    expect(isBinaryFile('movie.mp4')).toBe(true)
    expect(isBinaryFile('clip.avi')).toBe(true)
  })

  it('should return true for archive files', () => {
    expect(isBinaryFile('archive.zip')).toBe(true)
    expect(isBinaryFile('backup.tar.gz')).toBe(true)
  })

  it('should return false for text files', () => {
    expect(isBinaryFile('note.md')).toBe(false)
    expect(isBinaryFile('script.js')).toBe(false)
    expect(isBinaryFile('styles.css')).toBe(false)
    expect(isBinaryFile('data.json')).toBe(false)
  })

  it('should return false for files without extension', () => {
    expect(isBinaryFile('README')).toBe(false)
  })
})

describe('getMimeType', () => {
  it('should return correct MIME type for images', () => {
    expect(getMimeType('photo.png')).toBe('image/png')
    expect(getMimeType('photo.jpg')).toBe('image/jpeg')
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg')
  })

  it('should return correct MIME type for documents', () => {
    expect(getMimeType('document.pdf')).toBe('application/pdf')
    expect(getMimeType('report.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('should return default MIME type for unknown extensions', () => {
    expect(getMimeType('unknown.xyz')).toBe('application/octet-stream')
  })

  it('should return default MIME type for files without extension', () => {
    expect(getMimeType('README')).toBe('application/octet-stream')
  })
})
