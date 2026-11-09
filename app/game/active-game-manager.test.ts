import { EventEmitter } from 'node:events'
import { promises as fsPromises } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { HyperionInstall, HyperionLaunchOptions } from './hyperion/launch'

const { verifyGame, electronApp } = vi.hoisted(() => ({
  verifyGame: vi.fn<() => Promise<void>>(),
  electronApp: { getAppPath: () => 'C:\\fake-app', isPackaged: true },
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
    compatibility: {
      adapterProtocol: 1,
      engineBuild: 'hyperion-test-build',
      simRevision: 22,
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
        ...backend,
        launch,
      },
    )
    return { manager, mapStore }
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
    const { manager, mapStore } = makeHarness(launch)
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
