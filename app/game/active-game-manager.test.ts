import { EventEmitter } from 'node:events'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GameplayBackend,
  GameplayBackendPolicy,
  GameplayBackendSelectionReason,
  hyperionProfileCompatibility,
  ResolvedGameplayRouting,
} from '../../common/games/backend'
import { GameLaunchConfig } from '../../common/games/game-launch-config'
import { GameType } from '../../common/games/game-type'
import { NetcodeV2ServerSetup } from '../../common/games/netcode-v2'
import { InGameReportRequest } from '../../common/ipc'
import { SlotType } from '../../common/lobbies/slot'
import { MapInfoJson } from '../../common/maps'
import { MatchmakingType } from '../../common/matchmaking'
import { makeSbUserId, SbUserId } from '../../common/users/sb-user-id'
import { ActiveGameManager } from './active-game-manager'
import { checkStarcraftPath } from './check-starcraft-path'
import { hyperionProfileForInstall } from './gameplay-capabilities'
import { HyperionInstall, HyperionLaunchOptions, HyperionLaunchResult } from './hyperion/launch'

const { verifyGame, electronApp } = vi.hoisted(() => ({
  verifyGame: vi.fn<() => Promise<void>>(),
  electronApp: {
    getAppPath: () => 'C:\\fake-app',
    getPath: vi.fn(() => '/fake-user-data'),
    isPackaged: true,
  },
}))
vi.mock('virtual:sb-security-impl', () => ({ verifyGame }))

// ActiveGameManager pulls in Electron (and modules that initialize against a real Electron
// process) at module scope; these are irrelevant to the keypair-lifecycle behavior under test, so
// they're stubbed just far enough for the module to load. The launch path is pinned mid-flight
// (`checkStarcraftPath` never resolves) so no game process is ever spawned and no
// launch-error/exit handler can clear the active game out from under the test.
vi.mock('electron', () => ({
  app: electronApp,
  screen: {},
}))
vi.mock('electron-is-dev', () => ({ default: false }))
vi.mock('@shieldbattery/windows-registry', () => ({
  HKCU: 'HKCU',
  REG_SZ: 'REG_SZ',
  WindowsRegistry: class {},
}))
vi.mock('../logger', () => ({
  default: { verbose: () => {}, warning: () => {}, error: () => {} },
}))
vi.mock('../log-paths', () => ({ gameLogBaseName: () => 'game' }))
vi.mock('../settings', () => ({
  LocalSettingsManager: class {},
  ScrSettingsManager: class {},
}))
vi.mock('./map-store', () => ({ MapStore: class {} }))
vi.mock('./check-starcraft-path', () => ({
  checkStarcraftPath: vi.fn(() => new Promise(() => {})),
}))

function makeManager(): ActiveGameManager {
  return makeManagerWithSettings().manager
}

function makeManagerWithSettings() {
  // The launch path's very first step awaits the local settings; pinning that await keeps the
  // launch permanently in flight (see the `checkStarcraftPath` mock note above), so the launch
  // outcome handlers never race the assertions. Settings changes still reach the manager through
  // `change` events.
  const localSettings = Object.assign(new EventEmitter(), { get: () => new Promise(() => {}) })
  const scrSettings = {
    get: () => new Promise(() => {}),
    syncWithGameSettingsFile: vi.fn(async () => {}),
  }
  const manager = new ActiveGameManager({} as any, localSettings as any, scrSettings as any)
  return { manager, localSettings, scrSettings }
}

function configFor(gameId: string): GameLaunchConfig {
  // `map` must exist for the replay-config checks status reporting runs through.
  return { setup: { gameId, useNetcodeV2: true, map: {} } } as unknown as GameLaunchConfig
}

function replayConfigFor(gameId: string): GameLaunchConfig {
  return {
    serverConfig: { serverUrl: 'https://server.invalid' },
    setup: { gameId, map: { isReplay: true, path: `C:\\replays\\${gameId}.rep` } },
  } as unknown as GameLaunchConfig
}

function setupFor(clientPubkey: string | undefined): NetcodeV2ServerSetup {
  return { clientPubkey } as NetcodeV2ServerSetup
}

describe('ActiveGameManager packaged launch checks', () => {
  beforeEach(() => {
    vi.spyOn(fsPromises, 'access').mockResolvedValue(undefined)
    vi.mocked(checkStarcraftPath).mockClear()
    verifyGame.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    electronApp.isPackaged = true
    vi.restoreAllMocks()
  })

  function launch() {
    const localSettings = Object.assign(new EventEmitter(), {
      get: async () => ({ starcraftPath: 'C:\\StarCraft', launch32Bit: false }),
    })
    const manager = new ActiveGameManager({} as any, localSettings as any, {} as any)
    const statuses: Array<{ state: string; extra?: unknown }> = []
    manager.on('gameStatus', status => statuses.push(status))
    manager.setGameConfig(configFor('launch-check'))
    return { manager, statuses }
  }

  it('checks a packaged DLL before proceeding to StarCraft setup', async () => {
    electronApp.isPackaged = true
    launch()
    await vi.waitFor(() => expect(checkStarcraftPath).toHaveBeenCalledWith('C:\\StarCraft'))
    expect(verifyGame).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/shieldbattery_64\.dll$/),
    )
    expect(verifyGame.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(checkStarcraftPath).mock.invocationCallOrder[0],
    )
  })

  it('fails a packaged launch when the DLL check rejects', async () => {
    electronApp.isPackaged = true
    const failure = new Error('DLL check failed')
    verifyGame.mockRejectedValue(failure)
    const { manager, statuses } = launch()
    await vi.waitFor(() =>
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          extra: failure,
        }),
      ),
    )
    expect(manager.getStatus()).toBeNull()
    expect(checkStarcraftPath).not.toHaveBeenCalled()
  })

  it('allows unpackaged DLLs even when electron-is-dev is false', async () => {
    electronApp.isPackaged = false
    verifyGame.mockRejectedValue(new Error('development DLL'))
    launch()
    await vi.waitFor(() => expect(checkStarcraftPath).toHaveBeenCalledWith('C:\\StarCraft'))
    expect(verifyGame).not.toHaveBeenCalled()
  })

  it('keeps ordinary matchmaking on SC:R when a Hyperion backend is available', async () => {
    const localSettings = Object.assign(new EventEmitter(), {
      get: async () => ({ starcraftPath: 'C:\\StarCraft', launch32Bit: false }),
    })
    const hyperionLaunch = vi.fn()
    const manager = new ActiveGameManager({} as any, localSettings as any, {} as any, {
      install: {} as HyperionInstall,
      launch: hyperionLaunch,
    })
    const config = configFor('ordinary-matchmaking')
    config.setup.matchmakingType = MatchmakingType.Match1v1

    manager.setGameConfig(config)

    await vi.waitFor(() => expect(checkStarcraftPath).toHaveBeenCalledWith('C:\\StarCraft'))
    expect(hyperionLaunch).not.toHaveBeenCalled()
  })
})

