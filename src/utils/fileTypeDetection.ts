/**
 * Binary file extensions that should be synced
 * Covers common binary formats: images, documents, audio, video, archives
 */
const BINARY_FILE_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
  // Video
  'mp4', 'avi', 'mov', 'wmv', 'mkv', 'webm',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
  // Other
  'epub', 'mobi', 'djvu', 'psd', 'ai', 'sketch'
])

/**
 * Check if a file is a binary file based on extension
 * @param filename File name or path
 * @returns true if file is a binary type
 */
export function isBinaryFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase()
  if (!extension) return false
  return BINARY_FILE_EXTENSIONS.has(extension)
}

/**
 * MIME type mapping for common file extensions
 */
const MIME_TYPE_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  wmv: 'video/x-ms-wmv',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  bz2: 'application/x-bzip2',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  djvu: 'image/vnd.djvu',
  psd: 'image/vnd.adobe.photoshop',
  ai: 'application/postscript',
  sketch: 'application/octet-stream'
}

/**
 * Get MIME type from filename
 * @param filename File name or path
 * @returns MIME type string, defaults to 'application/octet-stream'
 */
export function getMimeType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase()
  if (!extension) return 'application/octet-stream'
  return MIME_TYPE_MAP[extension] || 'application/octet-stream'
}
