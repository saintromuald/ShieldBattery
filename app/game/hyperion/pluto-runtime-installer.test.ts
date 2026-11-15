import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  METALSHARP_WINE_DOWNLOAD_BYTES,
  PLUTO_MACOS_DOWNLOAD_BYTES,
  PLUTO_RUNTIME_DOWNLOAD_BYTES,
} from '../../../common/pluto-runtime'
import type { downloadReleaseAssets } from '../../releases/installer'
import { computeFileSha256 } from '../../releases/storage'
import { makePe32X86, makeZip, type ZipFixtureEntry } from '../../releases/testing/fixtures'
import {
  installPlutoArchive,
  installPlutoRuntime,
  isPlutoRuntimeInstalled,
  PLUTO_ARCHIVE_ASSET,
  PLUTO_PAYLOAD_SHA256,
  type PlutoPayloadHashes,
  type PlutoPayloadName,
  resolvePlutoBridgePath,
  stagePlutoRuntimeArchive,
} from './pluto-runtime-installer'
import {
  type InstallMetalSharpWineArchiveOptions,
  METALSHARP_WINE_ARCHIVE_ASSET,
  metalSharpWineAppPath,
} from './pluto-wine-runtime'

vi.mock('../../logger', () => ({ default: { warning: vi.fn() } }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/unused/app',
    getPath: () => '/unused/user-data',
  },
}))

const OFFICIAL_ARCHIVE_PATH =
  '/home/saintbellarmine/.cache/opencode-release-verification/pluto-v2.0-official/pluto-v2.0.zip'
const OFFICIAL_ARCHIVE_AVAILABLE = existsSync(OFFICIAL_ARCHIVE_PATH)

let temporaryDirectory: string
let activeBridgePath: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-pluto-installer-test-'))
  activeBridgePath = path.join(temporaryDirectory, 'engine', 'Data', 'pluto', 'pluto-bridge.exe')
  await fs.mkdir(path.dirname(activeBridgePath), { recursive: true })
  await fs.writeFile(activeBridgePath, makePe32X86())
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

const PAYLOAD_CONTENTS: Record<PlutoPayloadName, string> = {
  'pluto.dll': 'test Pluto DLL',
  'pluto/pluto_infer.exe': 'test Pluto inference executable',
  'pluto/pluto_weights.bin': 'test Pluto weights',
}

function digest(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex')
}

const TEST_HASHES: PlutoPayloadHashes = Object.fromEntries(
  Object.entries(PAYLOAD_CONTENTS).map(([name, contents]) => [name, digest(contents)]),
) as unknown as PlutoPayloadHashes

function payloadEntries(): ZipFixtureEntry[] {
  return [
    { name: 'README.txt', contents: 'Official Pluto readme' },
    { name: 'pluto/', kind: 'directory' },
    ...Object.entries(PAYLOAD_CONTENTS).map(([name, contents]) => ({ name, contents })),
  ]
}

async function writeArchive(entries = payloadEntries()): Promise<string> {
  const archivePath = path.join(temporaryDirectory, 'pluto-test.zip')
  await fs.writeFile(archivePath, makeZip(entries))
  return archivePath
}

function destination(): string {
  return path.join(temporaryDirectory, 'user-data', 'hyperion-test', 'pluto')
}

function installFixtureArchive(
  installPath = destination(),
  expectedHashes: PlutoPayloadHashes = TEST_HASHES,
) {
  return writeArchive().then(archivePath =>
    installPlutoArchive({
      archivePath,
      destination: installPath,
      activeBridgePath,
      expectedHashes,
    }),
  )
}