describe('ActiveGameManager netcode v2 keypair lifecycle', () => {
  let manager: ActiveGameManager
  let commands: Array<[string, string, ...any[]]>

  beforeEach(() => {
    manager = makeManager()
    commands = []
    manager.on('gameCommand', (gameId, command, ...args) => {
      commands.push([gameId, command, ...args])
    })
  })

  function deliveredSetups(
    gameId: string,
  ): Array<NetcodeV2ServerSetup & { clientPrivateKey: string }> {
    return commands
      .filter(([id, command]) => id === gameId && command === 'netcodeV2Setup')
      .map(([, , setup]) => setup)
  }

  function deliveredSetup(gameId: string): NetcodeV2ServerSetup & { clientPrivateKey: string } {
    const delivered = deliveredSetups(gameId)
    expect(delivered.length, `netcodeV2Setup was delivered for ${gameId}`).toBeGreaterThan(0)
    return delivered[delivered.length - 1]
  }

  it('resolves the echoed pubkey again for a requeued match under a new game id', () => {
    // The failed-load requeue flow: the player queues once (one generated keypair), the first
    // match adopts it, loading fails, and the server requeues the player with the SAME pubkey
    // (its queue entry survives) -- so the next match's handoff echoes that pubkey under a brand
    // new game id, which deliberately carries nothing over from the failed game.
    const pubkey = manager.generateNetcodeV2SessionKeys()

    manager.setGameConfig(configFor('game-1'))
    manager.setNetcodeV2Setup('game-1', setupFor(pubkey))
    expect(deliveredSetup('game-1').clientPrivateKey).toBeDefined()

    // Loading fails; the server cancels the game client-side.
    manager.clearGameConfig('game-1')

    manager.setGameConfig(configFor('game-2'))
    manager.setNetcodeV2Setup('game-2', setupFor(pubkey))

    const second = deliveredSetup('game-2')
    expect(second.clientPrivateKey).toBe(deliveredSetup('game-1').clientPrivateKey)
    expect(manager.getStatus()?.state).not.toBe('error')
  })

  it('a relaunch of the same game id reuses the adopted keypair without a fresh handoff lookup', () => {
    const pubkey = manager.generateNetcodeV2SessionKeys()

    manager.setGameConfig(configFor('game-1'))
    manager.setNetcodeV2Setup('game-1', setupFor(pubkey))
    const first = deliveredSetup('game-1')

    // The same game id relaunches (e.g. the process died before init); the adopted keypair and
    // handoff carry forward on the game itself, no ring lookup involved. Assert on a genuinely
    // second delivery -- a single delivery re-read would vacuously "match" itself.
    manager.setGameConfig(configFor('game-1'))
    manager.setNetcodeV2Setup('game-1', setupFor(pubkey))
    const setups = deliveredSetups('game-1')
    expect(setups.length).toBe(2)
    expect(setups[1].clientPrivateKey).toBe(first.clientPrivateKey)
  })

  it('quits the game with an explicit error when no keypair can be adopted', () => {
    const statuses: Array<{ state: string; extra?: unknown }> = []
    manager.on('gameStatus', status => statuses.push(status))

    manager.setGameConfig(configFor('game-1'))
    manager.setNetcodeV2Setup('game-1', setupFor('pubkey-nobody-generated'))

    expect(commands).toContainEqual(['game-1', 'quit'])
    expect(manager.getStatus()).toBeNull()
    const errorStatus = statuses.find(status => status.state === 'error')
    expect(errorStatus, 'an error status was emitted').toBeDefined()
    expect(String(errorStatus!.extra)).toContain('no adoptable keypair (noKeysGenerated)')
  })
})

