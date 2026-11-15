import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs, constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  METALSHARP_WINE_DOWNLOAD_BYTES,
  METALSHARP_WINE_VERSION,
} from '../../../common/pluto-runtime'
import type { ReleaseAsset } from '../../../common/release-center'
import { validateMachOArm64File } from '../../releases/macho'
import { validatePeFile } from '../../releases/pe'
import { computeFileSha256, errorMessage } from '../../releases/storage'

export const METALSHARP_WINE_ARCHIVE_ASSET = {
  name: 'MetalSharp-Wine-6.0-arm64.zip',
  url: 'https://github.com/metalsharp/MetalSharp-Wine/releases/download/v6.0/MetalSharp-Wine-6.0-arm64.zip',
  size: METALSHARP_WINE_DOWNLOAD_BYTES,
  sha256: '25f7dff91000c03c835b800980878acb12c1f952a4b7853f77de7f21fb87046f',
} as const satisfies ReleaseAsset

export const METALSHARP_WINE_BUNDLE_NAME = `MetalSharp-Wine-${METALSHARP_WINE_VERSION}.app`
const OFFICIAL_BUNDLE_NAME = 'MetalSharp-Wine.app'
const WINE_RELATIVE_PATH = path.join('Contents', 'MacOS', 'wine')
const LOADER_APP_RELATIVE_PATH = path.join('Contents', 'lib', 'wine', 'aarch64-unix', 'wine.app')
const COMMAND_TIMEOUT_MS = 120_000
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024

export interface MacCommandResult {
  stdout: string
  stderr: string
}

export type MacCommandRunner = (
  executablePath: string,
  args: readonly string[],
) => Promise<MacCommandResult>

const runMacCommand: MacCommandRunner = (executablePath, args) =>
  new Promise((resolve, reject) => {
    execFile(
      executablePath,
      [...args],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(error.message, { cause: error }))
        } else {
          resolve({ stdout, stderr })
        }
      },
    )
  })

export function metalSharpWineAppPath(homeDirectory: string = os.homedir()): string {
  return path.join(
    homeDirectory,
    'Library',
    'Application Support',
    'Hyperion',
    METALSHARP_WINE_BUNDLE_NAME,
  )
}

export function metalSharpWineExecutablePath(appPath: string): string {
  return path.join(appPath, WINE_RELATIVE_PATH)
}

