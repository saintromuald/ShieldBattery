import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultReleasePreferences,
  releaseCenterInstallRoot,
  writeInstalledRegistry,
  writeReleasePreferences,
} from '../../releases/storage'
import {
  embeddedHyperionPaths,
  probeHyperionIdentity,
  readEmbeddedHyperionInstall,
} from './install'
import { HyperionCompatibility } from './native-protocol'

vi.mock('../../logger', () => ({ default: { warning: vi.fn() } }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/unused/app',
    getPath: () => '/unused/user-data',
  },
}))
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const COMPATIBILITY: HyperionCompatibility = {
  adapterProtocol: 1,
  engineBuild: 'Hyperion-v0.7.1-beta',
  simRevision: 22,
  rules: 'classic',
  modId: '',
  modFingerprint: 'b'.repeat(40),
  dataFingerprint: 'C3D54EC8',
  rollback: false,
}

let temporaryDirectory: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-hyperion-install-test-'))
  vi.mocked(execFile).mockReset()
})

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

function runtimeLibraryName(platform: 'linux' | 'win32'): string {
  return platform === 'win32' ? 'SDL3.dll' : 'libSDL3.so.0'
}

async function stageExecutable(platform: 'linux' | 'win32' = 'linux') {
  const appPath = path.join(temporaryDirectory, 'resources', 'app.asar')
  const paths = embeddedHyperionPaths(
    appPath,
    path.join(temporaryDirectory, 'user-data'),
    'seat 1',
    platform,
    'x64',
  )
  await fs.mkdir(path.join(paths.workingDirectory, 'Data'), { recursive: true })
  await fs.writeFile(paths.executablePath, 'native test fixture', {
    mode: platform === 'win32' ? 0o644 : 0o755,
  })
  await fs.writeFile(path.join(paths.workingDirectory, runtimeLibraryName(platform)), 'native SDL')
  return { appPath, paths }
}

async function stageDownloadedExecutable(
  userDataPath: string,
  selection: 'latest' | 'pinned',
  platform: 'linux' | 'win32' = 'linux',
) {
  const releaseId = 'github:saintromuald/hyperion-public:1'
  const downloadedDirectory = path.join(
    releaseCenterInstallRoot(userDataPath, 'hyperion'),
    'downloaded-1.0.0',
  )
  const executableName = platform === 'win32' ? 'Hyperion.exe' : 'Hyperion.x86_64'
  await fs.mkdir(path.join(downloadedDirectory, 'Data'), { recursive: true })
  await fs.writeFile(path.join(downloadedDirectory, executableName), 'downloaded engine', {
    mode: platform === 'win32' ? 0o644 : 0o755,
  })
  await fs.writeFile(path.join(downloadedDirectory, runtimeLibraryName(platform)), 'downloaded SDL')
  const preferences = defaultReleasePreferences()
  preferences.hyperion.selection = selection
  preferences.hyperion.activeReleaseId = releaseId
  if (selection === 'pinned') {
    preferences.hyperion.pinnedReleaseId = releaseId
  }
  await writeReleasePreferences(userDataPath, preferences)
  await writeInstalledRegistry(userDataPath, {
    hyperion: [
      {
        releaseId,
        version: '1.0.0',
        tag: 'v1.0.0',
        channel: 'stable',
        installedAt: '2026-01-01T00:00:00Z',
        packageKind: 'archive',
        directoryName: 'downloaded-1.0.0',
        executablePath: executableName,
        platform,
        architecture: 'x64',
      },
    ],
    hypershield: [],
  })
  return {
    releaseId,
    downloadedDirectory,
    executablePath: path.join(downloadedDirectory, executableName),
  }
}