describe('ActiveGameManager Hyperion sidecar launch', () => {
  const hostId = makeSbUserId(101)
  const guestId = makeSbUserId(202)
  const install: HyperionInstall = {
    executablePath: '/hyperion/Hyperion.x86_64',
    executableSha256: 'c'.repeat(64),
    compatibility: {
      adapterProtocol: 1,
      engineBuild: 'hyperion-test-build',
      simRevision: 23,
      rules: 'classic',
      modId: '',
      modFingerprint: 'b'.repeat(40),
      dataFingerprint: '0123abcd',
      rollback: false,
    },
  }

  function hyperionConfigFor(gameId: string): GameLaunchConfig {
    const host = {
      id: 'host-slot',
      userId: hostId,
      race: 'z',
      playerId: 0,
      teamId: 0,
      type: SlotType.Human,
      typeId: 6,
    }
    const guest = {
      id: 'guest-slot',
      userId: guestId,
      race: 't',
      playerId: 1,
      teamId: 1,
      type: SlotType.Human,
      typeId: 6,
    }
    return {
      localUser: { id: hostId, name: 'HostPlayer', created: 0 },
      blockedUsers: [],
      serverConfig: { serverUrl: 'https://server.invalid' },
      language: 'en',
      setup: {
        gameId,
        name: 'Hyperion test game',
        map: {
          hash: 'a'.repeat(64),
          mapData: { format: 'scx' },
          mapUrl: 'https://maps.invalid/map.scx',
        } as MapInfoJson,
        gameType: GameType.OneVsOne,
        gameSubType: 0,
        slots: [host, guest],
        host,
        users: [
          { id: hostId, name: 'HostPlayer', created: 0 },
          { id: guestId, name: 'GuestPlayer', created: 0 },
        ],
        disableAllianceChanges: true,
        seed: 0x12345678,
        useNetcodeV2: true,
        matchmakingType: MatchmakingType.Hyperion1v1Rule1,
        resultCode: 'result-code-for-the-sidecar',
      },
    } as GameLaunchConfig
  }

  function withResolvedHyperion(
    config: GameLaunchConfig,
    rules: ResolvedGameplayRouting['rules'] = { ruleSet: 'classic' },
  ): GameLaunchConfig {
    config.setup.gameplay = {
      version: 1,
      requestedPolicy: GameplayBackendPolicy.HyperionFirst,
      backend: GameplayBackend.Hyperion,
      reason: GameplayBackendSelectionReason.Preferred,
      rules,
      nativeProfile: hyperionProfileCompatibility(
        hyperionProfileForInstall(install, 'linux', 'x64'),
      ),
      transport: 'netcodeV2',
      simulation: 'lockstep',
      replay:
        rules.ruleSet === 'classic'
          ? { format: 'scr', playbackBackend: GameplayBackend.Hyperion }
          : { format: 'hxRS', playbackBackend: GameplayBackend.Hyperion },
    }
    return config
  }

  function plutoConfigFor(
    gameId: string,
    localUserId = hostId,
    plutoOwnerUserId?: SbUserId,
  ): GameLaunchConfig {
    const config = withResolvedHyperion(hyperionConfigFor(gameId), { ruleSet: 'hyperion' })
    config.setup.plutoOwnerUserId = plutoOwnerUserId
    config.localUser =
      localUserId === hostId
        ? { id: hostId, name: 'HostPlayer', created: 0 }
        : { id: guestId, name: 'GuestPlayer', created: 0 }
    config.setup.gameType = GameType.Melee
    config.setup.matchmakingType = undefined
    config.setup.slots.forEach(slot => {
      slot.teamId = 0
    })
    config.setup.slots.push({
      id: 'pluto',
      race: 'p',
      playerId: 0,
      teamId: 0,
      type: SlotType.Computer,
      typeId: 0,
      ai: { level: 'pluto' },
    })
    return config
  }

  function hyperionNetcodeFor(clientPubkey: string): NetcodeV2ServerSetup {
    return {
      token: 'session-token-test-value',
      clientPubkey,
      homeRelay: {
        relayId: 7,
        addrs: ['127.0.0.1:9000'],
        serverName: 'localhost',
        cert: 'relay-certificate',
      },
      roster: [
        { slot: 0, userId: hostId, homeRelayId: 7 },
        { slot: 1, userId: guestId, homeRelayId: 7 },
      ],
      initialBufferTurns: 3,
      rollback: false,
    }
  }

  function makeHarness(
    launch: (options: HyperionLaunchOptions) => Promise<any>,
    backend: {
      install?: HyperionInstall
      readInstall?: (options?: { gameDataPath?: string }) => Promise<HyperionInstall>
      launchReplay?: (options: any) => Promise<any>
      readReplayMetadata?: (filePath: string) => Promise<any>
      checkPlutoRuntime?: (hyperionDataPath: string) => Promise<void>
    } = { install },
  ) {
    const mapStore = {
      getPath: vi.fn(() => '/maps/fighting-spirit.scx'),
      downloadMap: vi.fn(async () => true),
    }
    const localSettings = Object.assign(new EventEmitter(), {
      get: backend.install
        ? () => new Promise(() => {})
        : async () => ({ starcraftPath: '/games/StarCraft' }),
    })
    const scrSettings = { syncWithGameSettingsFile: vi.fn(async () => {}) }
    const manager = new ActiveGameManager(
      mapStore as any,
      localSettings as any,
      scrSettings as any,
      {
        readReplayMetadata: async () => ({
          headerData: { startTime: 0x12345678 },
          players: [],
          shieldBatteryData: undefined,
        }),
        ...backend,
        launch,
      },
    )
    return { manager, mapStore, scrSettings }
  }

  function launchResult(options: HyperionLaunchOptions) {
    let resolveExit!: (code: number) => void
    const exit = new Promise<number>(resolve => {
      resolveExit = resolve
    })
    return {
      result: {
        proc: { waitForExit: vi.fn(() => exit) },
        releaseGpuPreference: vi.fn(),
        quit: vi.fn(async () => {}),
        resultContext: options.resultContext,
      },
      resolveExit,
    }
  }

  it('waits for the complete handoff, launches once, and preserves a clean finish', async () => {
    let launchedOptions: HyperionLaunchOptions | undefined
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      launchedOptions = options
      await options.prepareMap?.()
      process = launchResult(options)
      return process.result
    })
    const { manager, mapStore, scrSettings } = makeHarness(launch)
    const statuses: any[] = []
    manager.on('gameStatus', status => statuses.push(status))

    manager.setGameConfig(hyperionConfigFor('hyperion-1'))
    expect(launch).not.toHaveBeenCalled()
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-1', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    manager.setNetcodeV2Setup('hyperion-1', hyperionNetcodeFor(pubkey))
    expect(launch).toHaveBeenCalledTimes(1)

    expect(launchedOptions!.localUserId).toBe(hostId)
    expect(launchedOptions!.mapPath).toBe('/maps/fighting-spirit.scx')
    expect(launchedOptions!.ruleConfiguration).toEqual({
      ruleSet: 'hyperion',
      antiMeta: false,
    })
    expect(launchedOptions!.resultContext).toEqual({
      resultCode: 'result-code-for-the-sidecar',
      serverUrl: 'https://server.invalid',
    })
    await vi.waitFor(() => expect(mapStore.downloadMap).toHaveBeenCalledTimes(1))
    await launch.mock.results[0].value

    launchedOptions!.onStart!()
    expect(manager.getStatus()).toMatchObject({
      state: 'playing',
      networkStatus: { transport: 'netcodeV2' },
    })
    launchedOptions!.onFinished!()
    expect(process.result.quit).toHaveBeenCalledTimes(1)
    expect(manager.getStatus()?.state).toBe('finished')

    process.resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
    expect(statuses.some(status => status.state === 'error')).toBe(false)
    expect(process.result.releaseGpuPreference).toHaveBeenCalledTimes(1)
    expect(scrSettings.syncWithGameSettingsFile).not.toHaveBeenCalled()
  })

  it('routes an ordinary formation through Hyperion with explicit Classic rules', async () => {
    let launchedOptions: HyperionLaunchOptions | undefined
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      launchedOptions = options
      process = launchResult(options)
      return process.result
    })
    const readInstall = vi.fn(async () => install)
    const { manager } = makeHarness(launch, { readInstall })
    const config = withResolvedHyperion(hyperionConfigFor('ordinary-hyperion'))
    config.setup.matchmakingType = MatchmakingType.Match1v1
    const capabilities = await manager.getGameplayCapabilities()
    expect(capabilities.hyperion?.engineBuild).toBe('hyperion-test-build')
    vi.mocked(checkStarcraftPath).mockClear()

    manager.setGameConfig(config)
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('ordinary-hyperion', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    expect(launchedOptions!.ruleConfiguration).toEqual({ ruleSet: 'classic', antiMeta: false })
    expect(readInstall).toHaveBeenCalledTimes(2)
    expect(checkStarcraftPath).not.toHaveBeenCalled()
    process.resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
  })

  it('fails the whole load when the native profile changes after queueing', async () => {
    const launch = vi.fn()
    const changedInstall: HyperionInstall = {
      ...install,
      compatibility: { ...install.compatibility, engineBuild: 'changed-engine' },
    }
    const readInstall = vi
      .fn(async () => install)
      .mockResolvedValueOnce(install)
      .mockResolvedValueOnce(changedInstall)
    const { manager } = makeHarness(launch, { readInstall })
    const config = withResolvedHyperion(hyperionConfigFor('changed-hyperion'))
    await manager.getGameplayCapabilities()

    manager.setGameConfig(config)
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('changed-hyperion', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
    expect(readInstall).toHaveBeenCalledTimes(2)
    expect(launch).not.toHaveBeenCalled()
  })

  it('routes hxRS playback only through the native replay backend', async () => {
    const liveLaunch = vi.fn()
    let process!: ReturnType<typeof launchResult>
    const launchReplay = vi.fn(async (options: any) => {
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(liveLaunch, { install, launchReplay })
    const config = replayConfigFor('native-replay')
    ;(config.setup.map as any).replay = {
      format: 'hxRS',
      playbackBackend: GameplayBackend.Hyperion,
    }
    vi.mocked(checkStarcraftPath).mockClear()

    manager.setGameConfig(config)
    await vi.waitFor(() => expect(launchReplay).toHaveBeenCalledTimes(1))

    expect(liveLaunch).not.toHaveBeenCalled()
    expect(checkStarcraftPath).not.toHaveBeenCalled()
    expect(launchReplay.mock.calls[0][0].resultContext).toBeUndefined()
    process.resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus('native-replay')).toBeNull())
  })

  it('enables anti-meta only for Hyperion Rule 2', async () => {
    let launchedOptions: HyperionLaunchOptions | undefined
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      launchedOptions = options
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch)
    const config = hyperionConfigFor('hyperion-rule-2')
    config.setup.matchmakingType = MatchmakingType.Hyperion1v1Rule2

    manager.setGameConfig(config)
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-rule-2', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    expect(launchedOptions!.ruleConfiguration).toEqual({
      ruleSet: 'hyperion',
      antiMeta: true,
    })
    process.resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
  })

  it('requires a verified Pluto runtime on the default host owner', async () => {
    const failure = new Error(
      'Pluto AI must be installed and verified on the selected inference owner. Install or repair Pluto AI in Release Center, then rejoin the lobby.',
    )
    const checkPlutoRuntime = vi.fn(async () => Promise.reject(failure))
    const launch = vi.fn()
    const { manager } = makeHarness(launch, { install, checkPlutoRuntime })
    const statuses: any[] = []

    manager.on('gameStatus', status => statuses.push(status))
    manager.setGameConfig(plutoConfigFor('pluto-owner-not-ready'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('pluto-owner-not-ready', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(checkPlutoRuntime).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
    expect(checkPlutoRuntime).toHaveBeenCalledWith(expect.stringContaining('hyperion'))
    expect(launch).not.toHaveBeenCalled()
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'error', extra: failure }))
  })

  it('allows a guest without a Pluto runtime to launch a shared multiplayer formation', async () => {
    const checkPlutoRuntime = vi.fn(async () => {
      throw new Error('a guest must not need the runtime')
    })
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch, { install, checkPlutoRuntime })

    manager.setGameConfig(plutoConfigFor('pluto-guest-without-runtime', guestId))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('pluto-guest-without-runtime', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    expect(checkPlutoRuntime).not.toHaveBeenCalled()
    process.resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
  })

  it('checks the Pluto runtime on an explicit non-host inference owner', async () => {
    const checkPlutoRuntime = vi.fn(async () => {})
    let launchedOptions: HyperionLaunchOptions | undefined
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      launchedOptions = options
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch, { install, checkPlutoRuntime })

    manager.setGameConfig(plutoConfigFor('pluto-guest-owner', guestId, guestId))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('pluto-guest-owner', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    expect(checkPlutoRuntime).toHaveBeenCalledTimes(1)
    expect(launchedOptions!.setup.plutoOwnerUserId).toBe(guestId)
    process.resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
  })

  it('does not require a host runtime when another human owns Pluto inference', async () => {
    const checkPlutoRuntime = vi.fn(async () => {
      throw new Error('a non-owner host must not need the runtime')
    })
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch, { install, checkPlutoRuntime })

    manager.setGameConfig(plutoConfigFor('pluto-host-not-owner', hostId, guestId))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('pluto-host-not-owner', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    expect(checkPlutoRuntime).not.toHaveBeenCalled()
    process.resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
  })

  it('fails closed when automatic installation resolution fails', async () => {
    const failure = new Error(
      'HyperShield is not installed correctly. Reinstall HyperShield and try again.',
    )
    const readInstall = vi.fn(async () => Promise.reject(failure))
    const launch = vi.fn()
    const { manager } = makeHarness(launch, { readInstall })
    const statuses: any[] = []
    const ended = vi.fn()
    manager.on('gameStatus', status => statuses.push(status))
    manager.on('gameProcessEnded', ended)
    vi.mocked(checkStarcraftPath).mockClear()
    verifyGame.mockClear()

    manager.setGameConfig(hyperionConfigFor('hyperion-missing-install'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-missing-install', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(readInstall).toHaveBeenCalledTimes(1))
    expect(readInstall).toHaveBeenCalledWith({ gameDataPath: '/games/StarCraft' })
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'error', extra: failure }))
    expect(ended).toHaveBeenCalledWith('hyperion-missing-install')
    expect(launch).not.toHaveBeenCalled()
    expect(checkStarcraftPath).not.toHaveBeenCalled()
    expect(verifyGame).not.toHaveBeenCalled()
  })

  it('rejects unsupported Rule 3 without launching either backend', async () => {
    const launch = vi.fn()
    const { manager } = makeHarness(launch)
    const statuses: any[] = []
    manager.on('gameStatus', status => statuses.push(status))
    const config = hyperionConfigFor('hyperion-rule-3')
    config.setup.matchmakingType = MatchmakingType.Hyperion1v1Rule3
    vi.mocked(checkStarcraftPath).mockClear()
    verifyGame.mockClear()

    manager.setGameConfig(config)
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-rule-3', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: 'error',
        extra: expect.objectContaining({ message: 'This HyperShield mode is not available.' }),
      }),
    )
    expect(launch).not.toHaveBeenCalled()
    expect(checkStarcraftPath).not.toHaveBeenCalled()
    expect(verifyGame).not.toHaveBeenCalled()
  })

  it('reuses the carried handoff on a same-ID relaunch without spawning twice for one process', async () => {
    const processes: Array<ReturnType<typeof launchResult>> = []
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      const process = launchResult(options)
      processes.push(process)
      return process.result
    })
    const { manager } = makeHarness(launch)
    manager.setGameConfig(hyperionConfigFor('hyperion-relaunch'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-relaunch', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    manager.setGameConfig(hyperionConfigFor('hyperion-relaunch'))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2))
    expect(processes[0].result.quit).toHaveBeenCalledTimes(1)

    processes[0].resolveExit(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(manager.getStatus()).not.toBeNull()
    expect(launch).toHaveBeenCalledTimes(2)

    processes[1].resolveExit(0)
    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
  })

  it('quits a process whose launch became stale while configuration was pending', async () => {
    let finishLaunch!: (result: any) => void
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn((options: HyperionLaunchOptions) => {
      process = launchResult(options)
      return new Promise<any>(resolve => {
        finishLaunch = resolve
      })
    })
    const { manager } = makeHarness(launch)
    const ended = vi.fn()
    manager.on('gameProcessEnded', ended)
    manager.setGameConfig(hyperionConfigFor('hyperion-stale'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-stale', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    manager.clearGameConfig('hyperion-stale')
    finishLaunch(process.result)
    await vi.waitFor(() => expect(process.result.quit).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('hyperion-stale'))
    expect(manager.getStatus()).toBeNull()
  })

  it('surfaces a launch rejection and emits the process-ended lifecycle event', async () => {
    const failure = new Error('sidecar spawn failed')
    const launch = vi.fn(async () => Promise.reject(failure))
    const { manager } = makeHarness(launch)
    const statuses: any[] = []
    const ended = vi.fn()
    manager.on('gameStatus', status => statuses.push(status))
    manager.on('gameProcessEnded', ended)
    manager.setGameConfig(hyperionConfigFor('hyperion-error'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-error', hyperionNetcodeFor(pubkey))

    await vi.waitFor(() => expect(manager.getStatus()).toBeNull())
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'error', extra: failure }))
    expect(ended).toHaveBeenCalledWith('hyperion-error')
  })

  it('preserves a native recording locally without SC:R upload or settings activity', async () => {
    const dataPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sb-native-replay-'))
    const replayDirectory = path.join(dataPath, 'maps', 'replays')
    await fsPromises.mkdir(replayDirectory, { recursive: true })
    await fsPromises.writeFile(path.join(replayDirectory, 'LastReplay.rep'), 'hxRS stale fixture')
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      await fsPromises.writeFile(path.join(replayDirectory, 'LastReplay.rep'), 'hxRS fixture')
      process = launchResult(options)
      return process.result
    })
    const { manager, scrSettings } = makeHarness(launch, {
      install: { ...install, dataPath },
    })
    const saved = vi.fn()
    const resend = vi.fn()
    manager.on('replaySaved', saved)
    manager.on('resendReplay', resend)
    try {
      manager.setGameConfig(hyperionConfigFor('native-recording'))
      const pubkey = manager.generateNetcodeV2SessionKeys()
      manager.setNetcodeV2Setup('native-recording', hyperionNetcodeFor(pubkey))
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
      process.resolveExit(0)

      const destination = path.join(replayDirectory, 'HyperShield-native-recording.rep')
      await vi.waitFor(() => expect(saved).toHaveBeenCalledWith('native-recording', destination))
      expect(await fsPromises.readFile(destination, 'utf8')).toBe('hxRS fixture')
      expect(resend).not.toHaveBeenCalled()
      expect(scrSettings.syncWithGameSettingsFile).not.toHaveBeenCalled()
    } finally {
      await fsPromises.rm(dataPath, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'predates the launch', stale: true, seed: 0x12345678, embeddedGameId: undefined },
    { name: 'has the wrong seed', stale: false, seed: 0x87654321, embeddedGameId: undefined },
    { name: 'has another game ID', stale: false, seed: 0x12345678, embeddedGameId: 'earlier-game' },
  ])('does not preserve a scratch recording that $name', async testCase => {
    const dataPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sb-native-stale-'))
    const replayDirectory = path.join(dataPath, 'maps', 'replays')
    await fsPromises.mkdir(replayDirectory, { recursive: true })
    const source = path.join(replayDirectory, 'LastReplay.rep')
    await fsPromises.writeFile(source, 'hxRS earlier fixture')
    if (testCase.stale) {
      await fsPromises.utimes(source, new Date('2020-01-01'), new Date('2020-01-01'))
    }
    let process!: ReturnType<typeof launchResult>
    const readReplayMetadata = vi.fn(async () => ({
      headerData: { startTime: testCase.seed },
      players: [],
      shieldBatteryData: testCase.embeddedGameId ? { gameId: testCase.embeddedGameId } : undefined,
    }))
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      await fsPromises.writeFile(source, 'hxRS mismatched fresh fixture')
      if (testCase.stale) {
        await fsPromises.utimes(source, new Date('2020-01-01'), new Date('2020-01-01'))
      }
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch, {
      install: { ...install, dataPath },
      readReplayMetadata,
    })
    const saved = vi.fn()
    manager.on('replaySaved', saved)
    try {
      manager.setGameConfig(hyperionConfigFor('native-new-game'))
      const pubkey = manager.generateNetcodeV2SessionKeys()
      manager.setNetcodeV2Setup('native-new-game', hyperionNetcodeFor(pubkey))
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
      expect(await fsPromises.readFile(source, 'utf8')).toBe('hxRS mismatched fresh fixture')
      process.resolveExit(0)
      await vi.waitFor(() => expect(manager.getStatus()).toBeNull())

      expect(readReplayMetadata.mock.calls).toEqual(testCase.stale ? [] : [[source]])
      expect(saved).not.toHaveBeenCalled()
      await expect(
        fsPromises.stat(path.join(replayDirectory, 'HyperShield-native-new-game.rep')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        fsPromises.stat(path.join(replayDirectory, 'HyperShield-native-new-game.hyperion.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fsPromises.rm(dataPath, { recursive: true, force: true })
    }
  })

  it('uses the default native data path for scratch cleanup and replay persistence', async () => {
    const userDataPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sb-native-default-'))
    const dataPath = path.join(userDataPath, 'hyperion')
    const replayDirectory = path.join(dataPath, 'maps', 'replays')
    await fsPromises.mkdir(replayDirectory, { recursive: true })
    const source = path.join(replayDirectory, 'LastReplay.rep')
    await fsPromises.writeFile(source, 'hxRS stale fixture')
    electronApp.getPath.mockReturnValue(userDataPath)
    vi.stubEnv('SB_SESSION', '')

    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch)
    const saved = vi.fn()
    manager.on('replaySaved', saved)
    try {
      manager.setGameConfig(hyperionConfigFor('native-default-path'))
      const pubkey = manager.generateNetcodeV2SessionKeys()
      manager.setNetcodeV2Setup('native-default-path', hyperionNetcodeFor(pubkey))
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

      expect(electronApp.getPath).toHaveBeenCalledWith('userData')
      await expect(fsPromises.stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
      await fsPromises.writeFile(source, 'hxRS fresh fixture')
      process.resolveExit(0)

      const destination = path.join(replayDirectory, 'HyperShield-native-default-path.rep')
      await vi.waitFor(() => expect(saved).toHaveBeenCalledWith('native-default-path', destination))
      expect(await fsPromises.readFile(destination, 'utf8')).toBe('hxRS fresh fixture')
    } finally {
      electronApp.getPath.mockReturnValue('/fake-user-data')
      vi.unstubAllEnvs()
      await fsPromises.rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('preserves a native Classic reRS recording with its Hyperion sidecar', async () => {
    const dataPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sb-native-classic-'))
    const replayDirectory = path.join(dataPath, 'maps', 'replays')
    await fsPromises.mkdir(replayDirectory, { recursive: true })
    await fsPromises.writeFile(path.join(replayDirectory, 'LastReplay.rep'), 'reRS stale fixture')
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      await fsPromises.writeFile(path.join(replayDirectory, 'LastReplay.rep'), 'reRS fixture')
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch, {
      install: { ...install, dataPath },
    })
    const saved = vi.fn()
    manager.on('replaySaved', saved)
    try {
      manager.setGameConfig(withResolvedHyperion(hyperionConfigFor('native-classic-recording')))
      const pubkey = manager.generateNetcodeV2SessionKeys()
      manager.setNetcodeV2Setup('native-classic-recording', hyperionNetcodeFor(pubkey))
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
      process.resolveExit(0)

      const destination = path.join(replayDirectory, 'HyperShield-native-classic-recording.rep')
      await vi.waitFor(() =>
        expect(saved).toHaveBeenCalledWith('native-classic-recording', destination),
      )
      expect(await fsPromises.readFile(destination, 'utf8')).toBe('reRS fixture')
      const sidecar = JSON.parse(
        await fsPromises.readFile(destination.replace(/\.rep$/i, '.hyperion.json'), 'utf8'),
      )
      expect(sidecar).toMatchObject({
        version: 1,
        gameId: 'native-classic-recording',
        backend: GameplayBackend.Hyperion,
        replay: { format: 'scr', playbackBackend: GameplayBackend.Hyperion },
        rules: { ruleSet: 'classic' },
        seed: 0x12345678,
      })
      expect(sidecar).not.toHaveProperty('resultCode')
    } finally {
      await fsPromises.rm(dataPath, { recursive: true, force: true })
    }
  })

  it.each(['missing', 'malformed'])(
    'repairs a %s sidecar for an existing native Classic recording',
    async sidecarState => {
      const dataPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sb-native-existing-'))
      const replayDirectory = path.join(dataPath, 'maps', 'replays')
      await fsPromises.mkdir(replayDirectory, { recursive: true })
      const gameId = `native-classic-existing-${sidecarState}`
      const destination = path.join(replayDirectory, `HyperShield-${gameId}.rep`)
      await fsPromises.writeFile(destination, 'reRS existing')
      if (sidecarState === 'malformed') {
        await fsPromises.writeFile(destination.replace(/\.rep$/i, '.hyperion.json'), '{not json')
      }

      let process!: ReturnType<typeof launchResult>
      const launch = vi.fn(async (options: HyperionLaunchOptions) => {
        process = launchResult(options)
        return process.result
      })
      const { manager } = makeHarness(launch, { install: { ...install, dataPath } })
      const saved = vi.fn()
      manager.on('replaySaved', saved)
      try {
        manager.setGameConfig(withResolvedHyperion(hyperionConfigFor(gameId)))
        const pubkey = manager.generateNetcodeV2SessionKeys()
        manager.setNetcodeV2Setup(gameId, hyperionNetcodeFor(pubkey))
        await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
        process.resolveExit(0)

        await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(gameId, destination))
        expect(await fsPromises.readFile(destination, 'utf8')).toBe('reRS existing')
        const sidecar = JSON.parse(
          await fsPromises.readFile(destination.replace(/\.rep$/i, '.hyperion.json'), 'utf8'),
        )
        expect(sidecar).toMatchObject({
          version: 1,
          gameId,
          replay: { format: 'scr', playbackBackend: GameplayBackend.Hyperion },
        })
      } finally {
        await fsPromises.rm(dataPath, { recursive: true, force: true })
      }
    },
  )

  it('terminates the participating native process on app shutdown', async () => {
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch)
    manager.setGameConfig(hyperionConfigFor('hyperion-shutdown'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-shutdown', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    let finishQuit!: () => void
    process.result.quit.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishQuit = resolve
        }),
    )

    const quitting = manager.quitAllGamesOnAppExit()
    expect(process.result.quit).toHaveBeenCalledTimes(1)
    expect(quitting).toHaveLength(1)

    let settled = false
    const observed = quitting[0].then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishQuit()
    await Promise.resolve()
    expect(settled).toBe(false)

    process.resolveExit(0)
    await observed
    expect(settled).toBe(true)
  })

  it('quits a native process that finishes launching after app shutdown begins', async () => {
    let process!: ReturnType<typeof launchResult>
    let completeLaunch!: (result: HyperionLaunchResult) => void
    const launch = vi.fn((options: HyperionLaunchOptions) => {
      process = launchResult(options)
      return new Promise<HyperionLaunchResult>(resolve => {
        completeLaunch = resolve
      })
    })
    const { manager } = makeHarness(launch)
    manager.setGameConfig(hyperionConfigFor('hyperion-launch-shutdown'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-launch-shutdown', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    const quitting = manager.quitAllGamesOnAppExit()
    expect(quitting).toHaveLength(1)
    expect(process.result.quit).not.toHaveBeenCalled()

    completeLaunch(process.result)
    await vi.waitFor(() => expect(process.result.quit).toHaveBeenCalledTimes(1))
    process.resolveExit(0)
    await quitting[0]
  })

  it('waits for a superseded native launch without commanding its replacement ID', async () => {
    let process!: ReturnType<typeof launchResult>
    let completeLaunch!: (result: HyperionLaunchResult) => void
    const launch = vi.fn((options: HyperionLaunchOptions) => {
      process = launchResult(options)
      return new Promise<HyperionLaunchResult>(resolve => {
        completeLaunch = resolve
      })
    })
    const { manager } = makeHarness(launch)
    const commands = vi.fn()
    manager.on('gameCommand', commands)
    manager.setGameConfig(hyperionConfigFor('hyperion-superseded-shutdown'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-superseded-shutdown', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    manager.clearGameConfig('hyperion-superseded-shutdown')
    commands.mockClear()
    const quitting = manager.quitAllGamesOnAppExit()
    expect(quitting).toHaveLength(1)
    expect(commands).not.toHaveBeenCalled()

    completeLaunch(process.result)
    await quitting[0]
    expect(process.result.quit).toHaveBeenCalledTimes(1)
  })

  it('waits for native replay preservation before app shutdown completes', async () => {
    const dataPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sb-native-shutdown-replay-'))
    const replayDirectory = path.join(dataPath, 'maps', 'replays')
    await fsPromises.mkdir(replayDirectory, { recursive: true })
    await fsPromises.writeFile(path.join(replayDirectory, 'LastReplay.rep'), 'hxRS stale fixture')
    let process!: ReturnType<typeof launchResult>
    const launch = vi.fn(async (options: HyperionLaunchOptions) => {
      await fsPromises.writeFile(path.join(replayDirectory, 'LastReplay.rep'), 'hxRS fixture')
      process = launchResult(options)
      return process.result
    })
    const { manager } = makeHarness(launch, { install: { ...install, dataPath } })
    manager.setGameConfig(hyperionConfigFor('hyperion-replay-shutdown'))
    const pubkey = manager.generateNetcodeV2SessionKeys()
    manager.setNetcodeV2Setup('hyperion-replay-shutdown', hyperionNetcodeFor(pubkey))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    let finishCopy!: () => void
    const copyFile = vi.spyOn(fsPromises, 'copyFile').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishCopy = resolve
        }),
    )
    try {
      const quitting = manager.quitAllGamesOnAppExit()
      process.resolveExit(0)
      await vi.waitFor(() => expect(copyFile).toHaveBeenCalledTimes(1))

      let settled = false
      const observed = quitting[0].then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      finishCopy()
      await observed
      expect(settled).toBe(true)
    } finally {
      copyFile.mockRestore()
      await fsPromises.rm(dataPath, { recursive: true, force: true })
    }
  })
})

describe('ActiveGameManager block list updates', () => {
  let manager: ActiveGameManager
  let commands: Array<[string, string, ...any[]]>
  let blockRequests: Array<[string, SbUserId, boolean]>

  beforeEach(() => {
    manager = makeManager()
    commands = []
    blockRequests = []
    manager.on('gameCommand', (gameId, command, ...args) => {
      commands.push([gameId, command, ...args])
    })
    manager.on('setUserBlocked', (gameId, userId, blocked) => {
      blockRequests.push([gameId, userId, blocked])
    })
  })

  it('forwards block list changes to the active game only', () => {
    manager.setBlockedUsers([makeSbUserId(5)])
    expect(commands).toEqual([])

    manager.setGameConfig(configFor('game-1'))
    manager.setBlockedUsers([makeSbUserId(5), makeSbUserId(6)])
    expect(commands).toContainEqual(['game-1', 'blockedUsers', [makeSbUserId(5), makeSbUserId(6)]])
  })

  it('relays in-game block requests and their failures for the active game only', () => {
    manager.setGameConfig(configFor('game-1'))

    manager.handleSetUserBlocked('game-0', makeSbUserId(5), true)
    manager.handleSetUserBlocked('game-1', makeSbUserId(6), true)
    expect(blockRequests).toEqual([['game-1', makeSbUserId(6), true]])

    const failure = { userId: makeSbUserId(6), blocked: true, reason: 'limitReached' as const }
    manager.blockRequestFailed('game-0', failure)
    manager.blockRequestFailed('game-1', failure)
    expect(commands.filter(([, command]) => command === 'blockRequestFailed')).toEqual([
      ['game-1', 'blockRequestFailed', failure],
    ])
  })

  it('relays in-game report requests and their results for the active game only', () => {
    const reportRequests: Array<[string, InGameReportRequest]> = []
    manager.on('reportPlayer', (gameId, request) => {
      reportRequests.push([gameId, request])
    })
    manager.setGameConfig(configFor('game-1'))

    const request = { userId: makeSbUserId(6), reason: 'griefing' as const, gameSeconds: 754 }
    manager.handleReportPlayer('game-0', request)
    manager.handleReportPlayer('game-1', request)
    expect(reportRequests).toEqual([['game-1', request]])

    const result = { userId: makeSbUserId(6), result: 'rateLimited' as const }
    manager.reportResult('game-0', result)
    manager.reportResult('game-1', result)
    expect(commands.filter(([, command]) => command === 'reportResult')).toEqual([
      ['game-1', 'reportResult', result],
    ])
  })
})

describe('ActiveGameManager watch-only games', () => {
  let manager: ActiveGameManager
  let localSettings: EventEmitter
  let scrSettings: { syncWithGameSettingsFile: ReturnType<typeof vi.fn> }
  let commands: Array<[string, string, ...any[]]>

  beforeEach(() => {
    ;({ manager, localSettings, scrSettings } = makeManagerWithSettings())
    commands = []
    manager.on('gameCommand', (gameId, command, ...args) => {
      commands.push([gameId, command, ...args])
    })
  })

  function setKeepReplays(keepReplaysAlongsideGames: boolean) {
    localSettings.emit('change', { keepReplaysAlongsideGames })
  }

  function quitsSentTo(gameId: string) {
    return commands.filter(([id, command]) => id === gameId && command === 'quit')
  }

  async function settingsSyncCount() {
    // The sync is started from a resolved promise, so let it run before counting.
    await Promise.resolve()
    await Promise.resolve()
    return scrSettings.syncWithGameSettingsFile.mock.calls.length
  }

  describe('with replays kept alongside other games', () => {
    beforeEach(() => setKeepReplays(true))

    it('keeps a replay running when a networked game launches', () => {
      expect(manager.setGameConfig(replayConfigFor('replay-1'))).toBe('replay-1')
      expect(manager.setGameConfig(configFor('game-1'))).toBe('game-1')

      expect(quitsSentTo('replay-1')).toEqual([])
      expect(manager.getStatus('replay-1')?.state).toBe('launching')
      expect(manager.getStatus()?.id).toBe('game-1')
    })

    it('launches a replay alongside a running networked game', () => {
      manager.setGameConfig(configFor('game-1'))
      manager.handleGameStart('game-1')
      expect(manager.setGameConfig(replayConfigFor('replay-1'))).toBe('replay-1')

      expect(commands).toEqual([])
      expect(manager.getStatus()).toMatchObject({ id: 'game-1', state: 'playing' })
      expect(manager.getStatus('replay-1')).toMatchObject({ state: 'launching', isReplay: true })
    })

    it('handles a replay exiting without disturbing the networked game', async () => {
      const statuses: Array<{ id: string; state: string }> = []
      manager.on('gameStatus', status => statuses.push(status))

      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.handleGameStart('replay-1')
      manager.setGameConfig(configFor('game-1'))
      manager.handleGameStart('game-1')
      statuses.length = 0

      manager.handleGameExit('replay-1', 0)

      expect(statuses).toEqual([expect.objectContaining({ id: 'replay-1', state: 'unknown' })])
      expect(manager.getStatus('replay-1')).toBeNull()
      expect(manager.getStatus()).toMatchObject({ id: 'game-1', state: 'playing' })
      expect(commands).toEqual([])
      // The networked game still runs, so the settings file isn't read back yet.
      expect(await settingsSyncCount()).toBe(0)

      manager.handleGameResult('game-1', {}, 1000)
      expect(manager.getStatus()?.state).toBe('hasResult')
      manager.handleGameExit('game-1', 0)
      expect(await settingsSyncCount()).toBe(1)
    })

    it('handles a networked game exiting while a replay keeps running', async () => {
      const resends: unknown[] = []
      manager.on('resendReplay', request => resends.push(request))

      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.handleGameStart('replay-1')
      const config = configFor('game-1')
      manager.setGameConfig({
        ...config,
        localUser: { id: makeSbUserId(1) },
        setup: { ...config.setup, resultCode: 'code' },
      } as unknown as GameLaunchConfig)
      manager.handleGameStart('game-1')
      manager.handleGameResult('game-1', {}, 1000, 'C:\\temp\\game-1.rep')
      manager.handleGameFinished('game-1')

      manager.handleGameExit('game-1', 0)

      expect(manager.getStatus()).toBeNull()
      expect(resends).toEqual([expect.objectContaining({ gameId: 'game-1' })])
      expect(manager.getStatus('replay-1')?.state).toBe('playing')
      expect(quitsSentTo('replay-1')).toEqual([])
      expect(await settingsSyncCount()).toBe(0)

      manager.handleGameExit('replay-1', 0)
      expect(await settingsSyncCount()).toBe(1)
    })

    it.each(['ReplayRejected', 'ReplaySeedMissing'])(
      'sends diagnostics instead of resending a replay the server rejected (%s)',
      code => {
        const resends: unknown[] = []
        const diagnostics: unknown[] = []
        manager.on('resendReplay', request => resends.push(request))
        manager.on('replayDiagnosticsRequested', request => diagnostics.push(request))

        const config = configFor('game-1')
        manager.setGameConfig({
          ...config,
          localUser: { id: makeSbUserId(1) },
          setup: { ...config.setup, resultCode: 'code' },
        } as unknown as GameLaunchConfig)
        manager.handleGameStart('game-1')
        manager.handleGameResult('game-1', {}, 1000, 'C:\\temp\\game-1.rep')
        manager.handleReplayRejected('game-1', code)
        // Requested only once the game exits, so the report carries its complete log.
        expect(diagnostics).toEqual([])
        manager.handleGameFinished('game-1')

        manager.handleGameExit('game-1', 0)

        expect(resends).toEqual([])
        expect(diagnostics).toEqual([
          { gameId: 'game-1', replayPath: 'C:\\temp\\game-1.rep', code },
        ])
      },
    )

    it('runs two replays at once', () => {
      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.setGameConfig(replayConfigFor('replay-2'))

      expect(commands).toEqual([])
      expect(manager.getStatus('replay-1')?.state).toBe('launching')
      expect(manager.getStatus('replay-2')?.state).toBe('launching')
    })

    it('still quits a previous networked game when another one launches', () => {
      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.setGameConfig(configFor('game-1'))
      manager.setGameConfig(configFor('game-2'))

      expect(commands).toEqual([['game-1', 'quit']])
      expect(manager.getStatus()?.id).toBe('game-2')
      expect(manager.getStatus('replay-1')?.state).toBe('launching')
    })

    it('configures a connecting replay instead of quitting it', () => {
      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.setGameConfig(configFor('game-1'))

      // Connecting goes on to read the local settings, which never resolve here; the status
      // update before that read is what tells a tracked game apart from an abandoned one.
      manager.handleGameConnected('replay-1').catch(() => {})

      expect(quitsSentTo('replay-1')).toEqual([])
      expect(manager.getStatus('replay-1')?.state).toBe('configuring')
    })

    it('sends block list changes to every game', () => {
      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.setGameConfig(configFor('game-1'))

      manager.setBlockedUsers([makeSbUserId(5)])

      expect(commands).toEqual([
        ['game-1', 'blockedUsers', [makeSbUserId(5)]],
        ['replay-1', 'blockedUsers', [makeSbUserId(5)]],
      ])
    })

    it('quits only the replays as the app exits', () => {
      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.setGameConfig(replayConfigFor('replay-2'))
      manager.setGameConfig(configFor('game-1'))

      manager.quitWatchOnlyGamesOnAppExit()

      expect(commands).toEqual([
        ['replay-1', 'quit'],
        ['replay-2', 'quit'],
      ])
    })
  })

  describe('with one game at a time', () => {
    beforeEach(() => setKeepReplays(false))

    it('quits a running replay when a networked game launches', () => {
      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.setGameConfig(configFor('game-1'))

      expect(commands).toEqual([['replay-1', 'quit']])
      expect(manager.getStatus('replay-1')).toBeNull()
      expect(manager.getStatus()?.id).toBe('game-1')
    })

    it('replaces a running replay with a new one', () => {
      manager.setGameConfig(replayConfigFor('replay-1'))
      manager.setGameConfig(replayConfigFor('replay-2'))

      expect(commands).toEqual([['replay-1', 'quit']])
      expect(manager.getStatus('replay-1')).toBeNull()
      expect(manager.getStatus('replay-2')?.state).toBe('launching')
    })

    it('refuses a replay while a networked game runs, without touching the game', () => {
      const statuses: unknown[] = []
      manager.setGameConfig(configFor('game-1'))
      manager.handleGameStart('game-1')
      manager.on('gameStatus', status => statuses.push(status))

      expect(manager.setGameConfig(replayConfigFor('replay-1'))).toBeNull()

      expect(commands).toEqual([])
      expect(statuses).toEqual([])
      expect(manager.getStatus('replay-1')).toBeNull()
      expect(manager.getStatus()).toMatchObject({ id: 'game-1', state: 'playing' })
    })
  })
})
