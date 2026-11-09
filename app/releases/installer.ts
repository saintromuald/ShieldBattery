import { execFile } from 'node:child_process'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ReleaseAsset,
  ReleaseInfo,
  ReleaseProduct,
  ReleaseProgress,
} from '../../common/release-center'
import { validatePe32PlusAmd64File } from './pe'
import {
  errorMessage,
  installedReleaseExecutable,
  type InstalledReleaseRecord,
  releaseCenterInstallRoot,
  releaseCenterPath,
  supportsReleaseInstallation,
} from './storage'
import { extractHyperionZip } from './zip'

const execFileAsync = promisify(execFile)
const TAR_LIST_LIMIT_BYTES = 32 * 1024 * 1024
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024
export const DOWNLOAD_CONNECTION_TIMEOUT_MS = 30_000
export const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000
export const MAX_ASSET_BYTES = 1024 * 1024 * 1024
export const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 4096
export const MAX_ARCHIVE_DEPTH = 32
export const MAX_EXTRACTED_FILE_BYTES = 1024 * 1024 * 1024
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
const FORBIDDEN_GAME_EXTENSIONS = new Set([
  '.casc',
  '.dll',
  '.exe',
  '.grp',
  '.mpq',
  '.rep',
  '.sch',
  '.scm',
  '.scx',
])

export type DownloadProgress = (progress: ReleaseProgress) => void

export interface DownloadedAsset {
  asset: ReleaseAsset
  path: string
}

function safeFilePart(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 80) || 'release'
  )
}

function hashesEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) {
    return false
  }
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

async function writeAll(handle: fs.FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset)
    if (bytesWritten <= 0) {
      throw new Error('The download file could not be written completely.')
    }
    offset += bytesWritten
  }
}

async function readWithInactivityTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  assetName: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(
        new Error(
          `Download of ${assetName} received no data for ${DOWNLOAD_INACTIVITY_TIMEOUT_MS / 1000} seconds.`,
        ),
      )
    }, DOWNLOAD_INACTIVITY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([reader.read(), timeout])
  } finally {
    clearTimeout(timer!)
  }
}