describe('Pluto runtime archive installation', () => {
  it('pins the official archive URL, exact size, and all official hashes', () => {
    expect(PLUTO_ARCHIVE_ASSET).toEqual({
      name: 'pluto-v2.0.zip',
      url: 'https://github.com/tscmoo/pluto/releases/download/v2.0/pluto-v2.0.zip',
      size: PLUTO_RUNTIME_DOWNLOAD_BYTES,
      sha256: '17544fc3ab32e3e2823646887e021cf998362348d73740817e94d1a78aa6209d',
    })
    expect(PLUTO_ARCHIVE_ASSET.size).toBe(309686477)
    expect(PLUTO_PAYLOAD_SHA256).toEqual({
      'pluto.dll': '603fea2f77a4b652f29b832c2977cf5bc9d83bbcb927febd04499220020ce3bc',
      'pluto/pluto_infer.exe': '3f2814a51034b9817b396e52b38d30341ede506a2baedc7cbc11cb6ebcece2cc',
      'pluto/pluto_weights.bin': 'c53a559b4910777dc0e1c561c0d89d243091f465d8e9fc0f5f72e56597067d86',
    })
  })

  it('allows the known README and requires the exact five-entry archive layout', async () => {
    const installPath = destination()
    await installFixtureArchive(installPath)
    expect(await fs.readFile(path.join(installPath, 'README.txt'), 'utf8')).toBe(
      'Official Pluto readme',
    )

    const withoutReadme = payloadEntries().filter(entry => entry.name !== 'README.txt')
    await expect(
      installPlutoArchive({
        archivePath: await writeArchive(withoutReadme),
        destination: path.join(temporaryDirectory, 'missing-readme'),
        activeBridgePath,
        expectedHashes: TEST_HASHES,
      }),
    ).rejects.toThrow('exactly its README, directory, and three payloads')
  })

  it.runIf(OFFICIAL_ARCHIVE_AVAILABLE)(
    'verifies and installs the actual official five-entry archive into temporary storage',
    { timeout: 60_000 },
    async () => {
      const stat = await fs.stat(OFFICIAL_ARCHIVE_PATH)
      expect(stat.size).toBe(PLUTO_RUNTIME_DOWNLOAD_BYTES)
      expect(await computeFileSha256(OFFICIAL_ARCHIVE_PATH)).toBe(PLUTO_ARCHIVE_ASSET.sha256)

      const installPath = path.join(temporaryDirectory, 'official-archive-extraction')
      await installPlutoArchive({
        archivePath: OFFICIAL_ARCHIVE_PATH,
        destination: installPath,
        activeBridgePath,
      })

      expect(await isPlutoRuntimeInstalled(installPath)).toBe(true)
      expect((await fs.lstat(path.join(installPath, 'README.txt'))).isFile()).toBe(true)
      expect(await fs.readFile(path.join(installPath, 'pluto-bridge.exe'))).toEqual(
        await fs.readFile(activeBridgePath),
      )
    },
  )

  it('copies the 32-bit Hyperion bridge and installs a complete four-component runtime', async () => {
    const installPath = destination()
    await fs.mkdir(installPath, { recursive: true })
    await fs.writeFile(path.join(installPath, 'stale-file'), 'old runtime')

    await installFixtureArchive(installPath)

    expect(await isPlutoRuntimeInstalled(installPath, TEST_HASHES)).toBe(true)
    expect(await fs.readFile(path.join(installPath, 'pluto.dll'), 'utf8')).toBe(
      PAYLOAD_CONTENTS['pluto.dll'],
    )
    expect(await fs.readFile(path.join(installPath, 'pluto', 'pluto_infer.exe'), 'utf8')).toBe(
      PAYLOAD_CONTENTS['pluto/pluto_infer.exe'],
    )
    expect(await fs.readFile(path.join(installPath, 'pluto', 'pluto_weights.bin'), 'utf8')).toBe(
      PAYLOAD_CONTENTS['pluto/pluto_weights.bin'],
    )
    expect(await fs.readFile(path.join(installPath, 'pluto-bridge.exe'))).toEqual(
      await fs.readFile(activeBridgePath),
    )
    await expect(fs.lstat(path.join(installPath, 'stale-file'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const siblings = await fs.readdir(path.dirname(installPath))
    expect(siblings.some(name => name.startsWith('.pluto-staging-'))).toBe(false)
    expect(siblings.some(name => name.startsWith('.pluto-backup-'))).toBe(false)
  })

  it('requires the Hyperion bridge and Linux inference execute permission for readiness', async () => {
    const staging = path.join(temporaryDirectory, 'incomplete-runtime')
    await stagePlutoRuntimeArchive(await writeArchive(), staging, TEST_HASHES)
    expect(await isPlutoRuntimeInstalled(staging, TEST_HASHES)).toBe(false)

    await fs.copyFile(activeBridgePath, path.join(staging, 'pluto-bridge.exe'))
    expect(await isPlutoRuntimeInstalled(staging, TEST_HASHES)).toBe(true)

    await fs.chmod(path.join(staging, 'pluto', 'pluto_infer.exe'), 0o600)
    expect(await isPlutoRuntimeInstalled(staging, TEST_HASHES, 'linux')).toBe(false)
    expect(await isPlutoRuntimeInstalled(staging, TEST_HASHES, 'win32')).toBe(true)
  })

  it.each(['missing', 'invalid'] as const)(
    'fails before any download when the active bridge is %s',
    async kind => {
      const bridgePath = path.join(temporaryDirectory, `${kind}-bridge.exe`)
      if (kind === 'invalid') {
        await fs.writeFile(bridgePath, 'not a PE file')
      }
      const fetchImpl = vi.fn<typeof globalThis.fetch>()

      await expect(
        installPlutoRuntime({
          dataPath: path.join(temporaryDirectory, 'data'),
          installPath: path.join(temporaryDirectory, 'data', 'pluto'),
          activeBridgePath: bridgePath,
          clientVersion: '12.3.13',
          fetchImpl,
        }),
      ).rejects.toThrow('Pluto AI bridge')
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it('resolves the bridge from the selected downloaded Hyperion working directory', async () => {
    const appPath = path.join(temporaryDirectory, 'package', 'resources', 'app')
    const selectedWorkingDirectory = path.join(temporaryDirectory, 'selected-hyperion')
    const selectedBridge = path.join(selectedWorkingDirectory, 'Data', 'pluto', 'pluto-bridge.exe')
    await fs.mkdir(path.dirname(selectedBridge), { recursive: true })
    await fs.writeFile(selectedBridge, makePe32X86())
    const readDownloadedInstall = vi.fn(async () => ({
      executablePath: path.join(selectedWorkingDirectory, 'Hyperion.x86_64'),
      workingDirectory: selectedWorkingDirectory,
      fromLatestTracking: false,
    }))

    await expect(
      resolvePlutoBridgePath({
        appPath,
        userDataPath: path.join(temporaryDirectory, 'user-data'),
        platform: 'linux',
        architecture: 'x64',
        readDownloadedInstall,
      }),
    ).resolves.toBe(selectedBridge)
    expect(readDownloadedInstall).toHaveBeenCalledTimes(1)
  })

  it('replaces official payloads while preserving real config, logs, and bandit state', async () => {
    const installPath = destination()
    const existingBridge = Buffer.concat([makePe32X86(), Buffer.from('existing bridge')])
    await fs.mkdir(path.join(installPath, 'pluto'), { recursive: true })
    await fs.mkdir(path.join(installPath, 'bwapi-data'), { recursive: true })
    await fs.writeFile(path.join(installPath, 'pluto.dll'), 'old DLL')
    await fs.writeFile(path.join(installPath, 'pluto', 'pluto_infer.exe'), 'old inference')
    await fs.writeFile(path.join(installPath, 'pluto', 'pluto_weights.bin'), 'old weights')
    await fs.writeFile(path.join(installPath, 'pluto-bridge.exe'), existingBridge)
    const supportFiles = {
      'pluto/pluto_config.json': 'keep config',
      'pluto.log': 'keep Pluto log',
      'pluto_infer.log': 'keep inference log',
      'pluto_infer_stdout.log': 'keep inference stdout',
      'pluto_infer_stderr.log': 'keep inference stderr',
      'bridge.log': 'keep bridge log',
      'pluto_bot.log': 'keep bot log',
      'pluto_bandit_1.txt': 'keep root bandit snapshot',
      'bwapi-data/bandit.json': 'keep bandit state',
    }
    for (const [name, contents] of Object.entries(supportFiles)) {
      await fs.writeFile(path.join(installPath, ...name.split('/')), contents)
    }
    await fs.writeFile(path.join(installPath, 'stale-file'), 'remove stale file')

    await installFixtureArchive(installPath)

    expect(await isPlutoRuntimeInstalled(installPath, TEST_HASHES)).toBe(true)
    expect(await fs.readFile(path.join(installPath, 'pluto.dll'), 'utf8')).toBe(
      PAYLOAD_CONTENTS['pluto.dll'],
    )
    expect(await fs.readFile(path.join(installPath, 'pluto', 'pluto_infer.exe'), 'utf8')).toBe(
      PAYLOAD_CONTENTS['pluto/pluto_infer.exe'],
    )
    expect(await fs.readFile(path.join(installPath, 'pluto', 'pluto_weights.bin'), 'utf8')).toBe(
      PAYLOAD_CONTENTS['pluto/pluto_weights.bin'],
    )
    expect(await fs.readFile(path.join(installPath, 'pluto-bridge.exe'))).toEqual(existingBridge)
    for (const [name, contents] of Object.entries(supportFiles)) {
      expect(await fs.readFile(path.join(installPath, ...name.split('/')), 'utf8')).toBe(contents)
    }
    await expect(fs.lstat(path.join(installPath, 'stale-file'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses to carry a matching log symlink into a repaired runtime', async () => {
    const installPath = destination()
    await fs.mkdir(installPath, { recursive: true })
    const outside = path.join(temporaryDirectory, 'outside.log')
    await fs.writeFile(outside, 'outside')
    await fs.symlink(outside, path.join(installPath, 'pluto_infer_stdout.log'))

    await expect(installFixtureArchive(installPath)).rejects.toThrow(
      'support file cannot be preserved safely',
    )
    expect(
      (await fs.lstat(path.join(installPath, 'pluto_infer_stdout.log'))).isSymbolicLink(),
    ).toBe(true)
    await expect(fs.lstat(path.join(installPath, 'pluto.dll'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('restores the previous complete runtime when the final rename fails', async () => {
    const installPath = destination()
    await fs.mkdir(path.join(installPath, 'pluto'), { recursive: true })
    await fs.mkdir(path.join(installPath, 'bwapi-data'), { recursive: true })
    await fs.writeFile(path.join(installPath, 'pluto.dll'), 'old DLL')
    await fs.writeFile(path.join(installPath, 'pluto', 'pluto_infer.exe'), 'old inference')
    await fs.writeFile(path.join(installPath, 'pluto', 'pluto_weights.bin'), 'old weights')
    await fs.writeFile(path.join(installPath, 'pluto-bridge.exe'), makePe32X86())
    await fs.writeFile(path.join(installPath, 'bwapi-data', 'bandit.json'), 'old bandit')

    const originalRename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).includes('.pluto-staging-') && String(newPath) === installPath) {
        throw new Error('injected final rename failure')
      }
      return originalRename(oldPath, newPath)
    })

    await expect(installFixtureArchive(installPath)).rejects.toThrow(
      'injected final rename failure',
    )
    expect(await fs.readFile(path.join(installPath, 'pluto.dll'), 'utf8')).toBe('old DLL')
    expect(await fs.readFile(path.join(installPath, 'pluto', 'pluto_infer.exe'), 'utf8')).toBe(
      'old inference',
    )
    expect(await fs.readFile(path.join(installPath, 'pluto', 'pluto_weights.bin'), 'utf8')).toBe(
      'old weights',
    )
    expect(await fs.readFile(path.join(installPath, 'bwapi-data', 'bandit.json'), 'utf8')).toBe(
      'old bandit',
    )
    const siblings = await fs.readdir(path.dirname(installPath))
    expect(siblings.some(name => name.startsWith('.pluto-staging-'))).toBe(false)
    expect(siblings.some(name => name.startsWith('.pluto-backup-'))).toBe(false)
  })

  it('rejects traversal and unexpected files without writing outside staging', async () => {
    const installPath = destination()
    const archivePath = await writeArchive([
      ...payloadEntries().filter(entry => entry.name !== 'README.txt'),
      { name: '../outside.dat', contents: 'outside' },
    ])

    await expect(
      installPlutoArchive({
        archivePath,
        destination: installPath,
        activeBridgePath,
        expectedHashes: TEST_HASHES,
      }),
    ).rejects.toThrow('unexpected or unsafe file')
    await expect(
      fs.lstat(path.join(path.dirname(installPath), 'outside.dat')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(installPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects links and unrelated archive contents', async () => {
    const archivePath = await writeArchive([
      ...payloadEntries().filter(entry => entry.name !== 'README.txt'),
      { name: 'pluto/link', kind: 'symlink', contents: 'pluto_weights.bin' },
    ])

    await expect(
      installPlutoArchive({
        archivePath,
        destination: destination(),
        activeBridgePath,
        expectedHashes: TEST_HASHES,
      }),
    ).rejects.toThrow('links are forbidden')
  })

  it('leaves an existing installation untouched when an inner hash does not match', async () => {
    const installPath = destination()
    await fs.mkdir(installPath, { recursive: true })
    await fs.writeFile(path.join(installPath, 'known-good-marker'), 'keep me')
    const badHashes = {
      ...TEST_HASHES,
      'pluto/pluto_weights.bin': '0'.repeat(64),
    }

    await expect(installFixtureArchive(installPath, badHashes)).rejects.toThrow(
      'SHA-256 verification failed for Pluto payload pluto/pluto_weights.bin',
    )

    expect(await fs.readFile(path.join(installPath, 'known-good-marker'), 'utf8')).toBe('keep me')
    expect((await fs.readdir(installPath)).sort()).toEqual(['known-good-marker'])
  })

  it('installs MetalSharp Wine before Pluto in one action and preserves Pluto support state', async () => {
    const installPath = destination()
    await fs.mkdir(path.join(installPath, 'pluto'), { recursive: true })
    await fs.mkdir(path.join(installPath, 'bwapi-data'), { recursive: true })
    await fs.writeFile(path.join(installPath, 'pluto.dll'), 'old DLL')
    await fs.writeFile(path.join(installPath, 'pluto', 'pluto_config.json'), 'keep config')
    await fs.writeFile(path.join(installPath, 'pluto_infer.log'), 'keep log')
    await fs.writeFile(path.join(installPath, 'bwapi-data', 'bandit.json'), 'keep bandit')
    const wineApp = metalSharpWineAppPath(temporaryDirectory)
    const wineArchive = path.join(temporaryDirectory, 'wine-archive.zip')
    await fs.writeFile(wineArchive, 'mocked verified Wine archive')
    const plutoArchive = await writeArchive()
    const progress = vi.fn()
    const onDownloaded = vi.fn()
    const downloadAssets = vi.fn<typeof downloadReleaseAssets>(async (...args) => {
      const [release, , , , onProgress, limits] = args
      expect(release.assets).toEqual([METALSHARP_WINE_ARCHIVE_ASSET, PLUTO_ARCHIVE_ASSET])
      expect(limits).toEqual({ maxAssetBytes: METALSHARP_WINE_DOWNLOAD_BYTES })
      onProgress({
        bytesTransferred: PLUTO_MACOS_DOWNLOAD_BYTES,
        totalBytes: PLUTO_MACOS_DOWNLOAD_BYTES,
      })
      return [
        { asset: METALSHARP_WINE_ARCHIVE_ASSET, path: wineArchive },
        { asset: PLUTO_ARCHIVE_ASSET, path: plutoArchive },
      ]
    })
    const installWineArchive = vi.fn(async (options: InstallMetalSharpWineArchiveOptions) => {
      expect(options).toEqual({ archivePath: wineArchive, destination: wineApp })
      expect(await fs.readFile(path.join(installPath, 'pluto.dll'), 'utf8')).toBe('old DLL')
      await fs.mkdir(wineApp, { recursive: true })
      await fs.writeFile(path.join(wineApp, 'installed'), 'signed app')
    })

    await installPlutoRuntime({
      dataPath: path.dirname(installPath),
      installPath,
      activeBridgePath,
      clientVersion: '12.3.14',
      installMetalSharpWine: { destination: wineApp },
      onProgress: progress,
      onDownloaded,
      downloadAssets,
      installWineArchive,
      expectedHashes: TEST_HASHES,
    })

    expect(downloadAssets).toHaveBeenCalledOnce()
    expect(onDownloaded).toHaveBeenCalledOnce()
    expect(installWineArchive).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledWith({
      bytesTransferred: PLUTO_MACOS_DOWNLOAD_BYTES,
      totalBytes: PLUTO_MACOS_DOWNLOAD_BYTES,
    })
    expect(await isPlutoRuntimeInstalled(installPath, TEST_HASHES)).toBe(true)
    expect(await fs.readFile(path.join(installPath, 'pluto.dll'), 'utf8')).toBe(
      PAYLOAD_CONTENTS['pluto.dll'],
    )
    expect(await fs.readFile(path.join(installPath, 'pluto', 'pluto_config.json'), 'utf8')).toBe(
      'keep config',
    )
    expect(await fs.readFile(path.join(installPath, 'pluto_infer.log'), 'utf8')).toBe('keep log')
    expect(await fs.readFile(path.join(installPath, 'bwapi-data', 'bandit.json'), 'utf8')).toBe(
      'keep bandit',
    )
    expect(await fs.readFile(path.join(wineApp, 'installed'), 'utf8')).toBe('signed app')
  })
})
