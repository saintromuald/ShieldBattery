import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { compare, valid } from 'semver'
import {
  type ProductReleaseState,
  RELEASE_PRODUCTS,
  type ReleaseCenterState,
  type ReleaseChannel,
  type ReleaseInfo,
  type ReleaseOperation,
  type ReleaseProduct,
  type ReleaseProgress,
} from '../../common/release-center'
import {
  fetchReleaseCatalog,
  normalizeReleaseVersion,
  RELEASE_SOURCES,
  type ReleaseFetch,
} from './catalog'
import { installDownloadedRelease } from './installer'
import {
  defaultReleasePreferences,
  emptyInstalledRegistry,
  errorMessage,
  installedReleaseExecutable,
  type InstalledReleaseRecord,
  type InstalledReleaseRegistry,
  readInstalledRegistry,
  readProductCatalogCache,
  readReleasePreferences,
  releaseCenterPath,
  type ReleasePreferences,
  supportsReleaseInstallation,
  validateInstalledRelease,
  writeInstalledRegistry,
  writeProductCatalogCache,
  writeReleasePreferences,
} from './storage'

export interface ReleaseManagerOptions {
  appPath: string
  userDataPath: string
  clientVersion: string
  platform?: NodeJS.Platform
  architecture?: string
  onChange?: (state: ReleaseCenterState) => void
  /** Dependency injection for tests and alternate GitHub transports. */
  fetch?: ReleaseFetch
}

interface ProductRuntime {
  releases: ReleaseInfo[]
  currentVersion?: string
  operation: ReleaseOperation
  statusMessage?: string
  progress?: ReleaseProgress
  lastCheckedAt?: string
}

const DISPLAY_NAMES: Record<ReleaseProduct, string> = {
  hyperion: 'Hyperion',
  hypershield: 'HyperShield',
}

function makeRuntime(): ProductRuntime {
  return { releases: [], operation: 'idle' }
}

function publicSources(product: ReleaseProduct) {
  return RELEASE_SOURCES[product].map(({ label, repository, url }) => ({ label, repository, url }))
}

function releaseTime(release: ReleaseInfo): number {
  const result = Date.parse(release.publishedAt ?? '')
  return Number.isFinite(result) ? result : 0
}

function semanticVersion(version: string): string | undefined {
  return valid(normalizeReleaseVersion(version)) ?? undefined
}

function compareReleasePriority(a: ReleaseInfo, b: ReleaseInfo): number {
  const versionDifference = compare(semanticVersion(b.version)!, semanticVersion(a.version)!)
  return versionDifference || releaseTime(b) - releaseTime(a)
}

export class ReleaseManager {
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly fetchImpl: ReleaseFetch
  private readonly preferences: ReleasePreferences = defaultReleasePreferences()
  private readonly registry: InstalledReleaseRegistry = emptyInstalledRegistry()
  private readonly runtimes: Record<ReleaseProduct, ProductRuntime> = {
    hyperion: makeRuntime(),
    hypershield: makeRuntime(),
  }
  private readonly queues: Record<ReleaseProduct, Promise<void>> = {
    hyperion: Promise.resolve(),
    hypershield: Promise.resolve(),
  }
  private initialization?: Promise<ReleaseCenterState>
  private lastProgressEmit = 0

