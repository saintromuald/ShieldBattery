import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  InstalledReleaseInfo,
  ReleaseChannel,
  ReleaseInfo,
  ReleasePackageKind,
  ReleaseProduct,
} from '../../common/release-center'
import { validatePe32PlusAmd64File } from './pe'

export const RELEASE_CENTER_DIRECTORY = 'release-center'
export const RELEASE_PRODUCT_DIRECTORIES: Record<ReleaseProduct, string> = {
  hyperion: 'hyperion',
  hypershield: 'hypershield',
}

export function supportsReleaseInstallation(
  product: ReleaseProduct,
  platform: NodeJS.Platform,
  architecture: string,
): boolean {
  if (product === 'hyperion' && platform === 'win32') {
    return architecture === 'x64'
  }
  return platform === 'linux' && (architecture === 'x64' || architecture === 'arm64')
}

export interface ProductPreferences {
  channel: ReleaseChannel
  automaticUpdates: boolean
  selection: 'latest' | 'pinned'
  pinnedReleaseId?: string
  activeReleaseId?: string
}

export type ReleasePreferences = Record<ReleaseProduct, ProductPreferences>

export interface InstalledReleaseRecord extends InstalledReleaseInfo {
  packageKind: Exclude<ReleasePackageKind, 'none'>
  directoryName: string
  /** Path to the executable, relative to directoryName. */
  executablePath: string
  platform: NodeJS.Platform
  architecture: string
}

export type InstalledReleaseRegistry = Record<ReleaseProduct, InstalledReleaseRecord[]>

interface PreferencesFile {
  version: 1
  products: ReleasePreferences
}

interface RegistryFile {
  version: 1
  products: InstalledReleaseRegistry
}

export interface CatalogCacheFile {
  version: 1
  cachedAt: string
  releases: ReleaseInfo[]
}

export function defaultReleasePreferences(): ReleasePreferences {
  return {
    hyperion: {
      // The packaged engine is compatibility-tested with its client. Engine replacement is
      // opt-in so a catalog entry cannot silently change launch or simulation behavior.
      channel: 'stable',
      automaticUpdates: false,
      selection: 'pinned',
    },
    hypershield: {
      channel: 'stable',
      automaticUpdates: true,
      selection: 'latest',
    },
  }
}

export function emptyInstalledRegistry(): InstalledReleaseRegistry {
  return { hyperion: [], hypershield: [] }
}

export function releaseCenterPath(userDataPath: string): string {
  return path.join(userDataPath, RELEASE_CENTER_DIRECTORY)
}

export function releaseCenterInstallRoot(userDataPath: string, product: ReleaseProduct): string {
  return path.join(
    releaseCenterPath(userDataPath),
    'installs',
    RELEASE_PRODUCT_DIRECTORIES[product],
  )
}

export function preferencesPath(userDataPath: string): string {
  return path.join(releaseCenterPath(userDataPath), 'preferences.json')
}

export function registryPath(userDataPath: string): string {
  return path.join(releaseCenterPath(userDataPath), 'installed.json')
}

