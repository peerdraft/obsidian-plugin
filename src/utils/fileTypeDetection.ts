import { fileTypeFromBuffer } from 'file-type'

const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript'
]

/** Extensions that are always stored as text documents, even when the content has no recognisable signature. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'txt', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'csv', 'yaml', 'yml', 'canvas', 'base'
])

const EXTENSION_MIME_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Text documents are held in a Yjs document, so this matches the limit in SharedDocument.fromTFile. */
const MAX_SNIFFED_TEXT_BYTES = 1 * 1024 * 1024
const SNIFF_BYTES = 8192

function getExtension(filename: string): string | undefined {
  if (!filename.includes('.')) return undefined
  return filename.split('.').pop()?.toLowerCase()
}

/** True when the start of the content is valid UTF-8 without NUL bytes, which is how git tells text from binary. */
function looksLikeText(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, SNIFF_BYTES)
  if (sample.includes(0)) return false
  try {
    // stream: true tolerates a multi-byte character cut off at the end of the sample
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
    return true
  } catch {
    return false
  }
}

/**
 * Decides whether a file is stored as a binary attachment (true) or a text document (false).
 * Order: file signature, then extension lists, then the content itself. The last step lets
 * text formats we have never heard of, such as `.base`, `.tex` or `.bib`, sync as text.
 */
export async function isBinaryContent(content: ArrayBuffer | Uint8Array, filename: string): Promise<boolean> {
  try {
    const buffer = content instanceof ArrayBuffer ? new Uint8Array(content) : content

    const fileType = await fileTypeFromBuffer(buffer)
    if (fileType) {
      return !TEXT_MIME_PREFIXES.some(prefix => fileType.mime.startsWith(prefix))
    }

    const extension = getExtension(filename)
    if (extension && TEXT_EXTENSIONS.has(extension)) return false
    // Images such as SVG are text on disk but belong with the attachments
    if (extension && extension in EXTENSION_MIME_MAP) return true

    if (buffer.length === 0 || buffer.length > MAX_SNIFFED_TEXT_BYTES) return true
    return !looksLikeText(buffer)
  } catch (error) {
    console.error('[fileTypeDetection] Error detecting file type:', error)
    return true
  }
}

export function isBinaryFile(filename: string): boolean {
  const extension = getExtension(filename)
  return extension ? !TEXT_EXTENSIONS.has(extension) : true
}

export function getMimeTypeFromExtension(filename: string): string {
  const extension = getExtension(filename)
  if (extension && EXTENSION_MIME_MAP[extension]) {
    return EXTENSION_MIME_MAP[extension]
  }
  return 'application/octet-stream'
}