  constructor(private readonly options: ReleaseManagerOptions) {
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /** Loads local state only. Network access starts only when refresh or automatic checks are requested. */
  initialize(): Promise<ReleaseCenterState> {
    this.initialization ??= this.initializeLocalState()
    return this.initialization
  }

  private async initializeLocalState(): Promise<ReleaseCenterState> {
    await fs.mkdir(releaseCenterPath(this.options.userDataPath), { recursive: true, mode: 0o700 })
    const [preferences, registry, hyperionCache, hyperShieldCache, bundledVersion] =
      await Promise.all([
        readReleasePreferences(this.options.userDataPath).catch(() => defaultReleasePreferences()),
        readInstalledRegistry(this.options.userDataPath).catch(() => emptyInstalledRegistry()),
        readProductCatalogCache(this.options.userDataPath, 'hyperion').catch(() => undefined),
        readProductCatalogCache(this.options.userDataPath, 'hypershield').catch(() => undefined),
        this.readBundledHyperionVersion(),
      ])
    Object.assign(this.preferences.hyperion, preferences.hyperion)
    Object.assign(this.preferences.hypershield, preferences.hypershield)
    this.registry.hyperion = registry.hyperion
    this.registry.hypershield = registry.hypershield
    this.runtimes.hyperion.releases = hyperionCache ?? []
    this.runtimes.hypershield.releases = hyperShieldCache ?? []
    this.runtimes.hyperion.currentVersion = bundledVersion
    this.runtimes.hypershield.currentVersion = this.options.clientVersion

    let registryChanged = false
    let activeChanged = false
    for (const product of RELEASE_PRODUCTS) {
      const validRecords = await Promise.all(
        this.registry[product].map(async record =>
          (await validateInstalledRelease(
            this.options.userDataPath,
            product,
            record,
            this.platform,
            this.architecture,
          ))
            ? record
            : undefined,
        ),
      )
      const installedRecords = validRecords.filter(record => record !== undefined)
      registryChanged ||= installedRecords.length !== this.registry[product].length
      this.registry[product] = installedRecords

      const activeReleaseId = this.preferences[product].activeReleaseId
      if (
        activeReleaseId &&
        !installedRecords.some(candidate => candidate.releaseId === activeReleaseId)
      ) {
        delete this.preferences[product].activeReleaseId
        activeChanged = true
      }
    }
    const stagedClient = this.registry.hypershield.find(
      record => record.releaseId === this.preferences.hypershield.activeReleaseId,
    )
    if (
      stagedClient &&
      normalizeReleaseVersion(stagedClient.version) !==
        normalizeReleaseVersion(this.options.clientVersion)
    ) {
      this.runtimes.hypershield.operation = 'readyToRestart'
      this.runtimes.hypershield.statusMessage = `HyperShield ${stagedClient.version} is ready. Restart to use it.`
    }
    if (registryChanged) {
      await writeInstalledRegistry(this.options.userDataPath, this.registry)
    }
    if (activeChanged) {
      await writeReleasePreferences(this.options.userDataPath, this.preferences)
    }
    this.emitChange()
    return this.getState()
  }

  private async readBundledHyperionVersion(): Promise<string | undefined> {
    try {
      const releaseJson = JSON.parse(
        await fs.readFile(
          path.resolve(this.options.appPath, '..', 'hyperion', 'release.json'),
          'utf8',
        ),
      ) as unknown
      if (
        typeof releaseJson === 'object' &&
        releaseJson !== null &&
        'version' in releaseJson &&
        typeof (releaseJson as { version?: unknown }).version === 'string'
      ) {
        return normalizeReleaseVersion((releaseJson as { version: string }).version)
      }
    } catch {
      // Development trees and older packages do not necessarily include Hyperion release metadata.
    }
    return undefined
  }

  getState(): ReleaseCenterState {
    return structuredClone({
      products: {
        hyperion: this.getProductState('hyperion'),
        hypershield: this.getProductState('hypershield'),
      },
    })
  }

  private getProductState(product: ReleaseProduct): ProductReleaseState {
    const runtime = this.runtimes[product]
    const preferences = this.preferences[product]
    const active = this.registry[product].find(
      record => record.releaseId === preferences.activeReleaseId,
    )
    const currentVersion =
      product === 'hypershield'
        ? this.options.clientVersion
        : (active?.version ?? runtime.currentVersion)
    const matchingCurrentRelease = runtime.releases.find(
      release =>
        release.version === currentVersion ||
        release.tag === currentVersion ||
        normalizeReleaseVersion(release.tag) === currentVersion,
    )
    const latest = this.latestCompatibleRelease(product)
    const selectedVersion = active?.version ?? runtime.currentVersion
    const selectedSemanticVersion = selectedVersion ? semanticVersion(selectedVersion) : undefined
    return {
      product,
      displayName: DISPLAY_NAMES[product],
      currentVersion,
      currentReleaseId: active?.releaseId ?? matchingCurrentRelease?.id,
      usingBundledVersion: product === 'hyperion' && !active,
      selection: preferences.selection,
      channel: preferences.channel,
      automaticUpdates: preferences.automaticUpdates,
      supportsInstallation: supportsReleaseInstallation(product, this.platform, this.architecture),
      releases: runtime.releases,
      installedReleases: this.registry[product]
        .map(({ releaseId, version, tag, channel, installedAt }) => ({
          releaseId,
          version,
          tag,
          channel,
          installedAt,
        }))
        .sort((a, b) => Date.parse(b.installedAt) - Date.parse(a.installedAt)),
      latestReleaseId: latest?.id,
      updateAvailable:
        preferences.selection === 'latest' &&
        latest !== undefined &&
        selectedSemanticVersion !== undefined &&
        compare(semanticVersion(latest.version)!, selectedSemanticVersion) > 0,
      operation: runtime.operation,
      statusMessage: runtime.statusMessage,
      progress: runtime.progress,
      lastCheckedAt: runtime.lastCheckedAt,
      sources: publicSources(product),
    }
  }

  private emitChange(): void {
    this.options.onChange?.(this.getState())
  }

  private setOperation(
    product: ReleaseProduct,
    operation: ReleaseOperation,
    statusMessage?: string,
    progress?: ReleaseProgress,
  ): void {
    const runtime = this.runtimes[product]
    runtime.operation = operation
    runtime.statusMessage = statusMessage
    runtime.progress = progress
    this.emitChange()
  }

  private setError(product: ReleaseProduct, error: unknown): void {
    this.setOperation(product, 'error', errorMessage(error))
  }

  private setIdleUnlessRestartIsPending(product: ReleaseProduct, statusMessage?: string): void {
    if (product === 'hypershield' && this.runtimes[product].operation === 'readyToRestart') {
      return
    }
    this.setOperation(product, 'idle', statusMessage)
  }

  private enqueue(product: ReleaseProduct, task: () => Promise<void>): Promise<ReleaseCenterState> {
    const result = this.queues[product].then(async () => {
      try {
        await task()
      } catch (error) {
        this.setError(product, error)
      }
    })
    this.queues[product] = result.catch(() => {})
    return result.then(() => this.getState())
  }

  private candidates(product: ReleaseProduct): ReleaseInfo[] {
    return this.runtimes[product].releases
      .filter(
        release =>
          release.channel === this.preferences[product].channel &&
          release.packageKind !== 'none' &&
          semanticVersion(release.version) !== undefined,
      )
      .sort(compareReleasePriority)
  }

  private latestCompatibleRelease(product: ReleaseProduct): ReleaseInfo | undefined {
    return this.candidates(product)[0]
  }

  private latestAutomaticRelease(product: ReleaseProduct): ReleaseInfo | undefined {
    const candidates = this.candidates(product)
    return product === 'hyperion'
      ? candidates.find(release => release.packageKind === 'archive')
      : candidates.find(release => release.packageKind === 'appImage')
  }

  private selectedVersion(product: ReleaseProduct): string | undefined {
    const activeReleaseId = this.preferences[product].activeReleaseId
    const active = this.registry[product].find(record => record.releaseId === activeReleaseId)
    return active?.version ?? this.runtimes[product].currentVersion
  }

  private newerRelease(product: ReleaseProduct, release: ReleaseInfo): ReleaseInfo | undefined {
    const currentVersion = this.selectedVersion(product)
    const current = currentVersion ? semanticVersion(currentVersion) : undefined
    if (!current) {
      throw new Error(
        `Cannot update ${DISPLAY_NAMES[product]} safely because its current version is not a valid semantic version.`,
      )
    }
    const candidate = semanticVersion(release.version)!
    return compare(candidate, current) > 0 ? release : undefined
  }

  private async activateLatestInstalled(product: ReleaseProduct): Promise<void> {
    const latestInstalled = this.latestInstalledCandidate(product)
    if (!latestInstalled) {
      return
    }
    const currentVersion = this.selectedVersion(product)
    const current = currentVersion ? semanticVersion(currentVersion) : undefined
    if (currentVersion && !current) {
      return
    }
    const installedVersion = semanticVersion(latestInstalled.version)
    if (!installedVersion || (current && compare(installedVersion, current) < 0)) {
      return
    }
    if (
      await validateInstalledRelease(
        this.options.userDataPath,
        product,
        latestInstalled,
        this.platform,
        this.architecture,
      )
    ) {
      this.preferences[product].activeReleaseId = latestInstalled.releaseId
    }
  }

  private latestInstalledCandidate(product: ReleaseProduct): InstalledReleaseRecord | undefined {
    for (const release of this.candidates(product)) {
      const installed = this.registry[product].find(record => record.releaseId === release.id)
      if (installed) {
        return installed
      }
    }
    return undefined
  }

  private async refreshOne(product: ReleaseProduct): Promise<boolean> {
    const restartStatus =
      product === 'hypershield' && this.runtimes[product].operation === 'readyToRestart'
        ? this.runtimes[product].statusMessage
        : undefined
    const restartPending =
      product === 'hypershield' && this.runtimes[product].operation === 'readyToRestart'
    this.setOperation(product, 'checking', `Checking ${DISPLAY_NAMES[product]} releases…`)
    try {
      const releases = await fetchReleaseCatalog(
        product,
        this.options.clientVersion,
        this.platform,
        this.architecture,
        this.fetchImpl,
      )
      this.runtimes[product].releases = releases
      this.runtimes[product].lastCheckedAt = new Date().toISOString()
      await writeProductCatalogCache(this.options.userDataPath, product, releases)
      if (restartPending) {
        this.setOperation(product, 'readyToRestart', restartStatus)
      } else {
        this.setOperation(product, 'idle')
      }
      return true
    } catch (error) {
      const cached = this.runtimes[product].releases.length
      this.setError(
        product,
        `${errorMessage(error)}${cached ? ' Showing the saved release catalog.' : ''}`,
      )
      return false
    }
  }

  async refresh(product?: ReleaseProduct): Promise<ReleaseCenterState> {
    await this.initialize()
    if (product) {
      return this.enqueue(product, async () => {
        await this.refreshOne(product)
      })
    }
    await Promise.all(
      RELEASE_PRODUCTS.map(async currentProduct =>
        this.enqueue(currentProduct, async () => {
          await this.refreshOne(currentProduct)
        }),
      ),
    )
    return this.getState()
  }

  async setChannel(product: ReleaseProduct, channel: ReleaseChannel): Promise<ReleaseCenterState> {
    await this.initialize()
    return this.enqueue(product, async () => {
      if (channel !== 'stable' && channel !== 'prerelease') {
        throw new Error(`Unknown release channel: ${String(channel)}`)
      }
      const previousActive = this.preferences[product].activeReleaseId
      this.preferences[product].channel = channel
      if (this.preferences[product].selection === 'latest') {
        await this.activateLatestInstalled(product)
      }
      await writeReleasePreferences(this.options.userDataPath, this.preferences)
      const activeChanged = previousActive !== this.preferences[product].activeReleaseId
      const restartPending =
        product === 'hypershield' &&
        (activeChanged || this.runtimes[product].operation === 'readyToRestart')
      if (restartPending) {
        this.setOperation(product, 'readyToRestart')
      } else {
        this.setOperation(product, 'idle')
      }
    })
  }

  async setAutomaticUpdates(
    product: ReleaseProduct,
    automaticUpdates: boolean,
  ): Promise<ReleaseCenterState> {
    await this.initialize()
    return this.enqueue(product, async () => {
      this.preferences[product].automaticUpdates = Boolean(automaticUpdates)
      await writeReleasePreferences(this.options.userDataPath, this.preferences)
      this.emitChange()
    })
  }

  private async activateInstalled(
    product: ReleaseProduct,
    record: InstalledReleaseRecord,
    selection: 'latest' | 'pinned',
  ): Promise<void> {
    if (
      !(await validateInstalledRelease(
        this.options.userDataPath,
        product,
        record,
        this.platform,
        this.architecture,
      ))
    ) {
      throw new Error(
        `${DISPLAY_NAMES[product]} ${record.version} is incomplete or no longer available. Install it again.`,
      )
    }
    this.preferences[product].selection = selection
    if (selection === 'pinned') {
      this.preferences[product].pinnedReleaseId = record.releaseId
    } else {
      delete this.preferences[product].pinnedReleaseId
    }
    this.preferences[product].activeReleaseId = record.releaseId
    await writeReleasePreferences(this.options.userDataPath, this.preferences)
  }

  private async installOne(
    product: ReleaseProduct,
    release: ReleaseInfo,
    selection: 'latest' | 'pinned',
  ): Promise<void> {
    if (!supportsReleaseInstallation(product, this.platform, this.architecture)) {
      throw new Error(
        product === 'hypershield' && this.platform === 'win32'
          ? 'HyperShield AppImage staging is available only on Linux. Windows client updates continue to use NSIS.'
          : `${DISPLAY_NAMES[product]} release installation is not available on ${this.platform} ${this.architecture}.`,
      )
    }
    if (release.packageKind === 'none') {
      throw new Error(release.unavailableReason ?? 'This release has no compatible package.')
    }
    let record = this.registry[product].find(candidate => candidate.releaseId === release.id)
    if (
      record &&
      (await validateInstalledRelease(
        this.options.userDataPath,
        product,
        record,
        this.platform,
        this.architecture,
      ))
    ) {
      await this.activateInstalled(product, record, selection)
      this.setOperation(
        product,
        product === 'hypershield' ? 'readyToRestart' : 'idle',
        product === 'hypershield'
          ? `${DISPLAY_NAMES[product]} ${record.version} is ready. Restart to use it.`
          : `${DISPLAY_NAMES[product]} ${record.version} is installed and selected.`,
      )
      return
    }

    this.setOperation(
      product,
      'downloading',
      `Downloading ${DISPLAY_NAMES[product]} ${release.version}…`,
      {
        bytesTransferred: 0,
        totalBytes: release.assets.reduce((total, asset) => total + asset.size, 0),
      },
    )
    record = await installDownloadedRelease({
      userDataPath: this.options.userDataPath,
      appPath: this.options.appPath,
      product,
      release,
      platform: this.platform,
      architecture: this.architecture,
      clientVersion: this.options.clientVersion,
      fetchImpl: this.fetchImpl,
      onProgress: progress => {
        const now = Date.now()
        if (
          now - this.lastProgressEmit >= 100 ||
          progress.bytesTransferred === progress.totalBytes
        ) {
          this.lastProgressEmit = now
          this.runtimes[product].progress = progress
          this.emitChange()
        }
      },
      onDownloaded: () => {
        this.setOperation(
          product,
          'installing',
          `Installing ${DISPLAY_NAMES[product]} ${release.version}…`,
        )
      },
    })
    const previousRecordIndex = this.registry[product].findIndex(
      candidate => candidate.releaseId === record.releaseId,
    )
    if (previousRecordIndex >= 0) {
      this.registry[product][previousRecordIndex] = record
    } else {
      this.registry[product].push(record)
    }
    await writeInstalledRegistry(this.options.userDataPath, this.registry)
    await this.activateInstalled(product, record, selection)
    this.setOperation(
      product,
      product === 'hypershield' ? 'readyToRestart' : 'idle',
      product === 'hypershield'
        ? `${DISPLAY_NAMES[product]} ${record.version} is ready. Restart to use it; it will not restart automatically.`
        : `${DISPLAY_NAMES[product]} ${record.version} is installed and selected.`,
    )
  }

  async install(product: ReleaseProduct, releaseId: string): Promise<ReleaseCenterState> {
    await this.initialize()
    return this.enqueue(product, async () => {
      const release = this.runtimes[product].releases.find(candidate => candidate.id === releaseId)
      if (!release) {
        throw new Error(
          `Release ${releaseId} was not found. Refresh the ${DISPLAY_NAMES[product]} catalog and try again.`,
        )
      }
      await this.installOne(product, release, 'pinned')
    })
  }

  async activate(product: ReleaseProduct, releaseId: string): Promise<ReleaseCenterState> {
    await this.initialize()
    return this.enqueue(product, async () => {
      const record = this.registry[product].find(candidate => candidate.releaseId === releaseId)
      if (!record) {
        throw new Error(`${DISPLAY_NAMES[product]} release ${releaseId} is not installed.`)
      }
      await this.activateInstalled(product, record, 'pinned')
      this.setOperation(
        product,
        product === 'hypershield' ? 'readyToRestart' : 'idle',
        product === 'hypershield'
          ? `${DISPLAY_NAMES[product]} ${record.version} is selected. Restart to use it.`
          : `${DISPLAY_NAMES[product]} ${record.version} is selected.`,
      )
    })
  }

  async useBundledHyperion(): Promise<ReleaseCenterState> {
    await this.initialize()
    return this.enqueue('hyperion', async () => {
      this.preferences.hyperion.selection = 'pinned'
      delete this.preferences.hyperion.pinnedReleaseId
      delete this.preferences.hyperion.activeReleaseId
      await writeReleasePreferences(this.options.userDataPath, this.preferences)
      const version = this.runtimes.hyperion.currentVersion
      this.setOperation(
        'hyperion',
        'idle',
        version ? `Bundled Hyperion ${version} is selected.` : 'Bundled Hyperion is selected.',
      )
    })
  }

  async trackLatest(product: ReleaseProduct): Promise<ReleaseCenterState> {
    await this.initialize()
    return this.enqueue(product, async () => {
      const previousActive = this.preferences[product].activeReleaseId
      this.preferences[product].selection = 'latest'
      delete this.preferences[product].pinnedReleaseId
      await this.activateLatestInstalled(product)
      await writeReleasePreferences(this.options.userDataPath, this.preferences)
      const activeChanged = previousActive !== this.preferences[product].activeReleaseId
      const restartPending =
        product === 'hypershield' &&
        (activeChanged || this.runtimes[product].operation === 'readyToRestart')
      if (restartPending) {
        this.setOperation(product, 'readyToRestart')
      } else {
        this.setOperation(product, 'idle')
      }
    })
  }

  async updateLatest(product: ReleaseProduct): Promise<ReleaseCenterState> {
    await this.initialize()
    return this.enqueue(product, async () => {
      await this.refreshOne(product)
      const latest = this.latestCompatibleRelease(product)
      if (!latest) {
        throw new Error(
          `No compatible ${DISPLAY_NAMES[product]} ${this.preferences[product].channel} release is available for ${this.platform} ${this.architecture}.`,
        )
      }
      const state = this.getProductState(product)
      if (state.currentReleaseId === latest.id && state.selection === 'latest') {
        this.setIdleUnlessRestartIsPending(
          product,
          `${DISPLAY_NAMES[product]} ${latest.version} is already up to date.`,
        )
        return
      }
      const update = this.newerRelease(product, latest)
      if (!update) {
        this.setIdleUnlessRestartIsPending(
          product,
          `${DISPLAY_NAMES[product]} ${state.currentVersion ?? latest.version} is already newer than or equal to the latest compatible release. No downgrade was installed.`,
        )
        return
      }
      await this.installOne(product, update, 'latest')
    })
  }

  /** Relaunches only at the user's explicit request, using the selected staged AppImage. */
  async restartClient(): Promise<void> {
    await this.initialize()
    await this.queues.hypershield
    const activeReleaseId = this.preferences.hypershield.activeReleaseId
    const record = this.registry.hypershield.find(
      candidate => candidate.releaseId === activeReleaseId,
    )
    if (
      !record ||
      record.packageKind !== 'appImage' ||
      !(await validateInstalledRelease(
        this.options.userDataPath,
        'hypershield',
        record,
        this.platform,
        this.architecture,
      ))
    ) {
      throw new Error(
        'No staged HyperShield AppImage is selected. Install a HyperShield release first.',
      )
    }
    const execPath = installedReleaseExecutable(this.options.userDataPath, 'hypershield', record)
    app.relaunch({ execPath, args: [] })
    app.quit()
  }

  /** Refreshes and installs eligible updates without changing pinned selections or restarting the client. */
  async checkForAutomaticUpdates(): Promise<ReleaseCenterState> {
    await this.initialize()
    await Promise.all(
      RELEASE_PRODUCTS.map(async product => {
        const preferences = this.preferences[product]
        if (
          preferences.selection !== 'latest' ||
          !preferences.automaticUpdates ||
          !supportsReleaseInstallation(product, this.platform, this.architecture)
        ) {
          return this.getState()
        }
        return this.enqueue(product, async () => {
          const refreshed = await this.refreshOne(product)
          const latest = this.latestAutomaticRelease(product)
          if (!latest) {
            if (refreshed) {
              this.setIdleUnlessRestartIsPending(product)
            }
            return
          }
          const update = this.newerRelease(product, latest)
          if (!update) {
            if (refreshed) {
              this.setIdleUnlessRestartIsPending(product)
            }
            return
          }
          await this.installOne(product, update, 'latest')
        })
      }),
    )
    return this.getState()
  }
}
