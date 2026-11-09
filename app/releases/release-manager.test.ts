/* eslint-disable eslint-core/camelcase */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseCenterState, ReleaseProduct } from '../../common/release-center'
import type { GitHubRelease } from './catalog'
import { ReleaseManager } from './release-manager'
import {
  installedReleaseExecutable,
  readInstalledRegistry,
  readReleasePreferences,
  readSelectedHyperionInstall,
  releaseCenterInstallRoot,
} from './storage'
import { makeHyperionZip } from './testing/fixtures'

vi.mock('electron', () => ({
  app: {
    relaunch: vi.fn(),
    quit: vi.fn(),
  },
}))

const execFileAsync = promisify(execFile)

let temporaryDirectory: string
let appPath: string
let userDataPath: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-release-manager-test-'))
  appPath = path.join(temporaryDirectory, 'resources', 'app.asar')
  userDataPath = path.join(temporaryDirectory, 'user-data')
  const bundledHyperion = path.resolve(appPath, '..', 'hyperion')
  await fs.mkdir(path.join(bundledHyperion, 'Data'), { recursive: true })
  await fs.writeFile(path.join(bundledHyperion, 'Data', 'public.dat'), 'bundled public data')
  await fs.writeFile(
    path.join(bundledHyperion, 'release.json'),
    JSON.stringify({ version: 'v0.7.1-beta', gameFilesBundled: false }),
  )
  vi.mocked(app.relaunch).mockReset()
  vi.mocked(app.quit).mockReset()
})

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function githubAsset(name: string, contents: Uint8Array, publishedDigest = true) {
  return {
    name,
    browser_download_url: `https://github.com/downloads/${name}`,
    size: contents.byteLength,
    digest: publishedDigest ? `sha256:${sha256(contents)}` : null,
  }
}

