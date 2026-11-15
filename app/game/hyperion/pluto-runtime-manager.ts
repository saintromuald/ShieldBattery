import os from 'node:os'
import path from 'node:path'
import {
  METALSHARP_WINE_VERSION,
  PLUTO_MACOS_DOWNLOAD_BYTES,
  PLUTO_RUNTIME_DOWNLOAD_BYTES,
  PLUTO_RUNTIME_VERSION,
  type PlutoRuntimeOperation,
  type PlutoRuntimeState,
} from '../../../common/pluto-runtime'
import type { ReleaseProgress } from '../../../common/release-center'
import { errorMessage } from '../../releases/storage'
import { embeddedHyperionPaths, type EmbeddedHyperionPaths } from './install'
import {
  installPlutoRuntime,
  type InstallPlutoRuntimeOptions,
  isPlutoRuntimeInstalled,
  PLUTO_PAYLOAD_SHA256,
  type ResolvePlutoBridgeOptions,
  resolvePlutoBridgePath,
} from './pluto-runtime-installer'
import {
  isMetalSharpWineInstalled,
  type MacCommandRunner,
  metalSharpWineAppPath,
} from './pluto-wine-runtime'

export interface PlutoRuntimeManagerOptions {
  appPath: string
  userDataPath: string
  clientVersion: string
  sessionName?: string
  platform?: NodeJS.Platform
  architecture?: string
  systemVersion?: string
  homeDirectory?: string
  onChange?: (state: PlutoRuntimeState) => void
  fetch?: typeof globalThis.fetch
  installRuntime?: (options: InstallPlutoRuntimeOptions) => Promise<void>
  readDownloadedInstall?: ResolvePlutoBridgeOptions['readDownloadedInstall']
  isWineRuntimeInstalled?: typeof isMetalSharpWineInstalled
  wineCommandRunner?: MacCommandRunner
}

function supportsPlutoRuntime(
  platform: NodeJS.Platform,
  architecture: string,
  systemVersion?: string,
): boolean {
  if ((platform === 'linux' || platform === 'win32') && architecture === 'x64') return true
  if (platform !== 'darwin' || architecture !== 'arm64' || !systemVersion) return false
  const parts = systemVersion.split('.').map(Number)
  return (
    parts.length >= 2 &&
    parts.every(part => Number.isSafeInteger(part) && part >= 0) &&
    (parts[0] > 26 || (parts[0] === 26 && parts[1] >= 4))
  )
}

function unsupportedReason(
  platform: NodeJS.Platform,
  architecture: string,
  systemVersion?: string,
): string {
  if (platform === 'darwin' && architecture === 'arm64') {
    return `Pluto AI installation on Apple Silicon requires macOS 26.4 or later. This system is macOS ${systemVersion || 'unknown'}.`
  }
  return `Pluto AI installation is available on Linux x64, Windows x64, and Apple Silicon macOS 26.4 or later only. This system is ${platform} ${architecture}.`
}

/** Serializes explicit downloads and repairs of the runtime used by Hyperion's `--data` folder. */
export class PlutoRuntimeManager {
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly systemVersion?: string
  private readonly usesMetalSharpWine: boolean
  private readonly wineAppPath?: string
  private readonly installRuntime: (options: InstallPlutoRuntimeOptions) => Promise<void>
  private readonly isWineRuntimeInstalled: typeof isMetalSharpWineInstalled
  private readonly paths?: EmbeddedHyperionPaths
  private state: PlutoRuntimeState
  private initialization?: Promise<PlutoRuntimeState>
  private queue: Promise<void> = Promise.resolve()
  private lastProgressEmit = 0

  constructor(private readonly options: PlutoRuntimeManagerOptions) {
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.systemVersion =
      options.systemVersion ??
      (this.platform === 'darwin' && typeof process.getSystemVersion === 'function'
        ? process.getSystemVersion()
        : undefined)
    this.usesMetalSharpWine = this.platform === 'darwin' && this.architecture === 'arm64'
    this.wineAppPath = this.usesMetalSharpWine
      ? metalSharpWineAppPath(options.homeDirectory ?? os.homedir())
      : undefined
    this.installRuntime = options.installRuntime ?? installPlutoRuntime
    this.isWineRuntimeInstalled = options.isWineRuntimeInstalled ?? isMetalSharpWineInstalled
    const supported = supportsPlutoRuntime(this.platform, this.architecture, this.systemVersion)
    const reason = supported
      ? undefined
      : unsupportedReason(this.platform, this.architecture, this.systemVersion)
    this.paths = supported
      ? embeddedHyperionPaths(
          options.appPath,
          options.userDataPath,
          options.sessionName ?? process.env.SB_SESSION,
          this.platform,
          this.architecture,
        )
      : undefined
    this.state = {
      version: PLUTO_RUNTIME_VERSION,
      supported,
      installed: false,
      installPath: this.paths ? path.join(this.paths.dataPath, 'pluto') : undefined,
      operation: supported ? 'checking' : 'idle',
      statusMessage: reason,
      unsupportedReason: reason,
      downloadBytes:
        this.usesMetalSharpWine && supported
          ? PLUTO_MACOS_DOWNLOAD_BYTES
          : PLUTO_RUNTIME_DOWNLOAD_BYTES,
      usesMetalSharpWine: this.usesMetalSharpWine && supported,
    }
  }

  /** Checks local hashes and signatures only. Merely opening the UI never starts a download. */
  initialize(): Promise<PlutoRuntimeState> {
    this.initialization ??= this.initializeLocalState()
    return this.initialization
  }