async function downloadAsset(
  asset: ReleaseAsset,
  destination: string,
  clientVersion: string,
  fetchImpl: typeof globalThis.fetch,
  onProgress: (bytesTransferred: number, bytesPerSecond?: number) => void,
): Promise<void> {
  const controller = new AbortController()
  let connectionTimer: ReturnType<typeof setTimeout>
  const connectionTimeout = new Promise<never>((_, reject) => {
    connectionTimer = setTimeout(() => {
      controller.abort()
      reject(
        new Error(
          `Connection for ${asset.name} timed out after ${DOWNLOAD_CONNECTION_TIMEOUT_MS / 1000} seconds.`,
        ),
      )
    }, DOWNLOAD_CONNECTION_TIMEOUT_MS)
  })
  let response: Response
  try {
    response = await Promise.race([
      fetchImpl(asset.url, {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': `HyperShield/${clientVersion}`,
          ...(process.env.GITHUB_TOKEN?.trim()
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN.trim()}` }
            : {}),
        },
        signal: controller.signal,
      }),
      connectionTimeout,
    ])
  } catch (error) {
    throw new Error(`Could not download ${asset.name}: ${errorMessage(error)}`, { cause: error })
  } finally {
    clearTimeout(connectionTimer!)
  }
  if (!response.ok) {
    throw new Error(
      `Could not download ${asset.name}: GitHub returned ${response.status} ${response.statusText || 'HTTP error'}.`,
    )
  }
  if (!response.body) {
    throw new Error(`Could not download ${asset.name}: GitHub returned an empty response.`)
  }

  const hash = createHash('sha256')
  const startedAt = Date.now()
  const reader = response.body.getReader()
  let transferred = 0
  let handle: fs.FileHandle | undefined
  let finished = false
  try {
    handle = await fs.open(destination, 'wx', 0o600)
    while (true) {
      const { done, value } = await readWithInactivityTimeout(reader, controller, asset.name)
      if (done) {
        finished = true
        break
      }
      const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      if (buffer.byteLength > asset.size - transferred) {
        throw new Error(
          `Downloaded ${asset.name} exceeds its advertised size of ${asset.size} bytes.`,
        )
      }
      await writeAll(handle, buffer)
      hash.update(buffer)
      transferred += buffer.byteLength
      const elapsedSeconds = (Date.now() - startedAt) / 1000
      onProgress(
        transferred,
        elapsedSeconds > 0 ? Math.round(transferred / elapsedSeconds) : undefined,
      )
    }
    if (transferred !== asset.size) {
      throw new Error(
        `Downloaded ${asset.name} has ${transferred} bytes instead of its advertised ${asset.size} bytes.`,
      )
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    const actualSize = (await fs.stat(destination)).size
    if (actualSize !== asset.size) {
      throw new Error(
        `Downloaded ${asset.name} has ${actualSize} bytes on disk instead of its advertised ${asset.size} bytes.`,
      )
    }
    if (asset.sha256) {
      const actual = hash.digest('hex')
      if (!hashesEqual(actual, asset.sha256)) {
        throw new Error(
          `SHA-256 verification failed for ${asset.name}. Expected ${asset.sha256}, received ${actual || 'no hash'}.`,
        )
      }
    }
  } finally {
    if (!finished) {
      controller.abort()
      await reader.cancel().catch(() => {})
    }
    await handle?.close().catch(() => {})
  }
}

function validateAssetSizes(assets: readonly ReleaseAsset[]): number {
  if (!assets.length) {
    throw new Error('Release does not advertise any downloadable assets.')
  }
  let totalBytes = 0
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`${asset.name} has an invalid advertised size.`)
    }
    if (asset.size > MAX_ASSET_BYTES) {
      throw new Error(`${asset.name} exceeds the ${MAX_ASSET_BYTES}-byte per-file download limit.`)
    }
    if (asset.size > MAX_RELEASE_BYTES - totalBytes) {
      throw new Error(`Release assets exceed the ${MAX_RELEASE_BYTES}-byte total download limit.`)
    }
    totalBytes += asset.size
  }
  return totalBytes
}

/** Downloads every required file to private temporary storage and verifies all published digests. */
export async function downloadReleaseAssets(
  release: ReleaseInfo,
  destinationDirectory: string,
  clientVersion: string,
  fetchImpl: typeof globalThis.fetch,
  onProgress: DownloadProgress,
): Promise<DownloadedAsset[]> {
  const totalBytes = validateAssetSizes(release.assets)
  await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
  const downloaded: DownloadedAsset[] = []
  let precedingBytes = 0
  for (const [index, asset] of release.assets.entries()) {
    const destination = path.join(
      destinationDirectory,
      `${index}-${safeFilePart(asset.name)}-${randomUUID()}.download`,
    )
    await downloadAsset(asset, destination, clientVersion, fetchImpl, (bytes, bytesPerSecond) => {
      onProgress({
        bytesTransferred: precedingBytes + bytes,
        totalBytes,
        bytesPerSecond,
      })
    })
    downloaded.push({ asset, path: destination })
    precedingBytes += asset.size
  }
  onProgress({ bytesTransferred: totalBytes, totalBytes })
  return downloaded
}

interface TarEntry {
  kind: 'file' | 'directory'
  name: string
  size: number
}

function parseTarName(value: string): string {
  let name: unknown
  try {
    name = JSON.parse(value)
  } catch (error) {
    throw new Error('Hyperion archive contains a filename that cannot be validated safely.', {
      cause: error,
    })
  }
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\')) {
    throw new Error('Hyperion archive contains an unsafe filename.')
  }
  return name
}

function unsafeWindowsSegment(segment: string): boolean {
  for (const character of segment) {
    const code = character.charCodeAt(0)
    if (code < 32 || '<>:"|?*'.includes(character)) {
      return true
    }
  }
  return /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
}

function validateArchiveEntry(entry: TarEntry, platform: NodeJS.Platform = 'linux'): void {
  const name = entry.name
  if (!name || name.includes('\0') || name.includes('\\')) {
    throw new Error('Hyperion archive contains an unsafe filename.')
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Hyperion archive contains an absolute path: ${name}`)
  }
  const segments = name.split('/')
  if (segments.includes('..')) {
    throw new Error(`Hyperion archive contains a parent-directory path: ${name}`)
  }
  const meaningfulSegments = segments.filter(segment => segment && segment !== '.')
  if (!meaningfulSegments.length && entry.kind !== 'directory') {
    throw new Error('Hyperion archive contains an invalid file entry.')
  }
  if (meaningfulSegments.length > MAX_ARCHIVE_DEPTH) {
    throw new Error(`Hyperion archive exceeds the ${MAX_ARCHIVE_DEPTH}-level path depth limit.`)
  }
  if (
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    (entry.kind === 'file' && entry.size > MAX_EXTRACTED_FILE_BYTES)
  ) {
    throw new Error(`Hyperion archive contains an invalid or excessive file size: ${name}`)
  }
  for (const segment of meaningfulSegments) {
    const lower = segment.toLowerCase()
    if (lower === 'game' || lower === 'zero' || /^(?:zero|game)[._-]/i.test(segment)) {
      throw new Error(`Hyperion archive contains forbidden Game/Zero content: ${name}`)
    }
    if (platform === 'win32' && unsafeWindowsSegment(segment)) {
      throw new Error(`Hyperion ZIP contains an unsafe Windows filename: ${name}`)
    }
    const extension = path.posix.extname(lower)
    const allowedWindowsBinary = name === 'Hyperion.exe' || name === 'SDL3.dll'
    if (
      FORBIDDEN_GAME_EXTENSIONS.has(extension) &&
      !(platform === 'win32' && allowedWindowsBinary)
    ) {
      throw new Error(
        `Hyperion archive contains a forbidden executable, library, or game data: ${name}`,
      )
    }
  }
}

/** Validates GNU tar's machine-quoted type and pathname columns before extraction starts. */
export function parseTarListing(listing: string): TarEntry[] {
  const entries: TarEntry[] = []
  let uncompressedBytes = 0
  for (const line of listing.split('\n')) {
    if (!line.trim()) {
      continue
    }
    if (entries.length >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Hyperion archive exceeds the ${MAX_ARCHIVE_ENTRIES}-entry limit.`)
    }
    const match = /^(.{10}) \d+\/\d+\s+(\d+) \d{4}-\d{2}-\d{2} \d{2}:\d{2} (.+)$/.exec(line)
    if (!match) {
      throw new Error('Could not validate the Hyperion archive directory listing.')
    }
    if (match[1][0] !== '-' && match[1][0] !== 'd') {
      throw new Error(
        'Hyperion archives may contain only regular files and directories; links and special files are forbidden.',
      )
    }
    const name = parseTarName(match[3])
    const entry: TarEntry = {
      kind: match[1][0] === 'd' ? 'directory' : 'file',
      name,
      size: Number(match[2]),
    }
    validateArchiveEntry(entry)
    if (entry.kind === 'file') {
      if (entry.size > MAX_ARCHIVE_UNCOMPRESSED_BYTES - uncompressedBytes) {
        throw new Error(
          `Hyperion archive exceeds the ${MAX_ARCHIVE_UNCOMPRESSED_BYTES}-byte uncompressed size limit.`,
        )
      }
      uncompressedBytes += entry.size
    }
    entries.push(entry)
  }
  if (!entries.length) {
    throw new Error('Hyperion archive is empty.')
  }
  return entries
}

interface ExtractedTreeUsage {
  entries: number
  uncompressedBytes: number
}

async function validateExtractedTree(
  directory: string,
  platform: NodeJS.Platform = 'linux',
  relative = '',
  usage: ExtractedTreeUsage = { entries: 0, uncompressedBytes: 0 },
): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true })
  for (const entry of entries) {
    usage.entries += 1
    if (usage.entries > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Extracted Hyperion files exceed the ${MAX_ARCHIVE_ENTRIES}-entry limit.`)
    }
    const entryRelative = path.join(relative, entry.name)
    const entryPath = path.join(directory, entryRelative)
    const stat = await fs.lstat(entryPath)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(
        `Hyperion archive extracted a forbidden link or special file: ${entryRelative}`,
      )
    }
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(`Hyperion archive extracted a hard link: ${entryRelative}`)
    }
    validateArchiveEntry(
      {
        kind: stat.isDirectory() ? 'directory' : 'file',
        name: entryRelative.split(path.sep).join('/'),
        size: stat.isFile() ? stat.size : 0,
      },
      platform,
    )
    if (stat.isDirectory()) {
      files.push(...(await validateExtractedTree(directory, platform, entryRelative, usage)))
    } else {
      if (stat.size > MAX_ARCHIVE_UNCOMPRESSED_BYTES - usage.uncompressedBytes) {
        throw new Error(
          `Extracted Hyperion files exceed the ${MAX_ARCHIVE_UNCOMPRESSED_BYTES}-byte uncompressed size limit.`,
        )
      }
      usage.uncompressedBytes += stat.size
      files.push(entryRelative)
    }
  }
  return files
}