describe('embeddedHyperionPaths', () => {
  it('resolves development and packaged resources beside the app tree', () => {
    expect(embeddedHyperionPaths('/work/ShieldBattery/app', '/work/user-data')).toEqual({
      executablePath: '/work/ShieldBattery/hyperion/Hyperion.x86_64',
      dataPath: '/work/user-data/hyperion',
      workingDirectory: '/work/ShieldBattery/hyperion',
    })
    expect(
      embeddedHyperionPaths('/opt/ShieldBattery/resources/app.asar', '/home/player/.config/sb')
        .executablePath,
    ).toBe('/opt/ShieldBattery/resources/hyperion/Hyperion.x86_64')
  })

  it('uses Hyperion.exe for Windows x64', () => {
    expect(
      embeddedHyperionPaths('/work/app', '/work/user-data', undefined, 'win32', 'x64'),
    ).toEqual({
      executablePath: '/work/hyperion/Hyperion.exe',
      dataPath: '/work/user-data/hyperion',
      workingDirectory: '/work/hyperion',
    })
  })

  it('namespaces native data for concurrent development sessions', () => {
    expect(
      embeddedHyperionPaths('/work/app', '/work/user-data', 'seat/one', 'linux', 'x64').dataPath,
    ).toBe('/work/user-data/hyperion-seat_one')
  })

  it('rejects unsupported platforms and processor architectures', () => {
    expect(() =>
      embeddedHyperionPaths('/work/app', '/work/user-data', undefined, 'darwin'),
    ).toThrow('not available on this operating system')
    expect(() =>
      embeddedHyperionPaths('/work/app', '/work/user-data', undefined, 'win32', 'arm64'),
    ).toThrow('not available on this processor architecture')
  })
})

