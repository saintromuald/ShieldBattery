import { randomUUID } from 'node:crypto'
import { type Dirent, promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { PLUTO_RUNTIME_DOWNLOAD_BYTES } from '../../../common/pluto-runtime'
import type { ReleaseAsset } from '../../../common/release-center'
import { type DownloadProgress, downloadReleaseAssets } from '../../releases/installer'
import { validatePeFile } from '../../releases/pe'
import {
  computeFileSha256,
  errorMessage,
  readSelectedHyperionInstall,
} from '../../releases/storage'
import { extractHyperionZip, type ZipEntry } from '../../releases/zip'
import { embeddedHyperionPaths } from './install'

export const PLUTO_ARCHIVE_ASSET = {
  name: 'pluto-v2.0.zip',
  url: 'https://github.com/tscmoo/pluto/releases/download/v2.0/pluto-v2.0.zip',
  size: PLUTO_RUNTIME_DOWNLOAD_BYTES,
  sha256: '17544fc3ab32e3e2823646887e021cf998362348d73740817e94d1a78aa6209d',
} as const satisfies ReleaseAsset

export const PLUTO_PAYLOAD_SHA256 = {
  'pluto.dll': '603fea2f77a4b652f29b832c2977cf5bc9d83bbcb927febd04499220020ce3bc',
  'pluto/pluto_infer.exe': '3f2814a51034b9817b396e52b38d30341ede506a2baedc7cbc11cb6ebcece2cc',
  'pluto/pluto_weights.bin': 'c53a559b4910777dc0e1c561c0d89d243091f465d8e9fc0f5f72e56597067d86',
} as const

export type PlutoPayloadName = keyof typeof PLUTO_PAYLOAD_SHA256
export type PlutoPayloadHashes = Readonly<Record<PlutoPayloadName, string>>

const PLUTO_BRIDGE_NAME = 'pluto-bridge.exe'
const PLUTO_ARCHIVE_ENTRY_NAMES = new Set([
  'README.txt',
  'pluto.dll',
  'pluto/',
  'pluto/pluto_weights.bin',
  'pluto/pluto_infer.exe',
])
const PLUTO_CONFIG_PATH = 'pluto/pluto_config.json'
const PLUTO_STATE_DIRECTORY = 'bwapi-data'
const MAX_PLUTO_FILE_BYTES = 1024 * 1024 * 1024
const MAX_PLUTO_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024

function payloadNames(hashes: PlutoPayloadHashes): PlutoPayloadName[] {
  return Object.keys(hashes) as PlutoPayloadName[]
}

function validatePlutoZipEntry(entry: ZipEntry): void {
  if (!PLUTO_ARCHIVE_ENTRY_NAMES.has(entry.name)) {
    throw new Error(`Pluto ZIP contains an unexpected or unsafe ${entry.kind}: ${entry.name}`)
  }
  if (entry.kind === 'directory' && entry.name !== 'pluto/') {
    throw new Error(`Pluto ZIP contains an unexpected directory: ${entry.name}`)
  }
}

async function verifyPlutoPayloads(root: string, hashes: PlutoPayloadHashes): Promise<void> {
  for (const name of payloadNames(hashes)) {
    const filePath = path.join(root, ...name.split('/'))
    const stat = await fs.lstat(filePath).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Pluto ZIP must include ${name} as a regular file.`)
    }
    const actual = await computeFileSha256(filePath)
    if (actual !== hashes[name].toLowerCase()) {
      throw new Error(
        `SHA-256 verification failed for Pluto payload ${name}. Expected ${hashes[name]}, received ${actual}.`,
      )
    }
  }
}

/** Validates Hyperion's owned bridge as a regular PE32 or PE32+ file, including 32-bit PEs. */
export async function validatePlutoBridgeFile(bridgePath: string): Promise<void> {
  let stat
  try {
    stat = await fs.lstat(bridgePath)
  } catch (error) {
    throw new Error(
      `Hyperion's Pluto AI bridge is missing at ${bridgePath}. Repair or select a complete Hyperion installation before downloading Pluto AI.`,
      { cause: error },
    )
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Hyperion's Pluto AI bridge at ${bridgePath} is not a regular file. Repair or select a complete Hyperion installation before downloading Pluto AI.`,
    )
  }
  try {
    await validatePeFile(bridgePath)
  } catch (error) {
    throw new Error(
      `Hyperion's Pluto AI bridge at ${bridgePath} is invalid: ${errorMessage(error)}. Repair or select a complete Hyperion installation before downloading Pluto AI.`,
      { cause: error },
    )
  }
}

export interface ResolvePlutoBridgeOptions {
  appPath: string
  userDataPath: string
  sessionName?: string
  platform: NodeJS.Platform
  architecture: string
  readDownloadedInstall?: typeof readSelectedHyperionInstall
}