function githubRelease(
  product: ReleaseProduct,
  id: number,
  version: string,
  assets: ReturnType<typeof githubAsset>[],
  prerelease = false,
): GitHubRelease {
  return {
    id,
    tag_name: `v${version}`,
    name: `${product === 'hyperion' ? 'Hyperion' : 'HyperShield'} ${version}`,
    body: '',
    draft: false,
    prerelease,
    published_at: `2026-02-${String(id).padStart(2, '0')}T00:00:00Z`,
    html_url: `https://github.com/saintromuald/example/releases/tag/v${version}`,
    assets,
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fetchFor(releases: GitHubRelease[], bodies: Record<string, Uint8Array>) {
  return vi.fn<typeof globalThis.fetch>(async input => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    if (url.startsWith('https://api.github.com/')) {
      return jsonResponse(releases)
    }
    const name = Object.keys(bodies).find(candidate => url.endsWith(`/${candidate}`))
    if (name) {
      return new Response(Uint8Array.from(bodies[name]).buffer, { status: 200 })
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' })
  })
}

function makeManager(
  fetchImpl: typeof globalThis.fetch,
  onChange?: (state: ReleaseCenterState) => void,
) {
  return new ReleaseManager({
    appPath,
    userDataPath,
    clientVersion: '12.3.6',
    platform: 'linux',
    architecture: 'x64',
    fetch: fetchImpl,
    onChange,
  })
}

const executable = new TextEncoder().encode('downloaded native executable')
const library = new TextEncoder().encode('downloaded SDL library')
const appImage = new TextEncoder().encode('downloaded AppImage')

function rawRelease(id: number, version: string, prerelease = false) {
  return githubRelease(
    'hyperion',
    id,
    version,
    [githubAsset('Hyperion.x86_64', executable), githubAsset('libSDL3.so.0', library)],
    prerelease,
  )
}

async function archiveRelease(id: number, version: string, prerelease = false) {
  const input = path.join(temporaryDirectory, `archive-input-${id}`)
  await fs.mkdir(path.join(input, 'package', 'Data'), { recursive: true })
  await fs.writeFile(path.join(input, 'package', 'Hyperion.x86_64'), executable)
  await fs.writeFile(path.join(input, 'package', 'libSDL3.so.0'), library)
  await fs.writeFile(path.join(input, 'package', 'Data', 'public.dat'), 'archived public data')
  const archivePath = path.join(temporaryDirectory, `archive-${id}.tar.gz`)
  await execFileAsync('tar', ['-czf', archivePath, '-C', input, '.'])
  const contents = await fs.readFile(archivePath)
  const name = `Hyperion-Shield-${version}-linux-x64.tar.gz`
  return {
    release: githubRelease('hyperion', id, version, [githubAsset(name, contents)], prerelease),
    name,
    contents,
  }
}

describe('ReleaseManager local state and catalogs', () => {
  it('initializes defaults and bundled versions without performing network requests', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>()
    const manager = makeManager(fetchImpl)
    const state = await manager.initialize()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.products.hyperion).toMatchObject({
      currentVersion: '0.7.1-beta',
      channel: 'stable',
      automaticUpdates: false,
      selection: 'pinned',
      usingBundledVersion: true,
      supportsInstallation: true,
      operation: 'idle',
    })
    expect(state.products.hypershield.currentVersion).toBe('12.3.6')
  })

  it('loads a cached catalog offline and retains it with a clear refresh error', async () => {
    const online = makeManager(fetchFor([rawRelease(1, '1.0.0')], {}))
    await online.refresh('hyperion')

    const offlineFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('network offline'))
    const offline = makeManager(offlineFetch)
    const initialized = await offline.initialize()
    expect(initialized.products.hyperion.releases).toHaveLength(1)
    expect(offlineFetch).not.toHaveBeenCalled()

    const refreshed = await offline.refresh('hyperion')
    expect(refreshed.products.hyperion.releases).toHaveLength(1)
    expect(refreshed.products.hyperion.operation).toBe('error')
    expect(refreshed.products.hyperion.statusMessage).toContain('Showing the saved release catalog')
    expect(refreshed.products.hyperion.statusMessage).toContain('network offline')
  })

  it('returns a failed queued refresh to an error state and permits a retry', async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('network offline'))
      .mockResolvedValueOnce(jsonResponse([rawRelease(1, '1.0.0')]))
    const manager = makeManager(fetchImpl)

    expect((await manager.refresh('hyperion')).products.hyperion.operation).toBe('error')
    const retried = await manager.refresh('hyperion')
    expect(retried.products.hyperion.operation).toBe('idle')
    expect(retried.products.hyperion.releases).toHaveLength(1)
  })

  it('supports Windows Hyperion ZIPs but not Windows AppImage staging or raw engine files', async () => {
    const zipName = 'Hyperion-Shield-1.0.0-windows-x64.zip'
    const manager = new ReleaseManager({
      appPath,
      userDataPath,
      clientVersion: '12.3.6',
      platform: 'win32',
      architecture: 'x64',
      fetch: fetchFor(
        [
          rawRelease(1, '1.0.0'),
          githubRelease('hyperion', 2, '2.0.0', [githubAsset(zipName, makeHyperionZip())]),
        ],
        {},
      ),
    })
    const state = await manager.refresh('hyperion')
    expect(state.products.hyperion.supportsInstallation).toBe(true)
    expect(
      state.products.hyperion.releases.find(release => release.version === '1.0.0')?.packageKind,
    ).toBe('none')
    expect(
      state.products.hyperion.releases.find(release => release.version === '2.0.0')?.packageKind,
    ).toBe('archive')

    const hyperShield = await manager.refresh('hypershield')
    expect(hyperShield.products.hypershield.supportsInstallation).toBe(false)
    expect(hyperShield.products.hypershield.releases[0].unavailableReason).toContain('NSIS')
  })
})

