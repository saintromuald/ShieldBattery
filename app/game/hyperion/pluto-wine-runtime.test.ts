import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { METALSHARP_WINE_DOWNLOAD_BYTES } from '../../../common/pluto-runtime'
import type { ReleaseAsset } from '../../../common/release-center'
import { makeMachOArm64, makePe32X86 } from '../../releases/testing/fixtures'
import {
  installMetalSharpWineArchive,
  isMetalSharpWineInstalled,
  type MacCommandRunner,
  METALSHARP_WINE_ARCHIVE_ASSET,
  metalSharpWineAppPath,
  metalSharpWineExecutablePath,
  verifyMetalSharpWineApp,
} from './pluto-wine-runtime'

let temporaryDirectory: string
let fixtureApp: string

const ENTITLEMENTS = `<?xml version="1.0"?><plist><dict>
<key>com.apple.developer.cross-architecture-support</key><true/>
</dict></plist>`
const PROFILE = `<?xml version="1.0"?><plist><dict>
<key>Entitlements</key><dict>
<key>com.apple.application-identifier</key><string>TEAMID.com.metalsharp.wine</string>
<key>com.apple.developer.cross-architecture-support</key><true/>
</dict></dict></plist>`
const OUTER_INFO = {
  CFBundleIdentifier: 'com.metalsharp.wine',
  CFBundleExecutable: 'wine',
  CFBundleName: 'MetalSharp Wine',
  CFBundleShortVersionString: '6.0',
  CFBundleGetInfoString: 'MetalSharp Wine 6.0 (Wine 11.20, arm64, FEX)',
}
const LOADER_INFO = {
  CFBundleIdentifier: 'com.metalsharp.wine',
  CFBundleExecutable: 'wine',
  CFBundleName: 'MetalSharp Wine',
  CFBundleShortVersionString: '11.20',
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-metalsharp-wine-test-'))
  fixtureApp = path.join(temporaryDirectory, 'fixture', 'MetalSharp-Wine.app')
  const contents = path.join(fixtureApp, 'Contents')
  const unix = path.join(contents, 'lib', 'wine', 'aarch64-unix')
  const windows = path.join(contents, 'lib', 'wine', 'aarch64-windows')
  const loader = path.join(unix, 'wine.app')
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true })
  await fs.mkdir(windows, { recursive: true })
  await fs.mkdir(path.join(loader, 'Contents', 'MacOS'), { recursive: true })
  await fs.writeFile(path.join(contents, 'MacOS', 'wine'), makeMachOArm64(), { mode: 0o755 })
  await fs.writeFile(path.join(loader, 'Contents', 'MacOS', 'wine'), makeMachOArm64(), {
    mode: 0o755,
  })
  await fs.symlink('MacOS', path.join(contents, 'bin'))
  await fs.symlink('wine.app/Contents/MacOS/wine', path.join(unix, 'wine'))
  for (const name of ['libarm64ecfex', 'libwow64fex']) {
    await fs.writeFile(path.join(unix, `${name}.so`), makeMachOArm64('dynamicLibrary'))
    await fs.writeFile(path.join(windows, `${name}.dll`), makePe32X86())
  }
  await fs.writeFile(path.join(contents, 'Info.plist'), 'outer info')
  await fs.writeFile(path.join(loader, 'Contents', 'Info.plist'), 'loader info')
  await fs.writeFile(path.join(contents, 'embedded.provisionprofile'), 'outer profile')
  await fs.writeFile(path.join(loader, 'Contents', 'embedded.provisionprofile'), 'loader profile')
  if (process.platform === 'win32') {
    // Windows reads relative symlink targets with backslashes; expose this Mac fixture's POSIX
    // targets so verification still checks their exact archived values.
    const readlink = fs.readlink.bind(fs)
    vi.spyOn(fs, 'readlink').mockImplementation(async (linkPath, options) => {
      const target = await readlink(linkPath, options)
      return typeof target === 'string' ? target.replaceAll('\\', '/') : target
    })
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

interface RunnerFailures {
  extraction?: boolean
  signature?: boolean
  version?: boolean
}

function successfulRunner(failures: RunnerFailures = {}) {
  return vi.fn<MacCommandRunner>(async (executablePath, args) => {
    if (executablePath === '/usr/bin/ditto') {
      if (failures.extraction) throw new Error('injected ditto failure')
      const destination = args[3]
      await fs.cp(fixtureApp, path.join(destination, 'MetalSharp-Wine.app'), {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      })
      return { stdout: '', stderr: '' }
    }
    if (executablePath === '/usr/bin/codesign') {
      if (args[0] === '--verify') {
        if (failures.signature) throw new Error('injected codesign failure')
        return { stdout: '', stderr: '' }
      }
      if (args[0] === '-dv') {
        return {
          stdout: '',
          stderr:
            'Identifier=com.metalsharp.wine\nAuthority=Developer ID Application: MetalSharp (TEAMID)\n',
        }
      }
      if (args.includes('--entitlements')) return { stdout: ENTITLEMENTS, stderr: '' }
    }
    if (executablePath === '/usr/bin/security') return { stdout: PROFILE, stderr: '' }
    if (executablePath === '/usr/bin/plutil') {
      const inner = args.at(-1)?.includes(path.join('wine.app', 'Contents', 'Info.plist'))
      return { stdout: JSON.stringify(inner ? LOADER_INFO : OUTER_INFO), stderr: '' }
    }
    if (executablePath === metalSharpWineExecutablePath(fixtureApp) || args[0] === '--version') {
      return {
        stdout: failures.version ? 'wine-10.0\n' : 'wine-11.20-test (MetalSharp Wine 6.0)\n',
        stderr: '',
      }
    }
    throw new Error(`Unexpected command: ${executablePath} ${args.join(' ')}`)
  })
}

async function archiveFixture(): Promise<{ archivePath: string; asset: ReleaseAsset }> {
  const contents = Buffer.from('small host-side archive fixture')
  const archivePath = path.join(temporaryDirectory, 'metalsharp-fixture.zip')
  await fs.writeFile(archivePath, contents)
  return {
    archivePath,
    asset: {
      name: 'metalsharp-fixture.zip',
      url: METALSHARP_WINE_ARCHIVE_ASSET.url,
      size: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
    },
  }
}

function destination(): string {
  return metalSharpWineAppPath(temporaryDirectory)
}

async function installFixture(runner: MacCommandRunner, archiveAsset?: ReleaseAsset) {
  const { archivePath, asset } = await archiveFixture()
  await installMetalSharpWineArchive({
    archivePath,
    destination: destination(),
    runner,
    archiveAsset: archiveAsset ?? asset,
  })
}

describe('MetalSharp Wine dependency', () => {
  it('pins the official archive and exact app-managed discovery path', () => {
    expect(METALSHARP_WINE_ARCHIVE_ASSET).toEqual({
      name: 'MetalSharp-Wine-6.0-arm64.zip',
      url: 'https://github.com/metalsharp/MetalSharp-Wine/releases/download/v6.0/MetalSharp-Wine-6.0-arm64.zip',
      size: 1_356_725_682,
      sha256: '25f7dff91000c03c835b800980878acb12c1f952a4b7853f77de7f21fb87046f',
    })
    expect(METALSHARP_WINE_ARCHIVE_ASSET.size).toBe(METALSHARP_WINE_DOWNLOAD_BYTES)
    const app = destination()
    expect(app).toBe(
      path.join(
        temporaryDirectory,
        'Library',
        'Application Support',
        'Hyperion',
        'MetalSharp-Wine-6.0.app',
      ),
    )
    expect(metalSharpWineExecutablePath(app)).toBe(path.join(app, 'Contents', 'MacOS', 'wine'))
  })

  it('verifies with ditto and strict/deep codesign before atomically publishing symlinks', async () => {
    const runner = successfulRunner()
    await installFixture(runner)

    const app = destination()
    expect(await isMetalSharpWineInstalled(app, successfulRunner())).toBe(true)
    expect(await fs.readlink(path.join(app, 'Contents', 'bin'))).toBe('MacOS')
    expect(
      await fs.readlink(path.join(app, 'Contents', 'lib', 'wine', 'aarch64-unix', 'wine')),
    ).toBe('wine.app/Contents/MacOS/wine')
    expect(runner).toHaveBeenCalledWith('/usr/bin/ditto', [
      '-x',
      '-k',
      path.join(temporaryDirectory, 'metalsharp-fixture.zip'),
      expect.stringContaining('.metalsharp-wine-staging-'),
    ])
    expect(runner).toHaveBeenCalledWith('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      expect.stringContaining('.metalsharp-wine-staging-'),
    ])
    expect(runner.mock.calls.some(([executable]) => executable.includes('unzip'))).toBe(false)
    expect((await fs.readdir(path.dirname(app))).some(name => name.includes('staging'))).toBe(false)
  })

  it('rejects an archive hash mismatch before extraction and preserves the existing app', async () => {
    const app = destination()
    await fs.mkdir(app, { recursive: true })
    await fs.writeFile(path.join(app, 'keep-marker'), 'known good')
    const { archivePath, asset } = await archiveFixture()
    const runner = successfulRunner()

    await expect(
      installMetalSharpWineArchive({
        archivePath,
        destination: app,
        runner,
        archiveAsset: { ...asset, sha256: '0'.repeat(64) },
      }),
    ).rejects.toThrow('SHA-256 verification failed')

    expect(runner).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(app, 'keep-marker'), 'utf8')).toBe('known good')
  })

  it.each(['extraction', 'signature'] as const)(
    'preserves the existing app after %s failure and cleans owned staging',
    async failure => {
      const app = destination()
      await fs.mkdir(app, { recursive: true })
      await fs.writeFile(path.join(app, 'keep-marker'), 'known good')

      await expect(installFixture(successfulRunner({ [failure]: true }))).rejects.toThrow(
        failure === 'extraction' ? 'injected ditto failure' : 'injected codesign failure',
      )

      expect(await fs.readFile(path.join(app, 'keep-marker'), 'utf8')).toBe('known good')
      const siblings = await fs.readdir(path.dirname(app))
      expect(siblings.some(name => name.startsWith('.metalsharp-wine-staging-'))).toBe(false)
      expect(siblings.some(name => name.startsWith('.metalsharp-wine-backup-'))).toBe(false)
    },
  )

  it('rejects a non-Wine-11 version probe without publishing', async () => {
    await expect(installFixture(successfulRunner({ version: true }))).rejects.toThrow(
      'did not report Wine 11',
    )
    await expect(fs.lstat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires both embedded profiles and the exact FEX runtime layout', async () => {
    await fs.rm(path.join(fixtureApp, 'Contents', 'embedded.provisionprofile'))
    await expect(verifyMetalSharpWineApp(fixtureApp, successfulRunner())).rejects.toThrow(
      'embedded provisioning profile',
    )

    await fs.writeFile(path.join(fixtureApp, 'Contents', 'embedded.provisionprofile'), 'profile')
    await fs.rm(
      path.join(fixtureApp, 'Contents', 'lib', 'wine', 'aarch64-windows', 'libwow64fex.dll'),
    )
    await expect(verifyMetalSharpWineApp(fixtureApp, successfulRunner())).rejects.toThrow(
      'libwow64fex Windows library',
    )
    expect(await isMetalSharpWineInstalled(fixtureApp, successfulRunner())).toBe(false)
  })

  it('restores the previous app when the final atomic rename fails', async () => {
    const app = destination()
    await fs.mkdir(app, { recursive: true })
    await fs.writeFile(path.join(app, 'keep-marker'), 'known good')
    const originalRename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).includes('.metalsharp-wine-staging-') && String(newPath) === app) {
        throw new Error('injected final rename failure')
      }
      return originalRename(oldPath, newPath)
    })

    await expect(installFixture(successfulRunner())).rejects.toThrow(
      'injected final rename failure',
    )
    expect(await fs.readFile(path.join(app, 'keep-marker'), 'utf8')).toBe('known good')
    const siblings = await fs.readdir(path.dirname(app))
    expect(siblings.some(name => name.startsWith('.metalsharp-wine-staging-'))).toBe(false)
    expect(siblings.some(name => name.startsWith('.metalsharp-wine-backup-'))).toBe(false)
  })
})