async function run(
  runner: MacCommandRunner,
  executablePath: string,
  args: readonly string[],
): Promise<MacCommandResult> {
  try {
    return await runner(executablePath, args)
  } catch (error) {
    throw new Error(
      `MetalSharp Wine command failed (${path.basename(executablePath)}): ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

async function requireDirectory(directoryPath: string, label: string): Promise<void> {
  const stat = await fs.lstat(directoryPath).catch(() => undefined)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`MetalSharp Wine ${label} must be a real directory: ${directoryPath}`)
  }
}

async function requireFile(
  filePath: string,
  label: string,
  options: { executable?: boolean; machO?: 'executable' | 'dynamicLibrary'; pe?: boolean } = {},
): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`MetalSharp Wine ${label} must be a non-empty regular file: ${filePath}`)
  }
  if (options.executable) {
    await fs.access(filePath, fsConstants.X_OK)
  }
  if (options.machO) {
    await validateMachOArm64File(filePath, options.machO)
  }
  if (options.pe) {
    await validatePeFile(filePath)
  }
}

async function requireSymlink(
  linkPath: string,
  expectedTarget: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(linkPath).catch(() => undefined)
  if (!stat?.isSymbolicLink() || (await fs.readlink(linkPath)) !== expectedTarget) {
    throw new Error(
      `MetalSharp Wine ${label} must be the official ${expectedTarget} symlink: ${linkPath}`,
    )
  }
}

function xmlTrueEntitlement(contents: string, entitlement: string): boolean {
  const escaped = entitlement.replaceAll('.', '\\.')
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`, 'i').test(contents)
}

async function verifyProvisioningProfile(
  profilePath: string,
  runner: MacCommandRunner,
): Promise<void> {
  await requireFile(profilePath, 'embedded provisioning profile')
  const { stdout } = await run(runner, '/usr/bin/security', ['cms', '-D', '-i', profilePath])
  if (!xmlTrueEntitlement(stdout, 'com.apple.developer.cross-architecture-support')) {
    throw new Error('MetalSharp Wine provisioning profile lacks cross-architecture support.')
  }
  const applicationIdentifier = stdout.match(
    /<key>\s*com\.apple\.application-identifier\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i,
  )?.[1]
  if (!applicationIdentifier?.endsWith('.com.metalsharp.wine')) {
    throw new Error('MetalSharp Wine provisioning profile has the wrong application identifier.')
  }
}

async function verifyCodeSignature(
  appPath: string,
  loaderAppPath: string,
  runner: MacCommandRunner,
): Promise<void> {
  await run(runner, '/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const details = await run(runner, '/usr/bin/codesign', ['-dv', '--verbose=4', appPath])
  const identity = `${details.stdout}\n${details.stderr}`
  if (
    !/^Identifier=com\.metalsharp\.wine$/m.test(identity) ||
    !/^Authority=Developer ID Application:/m.test(identity)
  ) {
    throw new Error('MetalSharp Wine does not have its official Developer ID signature identity.')
  }

  for (const bundlePath of [appPath, loaderAppPath]) {
    const entitlements = await run(runner, '/usr/bin/codesign', [
      '-d',
      '--entitlements',
      ':-',
      '--xml',
      bundlePath,
    ])
    if (
      !xmlTrueEntitlement(
        `${entitlements.stdout}\n${entitlements.stderr}`,
        'com.apple.developer.cross-architecture-support',
      )
    ) {
      throw new Error('MetalSharp Wine signature lacks cross-architecture support.')
    }
  }
}

async function readBundleInfo(
  infoPath: string,
  runner: MacCommandRunner,
): Promise<Record<string, unknown>> {
  await requireFile(infoPath, 'bundle Info.plist')
  const { stdout } = await run(runner, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath])
  try {
    const value: unknown = JSON.parse(stdout)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('the property list is not a dictionary')
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new Error(`MetalSharp Wine Info.plist is invalid: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

/** Verifies the complete signed runtime without changing any system Wine installation. */
export async function verifyMetalSharpWineApp(
  appPath: string,
  runner: MacCommandRunner = runMacCommand,
): Promise<void> {
  const loaderAppPath = path.join(appPath, LOADER_APP_RELATIVE_PATH)
  const unixDirectory = path.dirname(loaderAppPath)
  const windowsDirectory = path.join(appPath, 'Contents', 'lib', 'wine', 'aarch64-windows')

  await requireDirectory(appPath, 'application bundle')
  await requireDirectory(loaderAppPath, 'inner loader bundle')
  await requireFile(metalSharpWineExecutablePath(appPath), 'outer ARM64 loader', {
    executable: true,
    machO: 'executable',
  })
  await requireFile(path.join(loaderAppPath, WINE_RELATIVE_PATH), 'inner ARM64 loader', {
    executable: true,
    machO: 'executable',
  })
  await requireSymlink(path.join(appPath, 'Contents', 'bin'), 'MacOS', 'Contents/bin link')
  await requireSymlink(
    path.join(unixDirectory, 'wine'),
    'wine.app/Contents/MacOS/wine',
    'Unix Wine link',
  )

  for (const name of ['libarm64ecfex', 'libwow64fex']) {
    await requireFile(path.join(unixDirectory, `${name}.so`), `${name} ARM64 Unix library`, {
      machO: 'dynamicLibrary',
    })
    await requireFile(path.join(windowsDirectory, `${name}.dll`), `${name} Windows library`, {
      pe: true,
    })
  }

  // Bundle metadata and profiles are checked before running the signed version probe.
  const outerInfo = await readBundleInfo(path.join(appPath, 'Contents', 'Info.plist'), runner)
  if (
    outerInfo.CFBundleIdentifier !== 'com.metalsharp.wine' ||
    outerInfo.CFBundleExecutable !== 'wine' ||
    outerInfo.CFBundleName !== 'MetalSharp Wine' ||
    outerInfo.CFBundleShortVersionString !== METALSHARP_WINE_VERSION ||
    typeof outerInfo.CFBundleGetInfoString !== 'string' ||
    !outerInfo.CFBundleGetInfoString.includes('Wine 11.20') ||
    !outerInfo.CFBundleGetInfoString.includes('arm64') ||
    !outerInfo.CFBundleGetInfoString.includes('FEX')
  ) {
    throw new Error('MetalSharp Wine is not the pinned Wine 11.20 ARM64/FEX 6.0 application.')
  }
  const loaderInfo = await readBundleInfo(
    path.join(loaderAppPath, 'Contents', 'Info.plist'),
    runner,
  )
  if (
    loaderInfo.CFBundleIdentifier !== 'com.metalsharp.wine' ||
    loaderInfo.CFBundleExecutable !== 'wine' ||
    loaderInfo.CFBundleName !== 'MetalSharp Wine' ||
    loaderInfo.CFBundleShortVersionString !== '11.20'
  ) {
    throw new Error('MetalSharp Wine inner loader is not the Wine 11.20 MetalSharp application.')
  }

  await verifyProvisioningProfile(
    path.join(appPath, 'Contents', 'embedded.provisionprofile'),
    runner,
  )
  await verifyProvisioningProfile(
    path.join(loaderAppPath, 'Contents', 'embedded.provisionprofile'),
    runner,
  )
  await verifyCodeSignature(appPath, loaderAppPath, runner)

  const version = await run(runner, metalSharpWineExecutablePath(appPath), ['--version'])
  if (
    !/^wine-11(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?\s+\(MetalSharp Wine [^)]+\)\s*$/m.test(
      version.stdout.trim(),
    )
  ) {
    throw new Error(
      'MetalSharp Wine version probe did not report Wine 11 with MetalSharp identity.',
    )
  }
}

export async function isMetalSharpWineInstalled(
  appPath: string,
  runner: MacCommandRunner = runMacCommand,
): Promise<boolean> {
  try {
    await verifyMetalSharpWineApp(appPath, runner)
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function publishMetalSharpWine(sourceApp: string, destination: string): Promise<void> {
  const parent = path.dirname(destination)
  const backup = path.join(parent, `.metalsharp-wine-backup-${randomUUID()}`)
  const hadExisting = await pathExists(destination)
  if (hadExisting) await fs.rename(destination, backup)

  try {
    await fs.rename(sourceApp, destination)
  } catch (error) {
    if (hadExisting) {
      try {
        await fs.rename(backup, destination)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `MetalSharp Wine replacement failed and the previous runtime could not be restored. It remains at ${backup}.`,
          { cause: restoreError },
        )
      }
    }
    throw error
  }

  if (hadExisting) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
}

export interface InstallMetalSharpWineArchiveOptions {
  archivePath: string
  destination: string
  runner?: MacCommandRunner
  /** Small host-side fixture metadata; production callers always use the pinned official asset. */
  archiveAsset?: ReleaseAsset
}

/** Hashes before ditto extraction, verifies in owned staging, then atomically publishes the app. */
export async function installMetalSharpWineArchive(
  options: InstallMetalSharpWineArchiveOptions,
): Promise<void> {
  const asset = options.archiveAsset ?? METALSHARP_WINE_ARCHIVE_ASSET
  const archiveStat = await fs.lstat(options.archivePath).catch(() => undefined)
  if (!archiveStat?.isFile() || archiveStat.isSymbolicLink() || archiveStat.size !== asset.size) {
    throw new Error(
      `MetalSharp Wine archive must be a regular ${asset.size}-byte file: ${options.archivePath}`,
    )
  }
  const actualHash = await computeFileSha256(options.archivePath)
  if (actualHash !== asset.sha256?.toLowerCase()) {
    throw new Error(
      `SHA-256 verification failed for ${asset.name}. Expected ${asset.sha256}, received ${actualHash}.`,
    )
  }

  const parent = path.dirname(options.destination)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const stagingDirectory = path.join(parent, `.metalsharp-wine-staging-${randomUUID()}`)
  await fs.mkdir(stagingDirectory, { mode: 0o700 })
  const runner = options.runner ?? runMacCommand
  try {
    await run(runner, '/usr/bin/ditto', ['-x', '-k', options.archivePath, stagingDirectory])
    const entries = await fs.readdir(stagingDirectory)
    if (entries.length !== 1 || entries[0] !== OFFICIAL_BUNDLE_NAME) {
      throw new Error('MetalSharp Wine archive must contain exactly MetalSharp-Wine.app.')
    }
    const stagedApp = path.join(stagingDirectory, OFFICIAL_BUNDLE_NAME)
    await verifyMetalSharpWineApp(stagedApp, runner)
    await publishMetalSharpWine(stagedApp, options.destination)
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
  }
}