async function extractHyperionArchive(archivePath: string, destination: string): Promise<void> {
  let listing: string
  try {
    const result = await execFileAsync(
      'tar',
      ['-tvzf', archivePath, '--numeric-owner', '--quoting-style=c'],
      { maxBuffer: TAR_LIST_LIMIT_BYTES, windowsHide: true },
    )
    listing = result.stdout
  } catch (error) {
    throw new Error(`Could not inspect the Hyperion archive: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  parseTarListing(listing)
  await fs.mkdir(destination, { recursive: false, mode: 0o700 })
  try {
    await execFileAsync(
      'tar',
      [
        '-xzf',
        archivePath,
        '-C',
        destination,
        '--no-same-owner',
        '--no-same-permissions',
        '--delay-directory-restore',
        '--keep-old-files',
      ],
      { windowsHide: true },
    )
  } catch (error) {
    throw new Error(`Could not extract the Hyperion archive safely: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  await validateExtractedTree(destination)
}

async function copyBundledData(appPath: string, destination: string): Promise<void> {
  const source = path.resolve(appPath, '..', 'hyperion', 'Data')
  try {
    const stat = await fs.lstat(source)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('bundled Data is not a regular directory')
    }
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  } catch (error) {
    throw new Error(
      `Hyperion's bundled Data directory is missing or unreadable. Reinstall HyperShield and try again: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

function executableName(architecture: string): string {
  return architecture === 'arm64' ? 'Hyperion.aarch64' : 'Hyperion.x86_64'
}

async function validateWindowsReleaseMetadata(workingDirectory: string): Promise<void> {
  const metadataPath = path.join(workingDirectory, 'release.json')
  const stat = await fs.lstat(metadataPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RELEASE_METADATA_BYTES) {
    throw new Error('Hyperion ZIP release.json is not a bounded regular file.')
  }
  let release: unknown
  try {
    release = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`Hyperion ZIP release.json is unreadable: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  if (typeof release !== 'object' || release === null) {
    throw new Error('Hyperion ZIP release.json is invalid.')
  }
  const { product, gameFilesBundled, version } = release as {
    product?: unknown
    gameFilesBundled?: unknown
    version?: unknown
  }
  if (
    (product !== 'HyperShield Shield' && product !== 'Hyperion Shield') ||
    gameFilesBundled !== false ||
    typeof version !== 'string' ||
    !version
  ) {
    throw new Error(
      'Hyperion ZIP release.json is not for public Hyperion Shield without game files.',
    )
  }
}

async function stageWindowsHyperion(
  downloaded: DownloadedAsset[],
  stagingDirectory: string,
): Promise<string> {
  if (downloaded.length !== 1) {
    throw new Error('Windows Hyperion releases must contain exactly one ZIP package.')
  }
  await extractHyperionZip(
    downloaded[0].path,
    stagingDirectory,
    {
      maxArchiveBytes: MAX_ASSET_BYTES,
      maxEntries: MAX_ARCHIVE_ENTRIES,
      maxFileBytes: MAX_EXTRACTED_FILE_BYTES,
      maxUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    },
    entry => validateArchiveEntry(entry, 'win32'),
  )
  await validateExtractedTree(stagingDirectory, 'win32')
  const requiredFiles = ['Hyperion.exe', 'SDL3.dll', 'release.json', 'EDITION.txt']
  for (const name of requiredFiles) {
    const stat = await fs.lstat(path.join(stagingDirectory, name)).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Hyperion ZIP must include ${name} at its root.`)
    }
  }
  const data = await fs.lstat(path.join(stagingDirectory, 'Data')).catch(() => undefined)
  if (!data?.isDirectory() || data.isSymbolicLink()) {
    throw new Error('Hyperion ZIP must include Data at its root.')
  }
  await validateWindowsReleaseMetadata(stagingDirectory)
  try {
    await Promise.all([
      validatePe32PlusAmd64File(path.join(stagingDirectory, 'Hyperion.exe')),
      validatePe32PlusAmd64File(path.join(stagingDirectory, 'SDL3.dll')),
    ])
  } catch (error) {
    throw new Error(`Hyperion ZIP contains an invalid native binary: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  return 'Hyperion.exe'
}

async function stageHyperion(
  release: ReleaseInfo,
  downloaded: DownloadedAsset[],
  stagingDirectory: string,
  appPath: string,
  platform: NodeJS.Platform,
  architecture: string,
): Promise<string> {
  if (platform === 'win32') {
    if (release.packageKind !== 'archive') {
      throw new Error('Windows Hyperion releases require a complete ZIP package.')
    }
    return stageWindowsHyperion(downloaded, stagingDirectory)
  }
  const name = executableName(architecture)
  if (release.packageKind === 'raw') {
    await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 })
    const executable = downloaded.find(candidate => candidate.asset.name === name)
    const library = downloaded.find(candidate => candidate.asset.name === 'libSDL3.so.0')
    if (!executable || !library) {
      throw new Error('Hyperion download did not contain its executable and SDL library.')
    }
    await fs.copyFile(executable.path, path.join(stagingDirectory, name), fsConstants.COPYFILE_EXCL)
    await fs.copyFile(
      library.path,
      path.join(stagingDirectory, 'libSDL3.so.0'),
      fsConstants.COPYFILE_EXCL,
    )
    await copyBundledData(appPath, path.join(stagingDirectory, 'Data'))
    await fs.chmod(path.join(stagingDirectory, name), 0o755)
    return name
  }
  if (release.packageKind !== 'archive') {
    throw new Error('This Hyperion release has no compatible installation package.')
  }
  await extractHyperionArchive(downloaded[0].path, stagingDirectory)
  const files = await validateExtractedTree(stagingDirectory)
  const executables = files.filter(file => path.basename(file) === name)
  if (executables.length !== 1) {
    throw new Error(
      executables.length
        ? 'Hyperion archive contains more than one executable for this architecture.'
        : `Hyperion archive does not contain ${name}.`,
    )
  }
  const executablePath = path.join(stagingDirectory, executables[0])
  const workingDirectory = path.dirname(executablePath)
  const [library, data] = await Promise.all([
    fs.lstat(path.join(workingDirectory, 'libSDL3.so.0')).catch(() => undefined),
    fs.lstat(path.join(workingDirectory, 'Data')).catch(() => undefined),
  ])
  if (
    !library?.isFile() ||
    library.isSymbolicLink() ||
    !data?.isDirectory() ||
    data.isSymbolicLink()
  ) {
    throw new Error('Hyperion archive must include libSDL3.so.0 and Data beside its executable.')
  }
  await fs.chmod(executablePath, 0o755)
  return executables[0]
}

async function stageHyperShield(
  release: ReleaseInfo,
  downloaded: DownloadedAsset[],
  stagingDirectory: string,
): Promise<string> {
  if (release.packageKind !== 'appImage' || downloaded.length !== 1) {
    throw new Error('This HyperShield release has no compatible AppImage.')
  }
  await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 })
  const executablePath = safeFilePart(release.assets[0].name)
  await fs.copyFile(
    downloaded[0].path,
    path.join(stagingDirectory, executablePath),
    fsConstants.COPYFILE_EXCL,
  )
  await fs.chmod(path.join(stagingDirectory, executablePath), 0o755)
  return executablePath
}