describe('ReleaseManager installation and selection', () => {
  it('verifies and stages raw Hyperion files with bundled Data and executable permissions', async () => {
    const changes: ReleaseCenterState[] = []
    const manager = makeManager(
      fetchFor([rawRelease(1, '1.0.0')], {
        'Hyperion.x86_64': executable,
        'libSDL3.so.0': library,
      }),
      state => changes.push(state),
    )
    await manager.refresh('hyperion')
    const state = await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')

    expect(state.products.hyperion).toMatchObject({
      selection: 'pinned',
      currentReleaseId: 'github:saintromuald/hyperion-public:1',
      currentVersion: '1.0.0',
      operation: 'idle',
    })
    expect(state.products.hyperion.installedReleases).toHaveLength(1)
    const registry = await readInstalledRegistry(userDataPath)
    const record = registry.hyperion[0]
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    await expect(fs.readFile(executablePath, 'utf8')).resolves.toBe('downloaded native executable')
    await expect(fs.access(executablePath, fsConstants.X_OK)).resolves.toBeUndefined()
    await expect(
      fs.readFile(path.join(path.dirname(executablePath), 'Data', 'public.dat'), 'utf8'),
    ).resolves.toBe('bundled public data')
    expect(changes.some(state => state.products.hyperion.operation === 'downloading')).toBe(true)
    expect(changes.some(state => state.products.hyperion.operation === 'installing')).toBe(true)

    const reloaded = makeManager(vi.fn())
    const persisted = await reloaded.initialize()
    expect(persisted.products.hyperion.selection).toBe('pinned')
    expect(persisted.products.hyperion.currentReleaseId).toBe(record.releaseId)
    expect(persisted.products.hyperion.installedReleases).toHaveLength(1)
  })

  it('updates, persists, and selects a Windows Hyperion installation', async () => {
    const contents = makeHyperionZip()
    const name = 'Hyperion-Shield-2.0.0-windows-x64.zip'
    const release = githubRelease('hyperion', 2, '2.0.0', [githubAsset(name, contents)])
    const options = {
      appPath,
      userDataPath,
      clientVersion: '12.3.6',
      platform: 'win32' as const,
      architecture: 'x64',
      fetch: fetchFor([release], { [name]: contents }),
    }
    const manager = new ReleaseManager(options)

    const state = await manager.updateLatest('hyperion')
    expect(state.products.hyperion).toMatchObject({
      supportsInstallation: true,
      currentReleaseId: 'github:saintromuald/hyperion-public:2',
      currentVersion: '2.0.0',
      selection: 'latest',
      operation: 'idle',
    })
    const record = (await readInstalledRegistry(userDataPath)).hyperion[0]
    expect(record).toMatchObject({ executablePath: 'Hyperion.exe', platform: 'win32' })
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    await expect(readSelectedHyperionInstall(userDataPath, 'win32', 'x64')).resolves.toMatchObject({
      executablePath,
      workingDirectory: path.dirname(executablePath),
      fromLatestTracking: true,
    })

    const reloaded = new ReleaseManager({ ...options, fetch: vi.fn() })
    const persisted = await reloaded.initialize()
    expect(persisted.products.hyperion.currentReleaseId).toBe(record.releaseId)
    expect(persisted.products.hyperion.installedReleases).toHaveLength(1)
    expect(persisted.products.hypershield.supportsInstallation).toBe(false)
  })

  it('prunes damaged inactive installs while keeping valid offline installs activatable', async () => {
    const releases = [rawRelease(1, '1.0.0'), rawRelease(2, '2.0.0')]
    const manager = makeManager(
      fetchFor(releases, { 'Hyperion.x86_64': executable, 'libSDL3.so.0': library }),
    )
    await manager.refresh('hyperion')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:2')
    const registry = await readInstalledRegistry(userDataPath)
    const damaged = registry.hyperion.find(record => record.version === '1.0.0')!
    await fs.rm(installedReleaseExecutable(userDataPath, 'hyperion', damaged))

    const reloaded = makeManager(vi.fn())
    const state = await reloaded.initialize()
    expect(state.products.hyperion.installedReleases.map(record => record.version)).toEqual([
      '2.0.0',
    ])
    expect(
      (await readInstalledRegistry(userDataPath)).hyperion.map(record => record.version),
    ).toEqual(['2.0.0'])

    const activated = await reloaded.activate('hyperion', 'github:saintromuald/hyperion-public:2')
    expect(activated.products.hyperion).toMatchObject({
      currentVersion: '2.0.0',
      operation: 'idle',
    })
  })

  it('prunes a damaged active install and persists the cleared selection', async () => {
    const manager = makeManager(
      fetchFor([rawRelease(1, '1.0.0')], {
        'Hyperion.x86_64': executable,
        'libSDL3.so.0': library,
      }),
    )
    await manager.refresh('hyperion')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')
    const record = (await readInstalledRegistry(userDataPath)).hyperion[0]
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    await fs.rm(path.join(path.dirname(executablePath), 'Data'), { recursive: true })

    const reloaded = makeManager(vi.fn())
    const state = await reloaded.initialize()
    expect(state.products.hyperion).toMatchObject({
      currentVersion: '0.7.1-beta',
      usingBundledVersion: true,
    })
    expect(state.products.hyperion.currentReleaseId).toBeUndefined()
    expect(state.products.hyperion.installedReleases).toEqual([])
    expect((await readInstalledRegistry(userDataPath)).hyperion).toEqual([])
    expect((await readReleasePreferences(userDataPath)).hyperion.activeReleaseId).toBeUndefined()
  })

  it('keeps side-by-side installs and resumes the latest installed release when tracking latest', async () => {
    const releases = [rawRelease(1, '1.0.0'), rawRelease(2, '2.0.0')]
    const manager = makeManager(
      fetchFor(releases, { 'Hyperion.x86_64': executable, 'libSDL3.so.0': library }),
    )
    await manager.refresh('hyperion')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:2')
    const registry = await readInstalledRegistry(userDataPath)
    expect(registry.hyperion).toHaveLength(2)
    const paths = registry.hyperion.map(record =>
      installedReleaseExecutable(userDataPath, 'hyperion', record),
    )
    expect(new Set(paths).size).toBe(2)

    await manager.activate('hyperion', 'github:saintromuald/hyperion-public:1')
    await expect(fs.readFile(paths[1], 'utf8')).resolves.toBe('downloaded native executable')
    const bundled = await manager.useBundledHyperion()
    expect(bundled.products.hyperion).toMatchObject({
      currentVersion: '0.7.1-beta',
      usingBundledVersion: true,
      selection: 'pinned',
    })
    expect(bundled.products.hyperion.installedReleases).toHaveLength(2)

    const latest = await manager.trackLatest('hyperion')
    expect(latest.products.hyperion.selection).toBe('latest')
    expect(latest.products.hyperion.currentReleaseId).toBe('github:saintromuald/hyperion-public:2')
    expect(latest.products.hyperion.updateAvailable).toBe(false)

    await manager.setAutomaticUpdates('hyperion', false)
    await manager.setChannel('hyperion', 'prerelease')
    const preferences = await readReleasePreferences(userDataPath)
    expect(preferences.hyperion).toMatchObject({
      selection: 'latest',
      channel: 'prerelease',
      automaticUpdates: false,
    })
  })

  it('does not switch to an older installed release when the stable channel is selected', async () => {
    const releases = [rawRelease(1, '0.7.0'), rawRelease(2, '0.8.0-beta', true)]
    const manager = makeManager(
      fetchFor(releases, { 'Hyperion.x86_64': executable, 'libSDL3.so.0': library }),
    )
    await manager.refresh('hyperion')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:2')
    await manager.setChannel('hyperion', 'prerelease')
    await manager.trackLatest('hyperion')

    const state = await manager.setChannel('hyperion', 'stable')
    expect(state.products.hyperion).toMatchObject({
      channel: 'stable',
      selection: 'latest',
      currentVersion: '0.8.0-beta',
      currentReleaseId: 'github:saintromuald/hyperion-public:2',
    })
  })

  it('selects the highest semantic version before publication date without pinning it', async () => {
    const releases = [rawRelease(9, '1.0.0'), rawRelease(2, '2.0.0')]
    const manager = makeManager(
      fetchFor(releases, { 'Hyperion.x86_64': executable, 'libSDL3.so.0': library }),
    )

    const state = await manager.updateLatest('hyperion')

    expect(state.products.hyperion).toMatchObject({
      currentReleaseId: 'github:saintromuald/hyperion-public:2',
      currentVersion: '2.0.0',
      selection: 'latest',
      operation: 'idle',
      updateAvailable: false,
    })
    expect(state.products.hyperion.installedReleases).toHaveLength(1)
  })

  it('refuses Update-to-latest downgrades but still permits an explicit older install', async () => {
    const releases = [rawRelease(1, '0.6.0'), rawRelease(2, '0.7.0')]
    const manager = makeManager(
      fetchFor(releases, { 'Hyperion.x86_64': executable, 'libSDL3.so.0': library }),
    )

    const state = await manager.updateLatest('hyperion')
    expect(state.products.hyperion).toMatchObject({
      currentVersion: '0.7.1-beta',
      operation: 'idle',
      updateAvailable: false,
    })
    expect(state.products.hyperion.installedReleases).toEqual([])
    expect(state.products.hyperion.statusMessage).toContain('No downgrade')

    const explicit = await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')
    expect(explicit.products.hyperion).toMatchObject({
      currentVersion: '0.6.0',
      selection: 'pinned',
      operation: 'idle',
    })
  })

  it('fails closed on hash mismatches without registering a partial install', async () => {
    const badRelease = rawRelease(1, '1.0.0')
    ;(badRelease.assets as any[])[0].digest = `sha256:${'0'.repeat(64)}`
    const manager = makeManager(
      fetchFor([badRelease], {
        'Hyperion.x86_64': executable,
        'libSDL3.so.0': library,
      }),
    )
    await manager.refresh('hyperion')
    const state = await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')
    expect(state.products.hyperion.operation).toBe('error')
    expect(state.products.hyperion.statusMessage).toContain('SHA-256 verification failed')
    expect((await readInstalledRegistry(userDataPath)).hyperion).toEqual([])
    await expect(fs.readdir(releaseCenterInstallRoot(userDataPath, 'hyperion'))).resolves.toEqual(
      [],
    )
  })

  it('does not perform automatic work for a pinned selection', async () => {
    const fetchImpl = fetchFor([rawRelease(1, '1.0.0')], {
      'Hyperion.x86_64': executable,
      'libSDL3.so.0': library,
    })
    const manager = makeManager(fetchImpl)
    await manager.refresh('hyperion')
    await manager.install('hyperion', 'github:saintromuald/hyperion-public:1')
    await manager.setAutomaticUpdates('hypershield', false)
    const callsBefore = fetchImpl.mock.calls.length
    const state = await manager.checkForAutomaticUpdates()
    expect(fetchImpl).toHaveBeenCalledTimes(callsBefore)
    expect(state.products.hyperion.selection).toBe('pinned')
  })
})