describe('readEmbeddedHyperionInstall', () => {
  it('loads compatibility from the exact shipped executable and creates private native data', async () => {
    const { appPath, paths } = await stageExecutable()
    const probe = vi.fn(async () => COMPATIBILITY)

    const install = await readEmbeddedHyperionInstall({
      appPath,
      userDataPath: path.join(temporaryDirectory, 'user-data'),
      sessionName: 'seat 1',
      platform: 'linux',
      architecture: 'x64',
      gameDataPath: '/games/StarCraft',
      probe,
    })

    expect(install).toEqual({
      ...paths,
      gameDataPath: '/games/StarCraft',
      compatibility: COMPATIBILITY,
    })
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      paths.executablePath,
      paths.dataPath,
      paths.workingDirectory,
      '/games/StarCraft',
    )
    expect((await fs.stat(paths.dataPath)).isDirectory()).toBe(true)
    expect(install.dataPath).not.toBe(paths.workingDirectory)
  })

  it('probes a Windows x64 install without requiring POSIX execute permission', async () => {
    const { appPath, paths } = await stageExecutable('win32')
    const probe = vi.fn(async () => COMPATIBILITY)

    const install = await readEmbeddedHyperionInstall({
      appPath,
      userDataPath: path.join(temporaryDirectory, 'user-data'),
      sessionName: 'seat 1',
      platform: 'win32',
      architecture: 'x64',
      gameDataPath: 'C:\\Games\\StarCraft',
      probe,
    })

    expect(install).toEqual({
      ...paths,
      gameDataPath: 'C:\\Games\\StarCraft',
      compatibility: COMPATIBILITY,
    })
    expect(paths.executablePath).toMatch(/Hyperion\.exe$/)
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      paths.executablePath,
      paths.dataPath,
      paths.workingDirectory,
      'C:\\Games\\StarCraft',
    )
  })

  it('uses the selected downloaded release while retaining bundled native data settings', async () => {
    const { appPath, paths } = await stageExecutable()
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const { downloadedDirectory } = await stageDownloadedExecutable(userDataPath, 'pinned')
    const probe = vi.fn(async () => COMPATIBILITY)

    const install = await readEmbeddedHyperionInstall({
      appPath,
      userDataPath,
      sessionName: 'seat 1',
      platform: 'linux',
      architecture: 'x64',
      probe,
    })

    expect(install).toEqual({
      executablePath: path.join(downloadedDirectory, 'Hyperion.x86_64'),
      workingDirectory: downloadedDirectory,
      dataPath: paths.dataPath,
      compatibility: COMPATIBILITY,
    })
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      path.join(downloadedDirectory, 'Hyperion.x86_64'),
      paths.dataPath,
      downloadedDirectory,
      undefined,
    )
  })

  it('selects a complete Windows download and probes its DLL and Data dependencies', async () => {
    const { appPath, paths } = await stageExecutable('win32')
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const downloaded = await stageDownloadedExecutable(userDataPath, 'pinned', 'win32')
    const readDownloadedInstall = vi.fn(async () => ({
      executablePath: downloaded.executablePath,
      workingDirectory: downloaded.downloadedDirectory,
      fromLatestTracking: false,
    }))
    const probe = vi.fn(async () => COMPATIBILITY)

    const install = await readEmbeddedHyperionInstall({
      appPath,
      userDataPath,
      sessionName: 'seat 1',
      platform: 'win32',
      architecture: 'x64',
      probe,
      readDownloadedInstall,
    })

    expect(readDownloadedInstall).toHaveBeenCalledExactlyOnceWith(userDataPath, 'win32', 'x64')
    expect(install).toEqual({
      executablePath: downloaded.executablePath,
      workingDirectory: downloaded.downloadedDirectory,
      dataPath: paths.dataPath,
      compatibility: COMPATIBILITY,
    })
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      downloaded.executablePath,
      paths.dataPath,
      downloaded.downloadedDirectory,
      undefined,
    )
  })

  it('retries the bundled engine when a latest-tracked download fails its probe', async () => {
    const { appPath, paths } = await stageExecutable()
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const downloaded = await stageDownloadedExecutable(userDataPath, 'latest')
    const probe = vi.fn(async (executablePath: string) => {
      if (executablePath === downloaded.executablePath) {
        throw new Error('downloaded engine is incompatible')
      }
      return COMPATIBILITY
    })

    const install = await readEmbeddedHyperionInstall({
      appPath,
      userDataPath,
      sessionName: 'seat 1',
      platform: 'linux',
      architecture: 'x64',
      probe,
    })

    expect(install).toEqual({ ...paths, compatibility: COMPATIBILITY })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe.mock.calls.map(call => call[0])).toEqual([
      downloaded.executablePath,
      paths.executablePath,
    ])
  })

  it('surfaces a pinned downloaded probe failure without trying the bundled engine', async () => {
    const { appPath } = await stageExecutable()
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const downloaded = await stageDownloadedExecutable(userDataPath, 'pinned')
    const probe = vi.fn(async (_executablePath: string) => {
      throw new Error('pinned engine is incompatible')
    })

    await expect(
      readEmbeddedHyperionInstall({
        appPath,
        userDataPath,
        sessionName: 'seat 1',
        platform: 'linux',
        architecture: 'x64',
        probe,
      }),
    ).rejects.toThrow('pinned engine is incompatible')
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0][0]).toBe(downloaded.executablePath)
  })

  it('surfaces a bundled probe failure after a latest-tracked download also fails', async () => {
    const { appPath } = await stageExecutable()
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    await stageDownloadedExecutable(userDataPath, 'latest')
    const probe = vi
      .fn(async () => COMPATIBILITY)
      .mockRejectedValueOnce(new Error('downloaded engine is incompatible'))
      .mockRejectedValueOnce(new Error('bundled engine is incompatible'))

    await expect(
      readEmbeddedHyperionInstall({
        appPath,
        userDataPath,
        sessionName: 'seat 1',
        platform: 'linux',
        architecture: 'x64',
        probe,
      }),
    ).rejects.toThrow('bundled engine is incompatible')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it.each(['linux', 'win32'] as const)(
    'fails cleanly when the $platform executable is missing',
    async platform => {
      const probe = vi.fn()
      await expect(
        readEmbeddedHyperionInstall({
          appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
          userDataPath: path.join(temporaryDirectory, 'user-data'),
          platform,
          architecture: 'x64',
          probe,
        }),
      ).rejects.toThrow('Reinstall HyperShield and try again')
      expect(probe).not.toHaveBeenCalled()
    },
  )

  it.each([
    { platform: 'linux', dependency: 'library' },
    { platform: 'linux', dependency: 'data' },
    { platform: 'win32', dependency: 'library' },
    { platform: 'win32', dependency: 'data' },
  ] as const)(
    'rejects a bundled $platform install with its $dependency dependency missing',
    async ({ platform, dependency }) => {
      const { appPath, paths } = await stageExecutable(platform)
      if (dependency === 'library') {
        await fs.rm(path.join(paths.workingDirectory, runtimeLibraryName(platform)))
        await fs.writeFile(
          path.join(
            paths.workingDirectory,
            runtimeLibraryName(platform === 'win32' ? 'linux' : 'win32'),
          ),
          'wrong platform SDL',
        )
      } else {
        await fs.rm(path.join(paths.workingDirectory, 'Data'), { recursive: true })
      }
      const probe = vi.fn()

      await expect(
        readEmbeddedHyperionInstall({
          appPath,
          userDataPath: path.join(temporaryDirectory, 'user-data'),
          sessionName: 'seat 1',
          platform,
          architecture: 'x64',
          probe,
        }),
      ).rejects.toThrow('Reinstall HyperShield and try again')
      expect(probe).not.toHaveBeenCalled()
    },
  )

  it.each(['SDL3.dll', 'Data'] as const)(
    'rejects a pinned Windows download with %s missing instead of probing it',
    async dependency => {
      const { appPath } = await stageExecutable('win32')
      const userDataPath = path.join(temporaryDirectory, 'user-data')
      const downloaded = await stageDownloadedExecutable(userDataPath, 'pinned', 'win32')
      await fs.rm(path.join(downloaded.downloadedDirectory, dependency), { recursive: true })
      const probe = vi.fn()

      await expect(
        readEmbeddedHyperionInstall({
          appPath,
          userDataPath,
          sessionName: 'seat 1',
          platform: 'win32',
          architecture: 'x64',
          probe,
          readDownloadedInstall: async () => ({
            executablePath: downloaded.executablePath,
            workingDirectory: downloaded.downloadedDirectory,
            fromLatestTracking: false,
          }),
        }),
      ).rejects.toThrow('Reinstall HyperShield and try again')
      expect(probe).not.toHaveBeenCalled()
    },
  )

  it('rejects malformed compatibility before a game can launch', async () => {
    const { appPath } = await stageExecutable()
    await expect(
      readEmbeddedHyperionInstall({
        appPath,
        userDataPath: path.join(temporaryDirectory, 'user-data'),
        platform: 'linux',
        architecture: 'x64',
        probe: async () => ({ ...COMPATIBILITY, simRevision: 21 }),
      }),
    ).rejects.toThrow('simRevision must be 22')
  })
})

