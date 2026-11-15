import path from 'node:path'

export const MAC_HYPERION_EXECUTABLE_PATH = path.join(
  'Hyperion.app',
  'Contents',
  'MacOS',
  'Hyperion',
)
export const MAC_HYPERION_LIBRARY_NAME = 'libSDL3.0.dylib'

export function hyperionExecutablePath(platform: NodeJS.Platform, architecture: string): string {
  if (platform === 'win32') {
    if (architecture === 'x64') {
      return 'Hyperion.exe'
    }
    throw new Error('HyperShield is not available on this processor architecture yet.')
  }
  if (platform === 'darwin') {
    if (architecture === 'arm64') {
      return MAC_HYPERION_EXECUTABLE_PATH
    }
    throw new Error('HyperShield is not available on this processor architecture yet.')
  }
  if (platform !== 'linux') {
    throw new Error('HyperShield is not available on this operating system yet.')
  }
  if (architecture === 'x64') {
    return 'Hyperion.x86_64'
  }
  if (architecture === 'arm64') {
    return 'Hyperion.aarch64'
  }
  throw new Error('HyperShield is not available on this processor architecture yet.')
}

/** The public Mac package keeps Data beside Hyperion.app, not inside its Contents directory. */
export function hyperionWorkingDirectory(
  executablePath: string,
  platform: NodeJS.Platform,
): string {
  return platform === 'darwin'
    ? path.resolve(path.dirname(executablePath), '../../..')
    : path.dirname(executablePath)
}

export function hyperionLibraryPath(
  executablePath: string,
  workingDirectory: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'darwin') {
    return path.join(path.dirname(executablePath), MAC_HYPERION_LIBRARY_NAME)
  }
  return path.join(workingDirectory, platform === 'win32' ? 'SDL3.dll' : 'libSDL3.so.0')
}