/** Stages a complete install beside its final destination, then publishes it with one rename. */
export async function installDownloadedRelease(options: {
  userDataPath: string
  appPath: string
  product: ReleaseProduct
  release: ReleaseInfo
  platform: NodeJS.Platform
  architecture: string
  clientVersion: string
  fetchImpl?: typeof globalThis.fetch
  onProgress?: DownloadProgress
  onDownloaded?: () => void
}): Promise<InstalledReleaseRecord> {
  const {
    userDataPath,
    appPath,
    product,
    release,
    platform,
    architecture,
    clientVersion,
    onProgress = () => {},
  } = options
  if (!supportsReleaseInstallation(product, platform, architecture)) {
    throw new Error(
      `${product} release installation is not available on ${platform} ${architecture}.`,
    )
  }
  if (release.packageKind === 'none') {
    throw new Error(release.unavailableReason ?? 'This release has no compatible package.')
  }
  if (
    platform === 'win32' &&
    (release.packageKind !== 'archive' ||
      release.assets.length !== 1 ||
      !release.assets[0].name.toLowerCase().endsWith('.zip') ||
      !/^[a-f0-9]{64}$/i.test(release.assets[0].sha256 ?? ''))
  ) {
    throw new Error(
      'Windows Hyperion ZIP packages require one asset with a published SHA-256 digest.',
    )
  }

  await fs.mkdir(releaseCenterPath(userDataPath), { recursive: true, mode: 0o700 })
  const downloadDirectory = await fs.mkdtemp(
    path.join(releaseCenterPath(userDataPath), 'download-'),
  )
  const installRoot = releaseCenterInstallRoot(userDataPath, product)
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 })
  const stagingDirectory = path.join(installRoot, `.staging-${randomUUID()}`)
  const directoryName = `${safeFilePart(release.version)}-${createHash('sha256')
    .update(release.id)
    .digest('hex')
    .slice(0, 12)}-${randomUUID().slice(0, 8)}`
  const finalDirectory = path.join(installRoot, directoryName)
  try {
    const downloaded = await downloadReleaseAssets(
      release,
      downloadDirectory,
      clientVersion,
      options.fetchImpl ?? globalThis.fetch,
      onProgress,
    )
    options.onDownloaded?.()
    const relativeExecutable =
      product === 'hyperion'
        ? await stageHyperion(
            release,
            downloaded,
            stagingDirectory,
            appPath,
            platform,
            architecture,
          )
        : await stageHyperShield(release, downloaded, stagingDirectory)
    try {
      await fs.lstat(finalDirectory)
      throw new Error('A unique installation directory could not be allocated.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await fs.rename(stagingDirectory, finalDirectory)
    const record: InstalledReleaseRecord = {
      releaseId: release.id,
      version: release.version,
      tag: release.tag,
      channel: release.channel,
      installedAt: new Date().toISOString(),
      packageKind: release.packageKind,
      directoryName,
      executablePath: relativeExecutable,
      platform,
      architecture,
    }
    const resolved = installedReleaseExecutable(userDataPath, product, record)
    if (!resolved.startsWith(`${finalDirectory}${path.sep}`)) {
      throw new Error('Installed executable escaped its staging directory.')
    }
    return record
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    await fs.rm(downloadDirectory, { recursive: true, force: true }).catch(() => {})
  }
}
