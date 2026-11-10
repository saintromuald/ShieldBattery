/** Returns the separator used for new path segments in an absolute or relative file path. */
export function filePathSeparator(filePath: string): '/' | '\\' {
  if (filePath.startsWith('/')) {
    return '/'
  }
  return filePath.includes('\\') ? '\\' : '/'
}

/** Joins path segments without assuming the host uses Windows path separators. */
export function joinFilePath(base: string, ...parts: string[]): string {
  const separator = filePathSeparator(base)
  let result = base.replace(/[/\\]+$/, '')
  for (const part of parts) {
    const cleaned = part.replace(/^[/\\]+|[/\\]+$/g, '')
    if (cleaned) {
      result += `${separator}${cleaned}`
    }
  }
  return result || (separator === '/' ? '/' : base)
}

/** Returns the parent directory, preserving POSIX and drive-letter roots. */
export function getFileDirectory(filePath: string): string {
  const separatorAt = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (separatorAt < 0) {
    return ''
  }
  if (separatorAt === 0) {
    return filePath[0]
  }
  if (separatorAt === 2 && filePath[1] === ':') {
    return filePath.slice(0, 3)
  }
  return filePath.slice(0, separatorAt)
}

/** Returns the final path segment, ignoring trailing separators. */
export function filePathBaseName(filePath: string): string {
  const trimmed = filePath.replace(/[/\\]+$/, '')
  return trimmed.replace(/^.*[/\\]/, '') || trimmed
}

/** Tests whether a path is a root itself or one of its descendants. */
export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const windowsPath = /^[a-z]:[\\/]/i.test(rootPath) || rootPath.startsWith('\\\\')
  const root = windowsPath ? rootPath.toLowerCase() : rootPath
  const candidate = windowsPath ? candidatePath.toLowerCase() : candidatePath
  const trimmedRoot = root.replace(/[/\\]+$/, '')
  return (
    candidate === trimmedRoot ||
    candidate.startsWith(`${trimmedRoot}/`) ||
    candidate.startsWith(`${trimmedRoot}\\`)
  )
}