describe('HyperShield staging and automatic updates', () => {
  it('keeps the bundled engine selected during automatic checks by default', async () => {
    const fetchImpl = fetchFor([rawRelease(1, '1.0.0')], {})
    const manager = makeManager(fetchImpl)
    await manager.setAutomaticUpdates('hypershield', false)

    const state = await manager.checkForAutomaticUpdates()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.products.hyperion).toMatchObject({
      currentVersion: '0.7.1-beta',
      selection: 'pinned',
      automaticUpdates: false,
      usingBundledVersion: true,
    })
    expect(state.products.hyperion.installedReleases).toEqual([])
  })

  it('does not reinstall a bundled engine that already matches the latest release', async () => {
    const fetchImpl = fetchFor([rawRelease(1, '0.7.1-beta')], {})
    const manager = makeManager(fetchImpl)
    await manager.trackLatest('hyperion')
    await manager.setAutomaticUpdates('hyperion', true)
    await manager.setAutomaticUpdates('hypershield', false)

    const state = await manager.checkForAutomaticUpdates()

    expect(state.products.hyperion.currentReleaseId).toBe('github:saintromuald/hyperion-public:1')
    expect(state.products.hyperion.installedReleases).toEqual([])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('skips raw-only Hyperion catalogs during automatic checks', async () => {
    const fetchImpl = fetchFor([rawRelease(1, '1.0.0')], {
      'Hyperion.x86_64': executable,
      'libSDL3.so.0': library,
    })
    const manager = makeManager(fetchImpl)
    await manager.trackLatest('hyperion')
    await manager.setAutomaticUpdates('hyperion', true)
    await manager.setAutomaticUpdates('hypershield', false)

    const state = await manager.checkForAutomaticUpdates()
    expect(state.products.hyperion).toMatchObject({
      currentVersion: '0.7.1-beta',
      operation: 'idle',
    })
    expect(state.products.hyperion.installedReleases).toEqual([])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not automatically install an archive older than the bundled prerelease', async () => {
    const archive = await archiveRelease(1, '0.7.0')
    const fetchImpl = fetchFor([archive.release], { [archive.name]: archive.contents })
    const manager = makeManager(fetchImpl)
    await manager.trackLatest('hyperion')
    await manager.setAutomaticUpdates('hyperion', true)
    await manager.setAutomaticUpdates('hypershield', false)

    const state = await manager.checkForAutomaticUpdates()
    expect(state.products.hyperion).toMatchObject({
      currentVersion: '0.7.1-beta',
      operation: 'idle',
    })
    expect(state.products.hyperion.installedReleases).toEqual([])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('fails safe when an automatic update cannot parse the current version', async () => {
    const releases = [
      githubRelease('hypershield', 1, '13.0.0', [
        githubAsset('HyperShield-13.0.0-x86_64.AppImage', appImage),
      ]),
    ]
    const fetchImpl = fetchFor(releases, { 'HyperShield-13.0.0-x86_64.AppImage': appImage })
    const manager = new ReleaseManager({
      appPath,
      userDataPath,
      clientVersion: 'development-build',
      platform: 'linux',
      architecture: 'x64',
      fetch: fetchImpl,
    })

    const state = await manager.checkForAutomaticUpdates()
    expect(state.products.hypershield).toMatchObject({
      currentVersion: 'development-build',
      operation: 'error',
    })
    expect(state.products.hypershield.statusMessage).toContain('valid semantic version')
    expect(state.products.hypershield.installedReleases).toEqual([])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('stages the latest AppImage without restarting and relaunches it only on request', async () => {
    const releases = [
      githubRelease('hypershield', 1, '13.0.0', [
        githubAsset('HyperShield-13.0.0-x86_64.AppImage', appImage),
      ]),
    ]
    const manager = makeManager(
      fetchFor(releases, { 'HyperShield-13.0.0-x86_64.AppImage': appImage }),
    )
    await manager.setAutomaticUpdates('hyperion', false)
    const state = await manager.checkForAutomaticUpdates()

    expect(state.products.hypershield).toMatchObject({
      selection: 'latest',
      operation: 'readyToRestart',
      currentVersion: '12.3.6',
      currentReleaseId: 'github:saintromuald/ShieldBattery:1',
    })
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()

    const refreshed = await manager.refresh('hypershield')
    expect(refreshed.products.hypershield.operation).toBe('readyToRestart')

    const reloaded = makeManager(vi.fn())
    const persisted = await reloaded.initialize()
    expect(persisted.products.hypershield).toMatchObject({
      currentVersion: '12.3.6',
      currentReleaseId: 'github:saintromuald/ShieldBattery:1',
      operation: 'readyToRestart',
    })

    const registry = await readInstalledRegistry(userDataPath)
    const stagedPath = installedReleaseExecutable(
      userDataPath,
      'hypershield',
      registry.hypershield[0],
    )
    await manager.restartClient()
    expect(app.relaunch).toHaveBeenCalledExactlyOnceWith({ execPath: stagedPath, args: [] })
    expect(app.quit).toHaveBeenCalledOnce()

    const restarted = new ReleaseManager({
      appPath,
      userDataPath,
      clientVersion: '13.0.0',
      platform: 'linux',
      architecture: 'x64',
      fetch: vi.fn(),
    })
    const restartedState = await restarted.initialize()
    expect(restartedState.products.hypershield).toMatchObject({
      currentVersion: '13.0.0',
      currentReleaseId: 'github:saintromuald/ShieldBattery:1',
      operation: 'idle',
      selection: 'latest',
    })
  })

  it.skipIf(process.platform !== 'linux')(
    'automatically installs a newer Shield archive while skipping newer raw packages',
    async () => {
      const archive = await archiveRelease(2, '2.0.0-beta', true)
      const releases = [
        rawRelease(1, '1.0.0-beta', true),
        archive.release,
        rawRelease(3, '3.0.0-beta', true),
      ]
      const manager = makeManager(
        fetchFor(releases, {
          'Hyperion.x86_64': executable,
          'libSDL3.so.0': library,
          [archive.name]: archive.contents,
        }),
      )
      await manager.setChannel('hyperion', 'prerelease')
      await manager.trackLatest('hyperion')
      await manager.setAutomaticUpdates('hyperion', true)
      await manager.setAutomaticUpdates('hypershield', false)
      const state = await manager.checkForAutomaticUpdates()
      expect(state.products.hyperion.currentReleaseId).toBe('github:saintromuald/hyperion-public:2')
      expect(state.products.hyperion.selection).toBe('latest')
      expect(state.products.hyperion.operation).toBe('idle')
      expect((await readInstalledRegistry(userDataPath)).hyperion[0].packageKind).toBe('archive')
      expect(app.relaunch).not.toHaveBeenCalled()
    },
  )
})