/** Resolves the selected engine's bridge without launching Hyperion or running a native probe. */
export async function resolvePlutoBridgePath(options: ResolvePlutoBridgeOptions): Promise<string> {
  const bundled = embeddedHyperionPaths(
    options.appPath,
    options.userDataPath,
    options.sessionName ?? process.env.SB_SESSION,
    options.platform,
    options.architecture,
  )
  const downloaded = await (options.readDownloadedInstall ?? readSelectedHyperionInstall)(
    options.userDataPath,
    options.platform,
    options.architecture,
  )
  if (downloaded?.invalid && !downloaded.fromLatestTracking) {
    throw new Error(
      'The pinned Hyperion installation is damaged. Repair it before installing Pluto AI.',
    )
  }
  const workingDirectory =
    downloaded && !downloaded.invalid ? downloaded.workingDirectory : bundled.workingDirectory
  const bridgePath = path.join(workingDirectory, 'Data', 'pluto', PLUTO_BRIDGE_NAME)
  await validatePlutoBridgeFile(bridgePath)
  return bridgePath
}

/** Returns true only when the three official payloads and Hyperion bridge are all usable. */
export async function isPlutoRuntimeInstalled(
  installPath: string,
  hashes: PlutoPayloadHashes = PLUTO_PAYLOAD_SHA256,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    await verifyPlutoPayloads(installPath, hashes)
    await validatePlutoBridgeFile(path.join(installPath, PLUTO_BRIDGE_NAME))
    if (platform === 'linux') {
      await fs.access(path.join(installPath, 'pluto', 'pluto_infer.exe'), fsConstants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function copySupportFile(source: string, destination: string): Promise<void> {
  let stat
  try {
    stat = await fs.lstat(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Pluto AI support file cannot be preserved safely: ${source}`)
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL)
}

/** Copies only regular files and directories, rejecting links and special filesystem entries. */
async function copySupportTree(source: string, destination: string): Promise<void> {
  let stat
  try {
    stat = await fs.lstat(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Pluto AI support path cannot be preserved safely: ${source}`)
  }
  if (stat.isFile()) {
    await copySupportFile(source, destination)
    return
  }

  await fs.mkdir(destination, { recursive: false, mode: 0o700 })
  const entries = await fs.readdir(source)
  for (const entry of entries) {
    await copySupportTree(path.join(source, entry), path.join(destination, entry))
  }
}

async function existingBridgeIsValid(installPath: string): Promise<boolean> {
  try {
    await validatePlutoBridgeFile(path.join(installPath, PLUTO_BRIDGE_NAME))
    return true
  } catch {
    return false
  }
}

function isPlutoRootSupportFile(name: string): boolean {
  return (
    /^(?:pluto|pluto_infer|bridge)(?:[._-][A-Za-z0-9_-]+)*\.log$/.test(name) ||
    /^(?:stdout|stderr|bot)(?:[._-][A-Za-z0-9_-]+)*\.(?:log|txt)$/.test(name) ||
    /^pluto_bandit_[A-Za-z0-9_-]*\.txt$/.test(name)
  )
}

/** Carries known user/engine support state into staging without retaining official payloads. */
async function preservePlutoSupport(
  existingInstallPath: string,
  stagingDirectory: string,
  activeBridgePath: string,
): Promise<void> {
  await copySupportTree(
    path.join(existingInstallPath, PLUTO_STATE_DIRECTORY),
    path.join(stagingDirectory, PLUTO_STATE_DIRECTORY),
  )
  await copySupportFile(
    path.join(existingInstallPath, ...PLUTO_CONFIG_PATH.split('/')),
    path.join(stagingDirectory, ...PLUTO_CONFIG_PATH.split('/')),
  )

  let existingEntries: Dirent[]
  try {
    existingEntries = await fs.readdir(existingInstallPath, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    existingEntries = []
  }
  for (const entry of existingEntries) {
    if (isPlutoRootSupportFile(entry.name)) {
      // copySupportFile uses lstat and rejects links, directories, FIFOs, and other special files.
      await copySupportFile(
        path.join(existingInstallPath, entry.name),
        path.join(stagingDirectory, entry.name),
      )
    }
  }

  // Repairs retain the existing engine bridge, while a missing or invalid one is restored from the
  // active Hyperion package. Official payloads always come from the newly verified staging set.
  const existingBridge = path.join(existingInstallPath, PLUTO_BRIDGE_NAME)
  const bridgeSource = (await existingBridgeIsValid(existingInstallPath))
    ? existingBridge
    : activeBridgePath
  await copySupportFile(bridgeSource, path.join(stagingDirectory, PLUTO_BRIDGE_NAME))
}

/**
 * Publishes a fully verified sibling staging directory. An existing runtime is restored if the
 * final rename fails, and is never removed before its replacement is ready.
 */
async function publishPlutoRuntime(stagingDirectory: string, destination: string): Promise<void> {
  const parent = path.dirname(destination)
  const backup = path.join(parent, `.pluto-backup-${randomUUID()}`)
  const hadExisting = await pathExists(destination)
  if (hadExisting) {
    await fs.rename(destination, backup)
  }

  try {
    await fs.rename(stagingDirectory, destination)
  } catch (error) {
    if (hadExisting) {
      try {
        await fs.rename(backup, destination)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Pluto AI replacement failed and the previous runtime could not be restored. It remains at ${backup}.`,
          { cause: restoreError },
        )
      }
    }
    throw error
  }

  if (hadExisting) {
    // The new directory is already live. A stale private backup is safer than reporting a failed
    // installation after the atomic publish has succeeded.
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
  }
}

/** Extracts the five known archive records into fresh storage and verifies the three payloads. */
export async function stagePlutoRuntimeArchive(
  archivePath: string,
  stagingDirectory: string,
  hashes: PlutoPayloadHashes = PLUTO_PAYLOAD_SHA256,
): Promise<void> {
  let entryCount = 0
  try {
    await extractHyperionZip(
      archivePath,
      stagingDirectory,
      {
        maxArchiveBytes: PLUTO_RUNTIME_DOWNLOAD_BYTES,
        maxEntries: 5,
        maxFileBytes: MAX_PLUTO_FILE_BYTES,
        maxUncompressedBytes: MAX_PLUTO_UNCOMPRESSED_BYTES,
      },
      entry => {
        validatePlutoZipEntry(entry)
        entryCount += 1
      },
    )
    if (entryCount !== 5) {
      throw new Error('Pluto ZIP must contain exactly its README, directory, and three payloads.')
    }
    const readme = await fs.lstat(path.join(stagingDirectory, 'README.txt'))
    if (!readme.isFile() || readme.isSymbolicLink()) {
      throw new Error('Pluto ZIP README.txt is not a regular file.')
    }
    await verifyPlutoPayloads(stagingDirectory, hashes)
    // The extractor creates private files. The inference process also needs execute permission on
    // Linux; this changes no payload bytes and is ignored by Windows filesystems.
    await fs.chmod(path.join(stagingDirectory, 'pluto', 'pluto_infer.exe'), 0o700)
  } catch (error) {
    throw new Error(`Pluto AI package is unsafe or invalid: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

/** Verifies and stages an already downloaded official archive before atomically repairing Pluto. */
export async function installPlutoArchive(options: {
  archivePath: string
  destination: string
  activeBridgePath: string
  /** Test fixture hashes; production callers retain the pinned official values. */
  expectedHashes?: PlutoPayloadHashes
}): Promise<void> {
  await validatePlutoBridgeFile(options.activeBridgePath)
  const parent = path.dirname(options.destination)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const stagingDirectory = path.join(parent, `.pluto-staging-${randomUUID()}`)
  try {
    const hashes = options.expectedHashes ?? PLUTO_PAYLOAD_SHA256
    await stagePlutoRuntimeArchive(options.archivePath, stagingDirectory, hashes)
    await preservePlutoSupport(options.destination, stagingDirectory, options.activeBridgePath)
    await verifyPlutoPayloads(stagingDirectory, hashes)
    await validatePlutoBridgeFile(path.join(stagingDirectory, PLUTO_BRIDGE_NAME))
    await publishPlutoRuntime(stagingDirectory, options.destination)
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

export interface InstallPlutoRuntimeOptions {
  /** The per-user Hyperion data path passed with `--data`. */
  dataPath: string
  /** Exactly `dataPath/pluto`. */
  installPath: string
  /** `pluto-bridge.exe` from the active Hyperion working directory's `Data/pluto`. */
  activeBridgePath: string
  clientVersion: string
  fetchImpl?: typeof globalThis.fetch
  onProgress?: DownloadProgress
  onDownloaded?: () => void
}

/** Downloads Pluto only when called by the explicit-install manager action. */
export async function installPlutoRuntime(options: InstallPlutoRuntimeOptions): Promise<void> {
  // Bridge validation is deliberately complete before any network request or download directory is
  // created. A Hyperion package problem must be repaired through Release Center first.
  await validatePlutoBridgeFile(options.activeBridgePath)
  await fs.mkdir(options.dataPath, { recursive: true, mode: 0o700 })
  const downloadDirectory = await fs.mkdtemp(path.join(options.dataPath, '.pluto-download-'))
  try {
    const downloaded = await downloadReleaseAssets(
      { assets: [PLUTO_ARCHIVE_ASSET] },
      downloadDirectory,
      options.clientVersion,
      options.fetchImpl ?? globalThis.fetch,
      options.onProgress ?? (() => {}),
    )
    options.onDownloaded?.()
    await installPlutoArchive({
      archivePath: downloaded[0].path,
      destination: options.installPath,
      activeBridgePath: options.activeBridgePath,
    })
  } finally {
    await fs.rm(downloadDirectory, { recursive: true, force: true }).catch(() => {})
  }
}
