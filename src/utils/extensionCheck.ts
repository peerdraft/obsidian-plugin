/**
 * Simple extension-based binary file detection
 * Used as fallback when magic bytes detection fails
 */

const TEXT_EXTENSIONS = [
  'md', 'txt', 'json', 'xml', 'html', 'htm', 'css', 
  'js', 'ts', 'jsx', 'tsx', 'csv', 'yaml', 'yml', 'canvas'
]

/**
 * Check if a file is likely binary based on its extension
 * @param filename File name or path
 * @returns true if file is likely binary based on extension
 */
export function isBinaryByExtension(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase()
  return extension ? !TEXT_EXTENSIONS.includes(extension) : true
}
