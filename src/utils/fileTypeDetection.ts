import { fileTypeFromBuffer } from 'file-type'

/**
 * Text MIME type prefixes - files with these MIME types are synced as text via Y.Text
 */
const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript'
]

/**
 * Detect if file content should be synced as binary based on MIME type
 * Uses magic bytes detection via file-type library, falls back to extension
 * @param content File content as ArrayBuffer or Uint8Array
 * @param filename Filename for fallback extension-based detection
 * @returns true if file should be synced as binary (S3), false for text (Y.Text)
 */
export async function isBinaryContent(content: ArrayBuffer | Uint8Array, filename: string): Promise<boolean> {
  try {
    // Convert ArrayBuffer to Uint8Array if needed
    const buffer = content instanceof ArrayBuffer ? new Uint8Array(content) : content
    
    // Try magic bytes detection
    const fileType = await fileTypeFromBuffer(buffer)
    if (fileType) {
      // File type detected via magic bytes
      return !TEXT_MIME_PREFIXES.some(prefix => fileType.mime.startsWith(prefix))
    }
    
    // Fallback: simple extension check for common text files
    const textExtensions = ['md', 'txt', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'csv', 'yaml', 'yml', 'canvas']
    const extension = filename.split('.').pop()?.toLowerCase()
    const isTextExtension = extension ? textExtensions.includes(extension) : false
    return !isTextExtension
  } catch (error) {
    console.error('[fileTypeDetection] Error detecting file type:', error)
    // On error, assume binary to be safe
    return true
  }
}

/**
 * Synchronous binary file detection based on extension
 * Used ONLY for quick filtering in old dead code - prefer isBinaryContent
 * @param filename File name or path
 * @returns true if file is likely binary based on extension
 */
export function isBinaryFile(filename: string): boolean {
  // Simple heuristic: common text file extensions
  const textExtensions = ['md', 'txt', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'csv', 'yaml', 'yml', 'canvas']
  const extension = filename.split('.').pop()?.toLowerCase()
  return extension ? !textExtensions.includes(extension) : true
}