  private async initializeLocalState(): Promise<PlutoRuntimeState> {
    if (!this.paths) {
      this.emitChange()
      return this.getState()
    }

    this.setOperation('checking', 'Checking the Pluto AI installation…')
    const payloadsInstalled = await isPlutoRuntimeInstalled(
      path.join(this.paths.dataPath, 'pluto'),
      PLUTO_PAYLOAD_SHA256,
      this.platform,
    )
    const wineInstalled = this.wineAppPath
      ? await this.isWineRuntimeInstalled(this.wineAppPath, this.options.wineCommandRunner)
      : true
    const installed = payloadsInstalled && wineInstalled
    this.state.installed = installed
    this.state.downloadBytes = wineInstalled
      ? PLUTO_RUNTIME_DOWNLOAD_BYTES
      : PLUTO_MACOS_DOWNLOAD_BYTES
    let statusMessage: string
    if (installed) {
      statusMessage = this.usesMetalSharpWine
        ? `Pluto AI ${PLUTO_RUNTIME_VERSION} and MetalSharp Wine ${METALSHARP_WINE_VERSION} are installed and verified.`
        : `Pluto AI ${PLUTO_RUNTIME_VERSION} is installed and verified.`
    } else if (!this.usesMetalSharpWine) {
      statusMessage = 'Pluto AI is not installed. Download it to enable Pluto opponents.'
    } else if (wineInstalled) {
      statusMessage =
        'MetalSharp Wine is installed and verified. Download Pluto AI to enable Pluto opponents.'
    } else {
      statusMessage =
        'Pluto AI or its MetalSharp Wine dependency is missing or damaged. Download or repair both to enable Pluto opponents.'
    }
    this.setOperation('idle', statusMessage)
    return this.getState()
  }

  getState(): PlutoRuntimeState {
    return structuredClone(this.state)
  }

  private emitChange(): void {
    this.options.onChange?.(this.getState())
  }

  private setOperation(
    operation: PlutoRuntimeOperation,
    statusMessage?: string,
    progress?: ReleaseProgress,
  ): void {
    this.state.operation = operation
    this.state.statusMessage = statusMessage
    this.state.progress = progress
    this.emitChange()
  }

  private setProgress(progress: ReleaseProgress): void {
    const now = Date.now()
    if (now - this.lastProgressEmit >= 100 || progress.bytesTransferred === progress.totalBytes) {
      this.lastProgressEmit = now
      this.state.progress = progress
      this.emitChange()
    }
  }

  /** Runs only after the user activates Download/Repair; concurrent requests are serialized. */
  async install(): Promise<PlutoRuntimeState> {
    await this.initialize()
    const result = this.queue.then(async () => {
      if (!this.paths) {
        this.setOperation(
          'error',
          unsupportedReason(this.platform, this.architecture, this.systemVersion),
        )
        return
      }
      try {
        this.setOperation('checking', 'Checking Hyperion’s Pluto AI bridge…')
        const activeBridgePath = await resolvePlutoBridgePath({
          appPath: this.options.appPath,
          userDataPath: this.options.userDataPath,
          sessionName: this.options.sessionName,
          platform: this.platform,
          architecture: this.architecture,
          readDownloadedInstall: this.options.readDownloadedInstall,
        })
        if (this.wineAppPath) {
          this.setOperation('checking', 'Checking MetalSharp Wine’s signature and runtime…')
        }
        const wineInstalled = this.wineAppPath
          ? await this.isWineRuntimeInstalled(this.wineAppPath, this.options.wineCommandRunner)
          : true
        const installMetalSharpWine = this.wineAppPath && !wineInstalled
        const downloadBytes = installMetalSharpWine
          ? PLUTO_MACOS_DOWNLOAD_BYTES
          : PLUTO_RUNTIME_DOWNLOAD_BYTES
        this.state.downloadBytes = downloadBytes
        this.setOperation(
          'downloading',
          installMetalSharpWine
            ? `Downloading MetalSharp Wine ${METALSHARP_WINE_VERSION} and Pluto AI ${PLUTO_RUNTIME_VERSION} from their official GitHub releases…`
            : `Downloading Pluto AI ${PLUTO_RUNTIME_VERSION} from the official GitHub release…`,
          { bytesTransferred: 0, totalBytes: downloadBytes },
        )
        await this.installRuntime({
          dataPath: this.paths.dataPath,
          installPath: path.join(this.paths.dataPath, 'pluto'),
          activeBridgePath,
          clientVersion: this.options.clientVersion,
          fetchImpl: this.options.fetch,
          installMetalSharpWine: installMetalSharpWine
            ? {
                destination: this.wineAppPath!,
                runner: this.options.wineCommandRunner,
              }
            : undefined,
          onProgress: progress => this.setProgress(progress),
          onDownloaded: () => {
            this.setOperation(
              'installing',
              installMetalSharpWine
                ? 'Verifying and installing MetalSharp Wine and Pluto AI…'
                : 'Verifying and installing Pluto AI…',
            )
          },
        })
        this.state.installed = true
        this.state.downloadBytes = PLUTO_RUNTIME_DOWNLOAD_BYTES
        this.setOperation(
          'idle',
          this.usesMetalSharpWine
            ? `Pluto AI ${PLUTO_RUNTIME_VERSION} and MetalSharp Wine ${METALSHARP_WINE_VERSION} are installed and verified.`
            : `Pluto AI ${PLUTO_RUNTIME_VERSION} is installed and verified.`,
        )
      } catch (error) {
        this.setOperation('error', errorMessage(error))
      }
    })
    this.queue = result.catch(() => {})
    return result.then(() => this.getState())
  }
}
