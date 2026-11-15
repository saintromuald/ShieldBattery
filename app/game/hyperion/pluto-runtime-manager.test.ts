import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUTO_RUNTIME_DOWNLOAD_BYTES } from '../../../common/pluto-runtime'
import { makePe32X86 } from '../../releases/testing/fixtures'
import type { InstallPlutoRuntimeOptions } from './pluto-runtime-installer'
import { PlutoRuntimeManager } from './pluto-runtime-manager'

vi.mock('../../logger', () => ({ default: { warning: vi.fn() } }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/unused/app',
    getPath: () => '/unused/user-data',
  },
}))

let temporaryDirectory: string

function appPath(): string {
  return path.join(temporaryDirectory, 'ephemeral-app-image', 'resources', 'app')
}

function bundledBridgePath(): string {
  return path.join(path.resolve(appPath(), '..', 'hyperion'), 'Data', 'pluto', 'pluto-bridge.exe')
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-pluto-manager-test-'))
  await fs.mkdir(path.dirname(bundledBridgePath()), { recursive: true })
  await fs.writeFile(bundledBridgePath(), makePe32X86())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

function managerOptions(installRuntime: (options: InstallPlutoRuntimeOptions) => Promise<void>) {
  return {
    appPath: appPath(),
    userDataPath: path.join(temporaryDirectory, 'user-data'),
    clientVersion: '12.3.13',
    sessionName: 'test session',
    installRuntime,
  }
}

describe('PlutoRuntimeManager', () => {
  it.each(['linux', 'win32'] as const)(
    'uses the per-user --data path on %s x64 and downloads only on install',
    async platform => {
      const installRuntime = vi.fn(async (options: InstallPlutoRuntimeOptions) => {
        options.onProgress?.({
          bytesTransferred: 123,
          totalBytes: PLUTO_RUNTIME_DOWNLOAD_BYTES,
          bytesPerSecond: 456,
        })
        options.onDownloaded?.()
      })
      const onChange = vi.fn()
      const manager = new PlutoRuntimeManager({
        ...managerOptions(installRuntime),
        platform,
        architecture: 'x64',
        onChange,
      })

      const initial = await manager.initialize()
      const dataPath = path.join(temporaryDirectory, 'user-data', 'hyperion-test_session')
      expect(initial).toMatchObject({
        supported: true,
        installed: false,
        operation: 'idle',
        installPath: path.join(dataPath, 'pluto'),
      })
      expect(installRuntime).not.toHaveBeenCalled()

      const installed = await manager.install()
      expect(installRuntime).toHaveBeenCalledTimes(1)
      expect(installRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          dataPath,
          installPath: path.join(dataPath, 'pluto'),
          activeBridgePath: bundledBridgePath(),
        }),
      )
      expect(installed).toMatchObject({ installed: true, operation: 'idle' })
      const operations = onChange.mock.calls.map(([state]) => state.operation)
      expect(operations).toContain('downloading')
      expect(operations).toContain('installing')
      expect(
        onChange.mock.calls.some(
          ([state]) =>
            state.progress?.bytesTransferred === 123 &&
            state.progress.totalBytes === PLUTO_RUNTIME_DOWNLOAD_BYTES,
        ),
      ).toBe(true)
    },
  )

  it('honors SB_SESSION when deriving the runtime path', async () => {
    vi.stubEnv('SB_SESSION', 'second-client')
    const installRuntime = vi.fn(async () => {})
    const options = managerOptions(installRuntime)
    const manager = new PlutoRuntimeManager({
      ...options,
      sessionName: undefined,
      platform: 'linux',
      architecture: 'x64',
    })

    const state = await manager.initialize()
    expect(state.installPath).toBe(
      path.join(options.userDataPath, 'hyperion-second-client', 'pluto'),
    )
  })

  it('serializes concurrent install and repair requests', async () => {
    let finishFirst: (() => void) | undefined
    const installRuntime = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishFirst = resolve
          }),
      )
      .mockResolvedValue(undefined)
    const manager = new PlutoRuntimeManager({
      ...managerOptions(installRuntime),
      platform: 'linux',
      architecture: 'x64',
    })
    await manager.initialize()

    const first = manager.install()
    await vi.waitFor(() => expect(installRuntime).toHaveBeenCalledTimes(1))
    const second = manager.install()
    await Promise.resolve()
    await Promise.resolve()
    expect(installRuntime).toHaveBeenCalledTimes(1)

    finishFirst!()
    await first
    await second
    expect(installRuntime).toHaveBeenCalledTimes(2)
  })

  it('fails before invoking the installer when Hyperion’s bridge is missing', async () => {
    await fs.rm(bundledBridgePath())
    const installRuntime = vi.fn(async () => {})
    const manager = new PlutoRuntimeManager({
      ...managerOptions(installRuntime),
      platform: 'linux',
      architecture: 'x64',
    })
    await manager.initialize()

    const state = await manager.install()
    expect(state.operation).toBe('error')
    expect(state.statusMessage).toContain('Pluto AI bridge is missing')
    expect(installRuntime).not.toHaveBeenCalled()
  })

  it('returns an error state after an installation failure', async () => {
    const installRuntime = vi.fn(async () => {
      throw new Error('verification failed')
    })
    const manager = new PlutoRuntimeManager({
      ...managerOptions(installRuntime),
      platform: 'linux',
      architecture: 'x64',
    })
    await manager.initialize()

    const state = await manager.install()
    expect(state).toMatchObject({
      installed: false,
      operation: 'error',
      statusMessage: 'verification failed',
    })
  })

  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'arm64'],
  ] as const)('explains and refuses unsupported %s %s installs', async (platform, architecture) => {
    const installRuntime = vi.fn(async () => {})
    const manager = new PlutoRuntimeManager({
      ...managerOptions(installRuntime),
      platform,
      architecture,
    })

    const initial = await manager.initialize()
    expect(initial.supported).toBe(false)
    expect(initial.installPath).toBeUndefined()
    expect(initial.unsupportedReason).toContain('Linux x64 and Windows x64 only')
    const result = await manager.install()
    expect(result.operation).toBe('error')
    expect(installRuntime).not.toHaveBeenCalled()
  })
})
