import { describe, expect, it, vi } from 'vitest'
import { ShieldBatteryFile } from '../../common/shieldbattery-file'
import { collectGameplayCapabilities, hyperionProfileForInstall } from './gameplay-capabilities'
import { HyperionInstall } from './hyperion/launch'

vi.mock('electron', () => ({ app: { getAppPath: () => '/unused' } }))
vi.mock('../logger', () => ({ default: { error: vi.fn(), verbose: vi.fn() } }))

const INSTALL: HyperionInstall = {
  executablePath: '/opt/hyperion/Hyperion.x86_64',
  executableSha256: 'c'.repeat(64),
  compatibility: {
    adapterProtocol: 1,
    engineBuild: 'hyperion-test',
    simRevision: 23,
    rules: 'classic',
    modId: 'bw',
    modFingerprint: 'b'.repeat(40),
    dataFingerprint: 'C3D54EC8',
    rollback: false,
  },
}

describe('collectGameplayCapabilities', () => {
  it('advertises native support without requiring SC:R on Linux', async () => {
    const checkScr = vi.fn()
    const snapshot = await collectGameplayCapabilities({
      gameDataPath: '/games/StarCraft',
      readHyperion: async () => INSTALL,
      checkScr,
      platform: 'linux',
      architecture: 'x64',
    })
    expect(snapshot.capabilities.hyperion).toMatchObject({
      engineBuild: 'hyperion-test',
      dataFingerprint: 'c3d54ec8',
      executableSha256: 'c'.repeat(64),
    })
    expect(snapshot.capabilities.scrAvailable).toBe(false)
    expect(snapshot.capabilities.hyperion?.features).not.toContain('plutoComputer')
    expect(snapshot.hyperionInstall).toBe(INSTALL)
    expect(checkScr).not.toHaveBeenCalled()
  })

  it('does not treat native game data as proof of SC:R compatibility', async () => {
    const snapshot = await collectGameplayCapabilities({
      gameDataPath: 'C:\\Games\\StarCraft',
      readHyperion: async () => INSTALL,
      checkScr: async () => ({ path: false, version: false }),
      checkScrDll: async () => [],
      platform: 'win32',
      architecture: 'x64',
    })
    expect(snapshot.capabilities.hyperion).toBeDefined()
    expect(snapshot.capabilities.scrAvailable).toBe(false)
  })

  it('keeps independent SC:R compatibility available when native probing fails', async () => {
    const snapshot = await collectGameplayCapabilities({
      gameDataPath: 'C:\\Games\\StarCraft',
      readHyperion: async () => {
        throw new Error('native data missing')
      },
      checkScr: async () => ({ path: true, version: true }),
      checkScrDll: async () => [
        [ShieldBatteryFile.Init, true],
        [ShieldBatteryFile.Main, true],
      ],
      platform: 'win32',
      architecture: 'x64',
    })
    expect(snapshot.capabilities.hyperion).toBeUndefined()
    expect(snapshot.capabilities.scrAvailable).toBe(true)
    expect(snapshot.hyperionInstall).toBeUndefined()
  })

  it('does not advertise an install without an executable identity', async () => {
    const snapshot = await collectGameplayCapabilities({
      gameDataPath: '/games/StarCraft',
      readHyperion: async () => ({ ...INSTALL, executableSha256: undefined }),
      platform: 'linux',
      architecture: 'x64',
    })
    expect(snapshot.capabilities.hyperion).toBeUndefined()
    expect(snapshot.hyperionInstall).toBeUndefined()
  })
})

describe('hyperionProfileForInstall', () => {
  it('never advertises Pluto for 0.7.3, even if an unexpected feature field is present', () => {
    const profile = hyperionProfileForInstall(
      {
        ...INSTALL,
        compatibility: {
          ...INSTALL.compatibility,
          engineBuild: 'Hyperion-v0.7.3-beta',
          features: ['plutoComputer'],
        },
      },
      'linux',
      'x64',
    )

    expect(profile.features).not.toContain('plutoComputer')
  })

  it('requires both a post-0.7.3 build and explicit engine Pluto compatibility', () => {
    const withoutFeature = hyperionProfileForInstall(
      {
        ...INSTALL,
        compatibility: { ...INSTALL.compatibility, engineBuild: 'Hyperion-v0.7.4-beta' },
      },
      'linux',
      'x64',
    )
    const withFeature = hyperionProfileForInstall(
      {
        ...INSTALL,
        compatibility: {
          ...INSTALL.compatibility,
          engineBuild: 'Hyperion-v0.7.4-beta',
          features: ['plutoComputer'],
        },
      },
      'win32',
      'x64',
    )

    expect(withoutFeature.features).not.toContain('plutoComputer')
    expect(withFeature.features).toContain('plutoComputer')
  })

  it('rejects unsupported Windows architectures', () => {
    expect(() => hyperionProfileForInstall(INSTALL, 'win32', 'arm64')).toThrow('x64 Windows')
  })

  it('advertises Apple Silicon macOS without claiming SC:R injection support', async () => {
    const checkScr = vi.fn()
    const snapshot = await collectGameplayCapabilities({
      readHyperion: async () => INSTALL,
      checkScr,
      platform: 'darwin',
      architecture: 'arm64',
    })

    expect(snapshot.capabilities.hyperion).toMatchObject({
      platform: 'darwin',
      architecture: 'arm64',
      engineBuild: 'hyperion-test',
    })
    expect(snapshot.capabilities.scrAvailable).toBe(false)
    expect(checkScr).not.toHaveBeenCalled()
  })

  it('rejects unsupported operating systems and Intel macOS', () => {
    expect(() => hyperionProfileForInstall(INSTALL, 'freebsd', 'x64')).toThrow('operating system')
    expect(() => hyperionProfileForInstall(INSTALL, 'darwin', 'x64')).toThrow('ARM64 macOS')
  })
})