describe('probeHyperionIdentity', () => {
  it('uses the hidden identity mode without forwarding result credentials', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const callback = args.at(-1)
      callback(null, `${JSON.stringify(COMPATIBILITY)}\n`, '')
      return {} as any
    })
    process.env.HYPERION_SB_EVENTS = '1'
    process.env.HYPERION_SB_RESULT_CODE = 'secret-that-must-not-reach-the-probe'

    try {
      await expect(
        probeHyperionIdentity(
          '/opt/hyperion/Hyperion.x86_64',
          '/work/native-data',
          '/opt/hyperion',
          '/games/StarCraft',
        ),
      ).resolves.toEqual(COMPATIBILITY)
    } finally {
      delete process.env.HYPERION_SB_EVENTS
      delete process.env.HYPERION_SB_RESULT_CODE
    }

    expect(execFile).toHaveBeenCalledOnce()
    const [executable, args, options] = vi.mocked(execFile).mock.calls[0] as any[]
    expect(executable).toBe('/opt/hyperion/Hyperion.x86_64')
    expect(args).toEqual([
      '--sb-identity',
      '--data',
      '/work/native-data',
      '--install-folder',
      '/games/StarCraft',
    ])
    expect(options.cwd).toBe('/opt/hyperion')
    expect(options.env.HYPERION_WINDOW).toBe('hidden')
    expect(options.env).not.toHaveProperty('HYPERION_SB_EVENTS')
    expect(options.env).not.toHaveProperty('HYPERION_SB_RESULT_CODE')
    expect(options.windowsHide).toBe(true)
    expect(options.timeout).toBe(20_000)
  })

  it('passes Windows paths as an argument array with the console hidden', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      args.at(-1)(null, JSON.stringify(COMPATIBILITY), '')
      return {} as any
    })

    await expect(
      probeHyperionIdentity(
        'C:\\Hyperion\\Hyperion.exe',
        'C:\\Users\\Player\\AppData\\Roaming\\HyperShield\\hyperion',
        'C:\\Hyperion',
        'C:\\Games\\StarCraft',
      ),
    ).resolves.toEqual(COMPATIBILITY)

    const [executable, args, options] = vi.mocked(execFile).mock.calls[0] as any[]
    expect(executable).toBe('C:\\Hyperion\\Hyperion.exe')
    expect(args).toEqual([
      '--sb-identity',
      '--data',
      'C:\\Users\\Player\\AppData\\Roaming\\HyperShield\\hyperion',
      '--install-folder',
      'C:\\Games\\StarCraft',
    ])
    expect(options.cwd).toBe('C:\\Hyperion')
    expect(options.windowsHide).toBe(true)
  })

  it('turns a failed probe into an actionable error', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      args.at(-1)(new Error('game data unavailable'), '', '')
      return {} as any
    })
    await expect(probeHyperionIdentity('/hyperion', '/data', '/opt')).rejects.toThrow(
      'Install or repair StarCraft, then try again',
    )
  })

  it('rejects non-JSON output', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      args.at(-1)(null, 'not a compatibility record', '')
      return {} as any
    })
    await expect(probeHyperionIdentity('/hyperion', '/data', '/opt')).rejects.toThrow(
      'invalid compatibility response',
    )
  })
})
