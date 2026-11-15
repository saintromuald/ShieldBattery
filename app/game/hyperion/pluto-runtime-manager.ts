import path from 'node:path'
import {
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

export interface PlutoRuntimeManagerOptions {
  appPath: string
  userDataPath: string
  clientVersion: string
  sessionName?: string
  platform?: NodeJS.Platform
  architecture?: string
  onChange?: (state: PlutoRuntimeState) => void
  fetch?: typeof globalThis.fetch
  installRuntime?: (options: InstallPlutoRuntimeOptions) => Promise<void>
  readDownloadedInstall?: ResolvePlutoBridgeOptions['readDownloadedInstall']
}

function supportsPlutoRuntime(platform: NodeJS.Platform, architecture: string): boolean {
  return (platform === 'linux' || platform === 'win32') && architecture === 'x64'
}

function unsupportedReason(platform: NodeJS.Platform, architecture: string): string {
  return `Pluto AI installation is available on Linux x64 and Windows x64 only. This system is ${platform} ${architecture}.`
}

/** Serializes explicit downloads and repairs of the runtime used by Hyperion's `--data` folder. */
export class PlutoRuntimeManager {
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly installRuntime: (options: InstallPlutoRuntimeOptions) => Promise<void>
  private readonly paths?: EmbeddedHyperionPaths
  private state: PlutoRuntimeState
  private initialization?: Promise<PlutoRuntimeState>
  private queue: Promise<void> = Promise.resolve()
  private lastProgressEmit = 0

  constructor(private readonly options: PlutoRuntimeManagerOptions) {
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.installRuntime = options.installRuntime ?? installPlutoRuntime
    const supported = supportsPlutoRuntime(this.platform, this.architecture)
    const reason = supported ? undefined : unsupportedReason(this.platform, this.architecture)
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
    }
  }

  /** Checks local hashes only. Merely opening the UI never starts a Pluto download. */
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
    const installed = await isPlutoRuntimeInstalled(
      path.join(this.paths.dataPath, 'pluto'),
      PLUTO_PAYLOAD_SHA256,
      this.platform,
    )
    this.state.installed = installed
    this.setOperation(
      'idle',
      installed
        ? `Pluto AI ${PLUTO_RUNTIME_VERSION} is installed and verified.`
        : 'Pluto AI is not installed. Download it to enable Pluto opponents.',
    )
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
        this.setOperation('error', unsupportedReason(this.platform, this.architecture))
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
        this.setOperation(
          'downloading',
          `Downloading Pluto AI ${PLUTO_RUNTIME_VERSION} from the official GitHub release…`,
          { bytesTransferred: 0, totalBytes: PLUTO_RUNTIME_DOWNLOAD_BYTES },
        )
        await this.installRuntime({
          dataPath: this.paths.dataPath,
          installPath: path.join(this.paths.dataPath, 'pluto'),
          activeBridgePath,
          clientVersion: this.options.clientVersion,
          fetchImpl: this.options.fetch,
          onProgress: progress => this.setProgress(progress),
          onDownloaded: () => {
            this.setOperation('installing', 'Verifying and installing Pluto AI…')
          },
        })
        this.state.installed = true
        this.setOperation('idle', `Pluto AI ${PLUTO_RUNTIME_VERSION} is installed and verified.`)
      } catch (error) {
        this.setOperation('error', errorMessage(error))
      }
    })
    this.queue = result.catch(() => {})
    return result.then(() => this.getState())
  }
}
