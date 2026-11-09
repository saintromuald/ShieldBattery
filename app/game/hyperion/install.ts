import { app } from 'electron'
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readSelectedHyperionInstall } from '../../releases/storage'
import { HyperionInstall, parseHyperionInstall } from './launch'

const IDENTITY_TIMEOUT_MS = 20_000
const IDENTITY_MAX_OUTPUT_BYTES = 64 * 1024

export interface EmbeddedHyperionPaths {
  executablePath: string
  dataPath: string
  workingDirectory: string
}

export type HyperionIdentityProbe = (
  executablePath: string,
  dataPath: string,
  workingDirectory: string,
  gameDataPath?: string,
) => Promise<unknown>

export interface EmbeddedHyperionInstallOptions {
  appPath?: string
  userDataPath?: string
  sessionName?: string
  platform?: NodeJS.Platform
  architecture?: string
  gameDataPath?: string
  probe?: HyperionIdentityProbe
  readDownloadedInstall?: typeof readSelectedHyperionInstall
}

function executableName(platform: NodeJS.Platform, architecture: string): string {
  if (platform === 'win32') {
    if (architecture === 'x64') {
      return 'Hyperion.exe'
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

function sessionDataName(sessionName: string | undefined): string {
  if (!sessionName) {
    return 'hyperion'
  }
  const cleaned = sessionName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return `hyperion-${cleaned || 'session'}`
}

export function embeddedHyperionPaths(
  appPath: string,
  userDataPath: string,
  sessionName?: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): EmbeddedHyperionPaths {
  const workingDirectory = path.resolve(appPath, '..', 'hyperion')
  return {
    executablePath: path.join(workingDirectory, executableName(platform, architecture)),
    dataPath: path.join(userDataPath, sessionDataName(sessionName)),
    workingDirectory,
  }
}

/** Runs the same installation that will play the match, without creating a game or visible window. */
export async function probeHyperionIdentity(
  executablePath: string,
  dataPath: string,
  workingDirectory: string,
  gameDataPath?: string,
): Promise<unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, HYPERION_WINDOW: 'hidden' }
  delete env.HYPERION_SB_EVENTS
  delete env.HYPERION_SB_RESULT_CODE

  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      executablePath,
      [
        '--sb-identity',
        '--data',
        dataPath,
        ...(gameDataPath ? ['--install-folder', gameDataPath] : []),
      ],
      {
        cwd: workingDirectory,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: IDENTITY_TIMEOUT_MS,
        maxBuffer: IDENTITY_MAX_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              'HyperShield could not find a usable StarCraft installation. Install or repair StarCraft, then try again.',
              { cause: error },
            ),
          )
        } else {
          resolve(stdout)
        }
      },
    )
  })

  try {
    return JSON.parse(output.trim())
  } catch (error) {
    throw new Error('HyperShield returned an invalid compatibility response.', { cause: error })
  }
}

/** Resolves the shipped engine and its actual game-data compatibility without player-created files. */
export async function readEmbeddedHyperionInstall(
  options: EmbeddedHyperionInstallOptions = {},
): Promise<HyperionInstall> {
  const appPath = options.appPath ?? app.getAppPath()
  const userDataPath = options.userDataPath ?? app.getPath('userData')
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const bundledPaths = embeddedHyperionPaths(
    appPath,
    userDataPath,
    options.sessionName ?? process.env.SB_SESSION,
    platform,
    architecture,
  )
  const downloaded = await (options.readDownloadedInstall ?? readSelectedHyperionInstall)(
    userDataPath,
    platform,
    architecture,
  )
  const downloadedPaths = downloaded
    ? {
        ...bundledPaths,
        executablePath: downloaded.executablePath,
        workingDirectory: downloaded.workingDirectory,
      }
    : undefined

  const probeInstall = async (paths: EmbeddedHyperionPaths): Promise<HyperionInstall> => {
    try {
      await fs.mkdir(paths.dataPath, { recursive: true, mode: 0o700 })
      const [, library, data] = await Promise.all([
        fs.access(paths.executablePath, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK),
        fs.stat(
          path.join(paths.workingDirectory, platform === 'win32' ? 'SDL3.dll' : 'libSDL3.so.0'),
        ),
        fs.stat(path.join(paths.workingDirectory, 'Data')),
      ])
      if (!library.isFile() || !data.isDirectory()) {
        throw new Error('Hyperion executable dependencies have invalid file types')
      }
    } catch (error) {
      throw new Error(
        'HyperShield is not installed correctly. Reinstall HyperShield and try again.',
        {
          cause: error,
        },
      )
    }

    const compatibility = await (options.probe ?? probeHyperionIdentity)(
      paths.executablePath,
      paths.dataPath,
      paths.workingDirectory,
      options.gameDataPath,
    )
    return parseHyperionInstall({
      ...paths,
      ...(options.gameDataPath ? { gameDataPath: options.gameDataPath } : {}),
      compatibility,
    })
  }

  if (downloadedPaths) {
    try {
      return await probeInstall(downloadedPaths)
    } catch (error) {
      if (!downloaded?.fromLatestTracking) {
        throw error
      }
    }
  }
  return probeInstall(bundledPaths)
}