export function catalogCachePath(userDataPath: string, product: ReleaseProduct): string {
  return path.join(releaseCenterPath(userDataPath), 'cache', `${product}.json`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChannel(value: unknown): value is ReleaseChannel {
  return value === 'stable' || value === 'prerelease'
}

function normalizePreferences(value: unknown): ReleasePreferences {
  const defaults = defaultReleasePreferences()
  if (!isObject(value) || value.version !== 1 || !isObject(value.products)) {
    return defaults
  }

  for (const product of ['hyperion', 'hypershield'] as const) {
    const candidate = value.products[product]
    if (!isObject(candidate)) {
      continue
    }
    const normalized = defaults[product]
    if (isChannel(candidate.channel)) {
      normalized.channel = candidate.channel
    }
    if (typeof candidate.automaticUpdates === 'boolean') {
      normalized.automaticUpdates = candidate.automaticUpdates
    }
    if (candidate.selection === 'latest' || candidate.selection === 'pinned') {
      normalized.selection = candidate.selection
    }
    if (typeof candidate.pinnedReleaseId === 'string' && candidate.pinnedReleaseId) {
      normalized.pinnedReleaseId = candidate.pinnedReleaseId
    }
    if (typeof candidate.activeReleaseId === 'string' && candidate.activeReleaseId) {
      normalized.activeReleaseId = candidate.activeReleaseId
    }
  }

  if (defaults.hyperion.selection === 'latest' || !defaults.hyperion.pinnedReleaseId) {
    delete defaults.hyperion.pinnedReleaseId
  }
  if (defaults.hypershield.selection === 'latest' || !defaults.hypershield.pinnedReleaseId) {
    delete defaults.hypershield.pinnedReleaseId
  }
  return defaults
}

function isInstalledReleaseRecord(value: unknown): value is InstalledReleaseRecord {
  if (!isObject(value)) {
    return false
  }
  return (
    typeof value.releaseId === 'string' &&
    typeof value.version === 'string' &&
    typeof value.tag === 'string' &&
    isChannel(value.channel) &&
    typeof value.installedAt === 'string' &&
    (value.packageKind === 'archive' ||
      value.packageKind === 'raw' ||
      value.packageKind === 'appImage') &&
    typeof value.directoryName === 'string' &&
    typeof value.executablePath === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.architecture === 'string'
  )
}

function normalizeRegistry(value: unknown): InstalledReleaseRegistry {
  const result = emptyInstalledRegistry()
  if (!isObject(value) || value.version !== 1 || !isObject(value.products)) {
    return result
  }
  for (const product of ['hyperion', 'hypershield'] as const) {
    const records = value.products[product]
    if (Array.isArray(records)) {
      result[product] = records.filter(isInstalledReleaseRecord)
    }
  }
  return result
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(pathname, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new Error(`Could not read ${path.basename(pathname)}: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const jsonWriteQueues = new Map<string, Promise<void>>()

/** Writes a complete JSON document without exposing partially written state to readers. */
export function writeJsonAtomic(pathname: string, value: unknown): Promise<void> {
  const snapshot = structuredClone(value)
  const previous = jsonWriteQueues.get(pathname) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(() => writeJsonSnapshot(pathname, snapshot))
  jsonWriteQueues.set(
    pathname,
    result.catch(() => {}),
  )
  return result
}

async function writeJsonSnapshot(pathname: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 })
  const temporaryPath = `${pathname}.${process.pid}.${randomUUID()}.tmp`
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, pathname)
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

export async function readReleasePreferences(userDataPath: string): Promise<ReleasePreferences> {
  return normalizePreferences(await readJson(preferencesPath(userDataPath)))
}

export async function writeReleasePreferences(
  userDataPath: string,
  preferences: ReleasePreferences,
): Promise<void> {
  const file: PreferencesFile = { version: 1, products: preferences }
  await writeJsonAtomic(preferencesPath(userDataPath), file)
}

export async function readInstalledRegistry(
  userDataPath: string,
): Promise<InstalledReleaseRegistry> {
  return normalizeRegistry(await readJson(registryPath(userDataPath)))
}

export async function writeInstalledRegistry(
  userDataPath: string,
  registry: InstalledReleaseRegistry,
): Promise<void> {
  const file: RegistryFile = { version: 1, products: registry }
  await writeJsonAtomic(registryPath(userDataPath), file)
}

export async function readProductCatalogCache(
  userDataPath: string,
  product: ReleaseProduct,
): Promise<ReleaseInfo[] | undefined> {
  const value = await readJson(catalogCachePath(userDataPath, product))
  return isObject(value) && value.version === 1 && Array.isArray(value.releases)
    ? (value.releases as ReleaseInfo[])
    : undefined
}

export async function writeProductCatalogCache(
  userDataPath: string,
  product: ReleaseProduct,
  releases: ReleaseInfo[],
): Promise<void> {
  const file: CatalogCacheFile = { version: 1, cachedAt: new Date().toISOString(), releases }
  await writeJsonAtomic(catalogCachePath(userDataPath, product), file)
}

export function installedReleaseExecutable(
  userDataPath: string,
  product: ReleaseProduct,
  record: InstalledReleaseRecord,
): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.directoryName) ||
    path.isAbsolute(record.executablePath)
  ) {
    throw new Error('Installed release registry contains an unsafe path.')
  }
  const executablePath = path.resolve(
    releaseCenterInstallRoot(userDataPath, product),
    record.directoryName,
    record.executablePath,
  )
  const installDirectory = path.resolve(
    releaseCenterInstallRoot(userDataPath, product),
    record.directoryName,
  )
  if (
    path.dirname(installDirectory) !==
      path.resolve(releaseCenterInstallRoot(userDataPath, product)) ||
    (executablePath !== installDirectory &&
      !executablePath.startsWith(`${installDirectory}${path.sep}`))
  ) {
    throw new Error('Installed release registry contains an unsafe path.')
  }
  return executablePath
}

export async function validateInstalledRelease(
  userDataPath: string,
  product: ReleaseProduct,
  record: InstalledReleaseRecord,
  platform: NodeJS.Platform,
  architecture: string,
): Promise<boolean> {
  if (
    !supportsReleaseInstallation(product, platform, architecture) ||
    record.platform !== platform ||
    record.architecture !== architecture
  ) {
    return false
  }
  try {
    const executablePath = installedReleaseExecutable(userDataPath, product, record)
    const installDirectory = path.resolve(
      releaseCenterInstallRoot(userDataPath, product),
      record.directoryName,
    )
    const [directoryStat, executableStat] = await Promise.all([
      fs.lstat(installDirectory),
      fs.lstat(executablePath),
    ])
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      !executableStat.isFile() ||
      executableStat.isSymbolicLink()
    ) {
      return false
    }
    const [realDirectory, realExecutable] = await Promise.all([
      fs.realpath(installDirectory),
      fs.realpath(executablePath),
    ])
    if (!realExecutable.startsWith(`${realDirectory}${path.sep}`)) {
      return false
    }
    if (platform === 'linux') {
      await fs.access(executablePath, fsConstants.X_OK)
    }
    if (product === 'hyperion') {
      const windows = platform === 'win32'
      if (
        windows &&
        (record.packageKind !== 'archive' || record.executablePath !== 'Hyperion.exe')
      ) {
        return false
      }
      const workingDirectory = path.dirname(executablePath)
      const libraryPath = path.join(workingDirectory, windows ? 'SDL3.dll' : 'libSDL3.so.0')
      const [library, data] = await Promise.all([
        fs.lstat(libraryPath),
        fs.lstat(path.join(workingDirectory, 'Data')),
      ])
      if (
        !library.isFile() ||
        library.isSymbolicLink() ||
        !data.isDirectory() ||
        data.isSymbolicLink()
      ) {
        return false
      }
      if (windows) {
        const [releaseMetadata, edition] = await Promise.all([
          fs.lstat(path.join(workingDirectory, 'release.json')),
          fs.lstat(path.join(workingDirectory, 'EDITION.txt')),
        ])
        if (
          !releaseMetadata.isFile() ||
          releaseMetadata.isSymbolicLink() ||
          !edition.isFile() ||
          edition.isSymbolicLink()
        ) {
          return false
        }
        await Promise.all([
          validatePe32PlusAmd64File(executablePath),
          validatePe32PlusAmd64File(libraryPath),
        ])
      }
    }
    return true
  } catch {
    return false
  }
}

export interface DownloadedHyperionPaths {
  executablePath: string
  workingDirectory: string
  fromLatestTracking: boolean
}

/** Resolves only a complete, selected installation; callers can retain their bundled fallback. */
export async function readSelectedHyperionInstall(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): Promise<DownloadedHyperionPaths | undefined> {
  if (!supportsReleaseInstallation('hyperion', platform, architecture)) {
    return undefined
  }
  try {
    const [preferences, registry] = await Promise.all([
      readReleasePreferences(userDataPath),
      readInstalledRegistry(userDataPath),
    ])
    const activeReleaseId = preferences.hyperion.activeReleaseId
    const record = registry.hyperion.find(candidate => candidate.releaseId === activeReleaseId)
    if (
      !record ||
      !(await validateInstalledRelease(userDataPath, 'hyperion', record, platform, architecture))
    ) {
      return undefined
    }
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    return {
      executablePath,
      workingDirectory: path.dirname(executablePath),
      fromLatestTracking: preferences.hyperion.selection === 'latest',
    }
  } catch {
    return undefined
  }
}
