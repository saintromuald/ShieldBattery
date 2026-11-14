import { register } from '@prometheus-io/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClientGameplayCapabilities,
  GameplayBackend,
  GameplayBackendPolicy,
  GameplayBackendSelectionReason,
  HYPERION_NATIVE_FEATURES,
} from '../../../common/games/backend'
import { GameConfig, GameSource } from '../../../common/games/configuration'
import { PlayerInfo } from '../../../common/games/game-launch-config'
import { GameType } from '../../../common/games/game-type'
import { SlotType } from '../../../common/lobbies/slot'
import { makeSbMapId, MapInfo } from '../../../common/maps'
import { MatchmakingType } from '../../../common/matchmaking'
import { makeSbUserId, SbUserId } from '../../../common/users/sb-user-id'
import { getMapInfos } from '../maps/map-models'
import { findUsersById } from '../users/user-model'
import { GameLoader, GameLoadErrorType, GameLoadPlayer } from './game-loader'
import { updateGameConfig } from './game-models'
import { registerGame } from './registration'

vi.mock('./registration', () => ({ registerGame: vi.fn() }))
vi.mock('./game-models', () => ({
  updateGameConfig: vi.fn().mockResolvedValue(undefined),
  cancelGame: vi.fn().mockResolvedValue(undefined),
  finalizeGameSetupCancellation: vi.fn().mockResolvedValue(true),
}))
vi.mock('../maps/map-models', () => ({ getMapInfos: vi.fn() }))
vi.mock('../users/user-model', () => ({ findUsersById: vi.fn() }))

const P1 = makeSbUserId(1)
const P2 = makeSbUserId(2)
const MAP_ID = makeSbMapId('canonical-map')
const MAP = {
  id: MAP_ID,
  hash: 'a'.repeat(64),
  name: 'Canonical',
  mapData: { format: 'scm', isEud: false },
} as MapInfo

function capabilities(
  overrides: Partial<ClientGameplayCapabilities> = {},
): ClientGameplayCapabilities {
  return {
    protocol: 1,
    backendPolicy: GameplayBackendPolicy.HyperionFirst,
    scrAvailable: true,
    hyperion: {
      adapterProtocol: 1,
      engineBuild: 'hyperion-test',
      simRevision: 22,
      modId: 'bw',
      modFingerprint: 'b'.repeat(40),
      dataFingerprint: '0123abcd',
      features: [...HYPERION_NATIVE_FEATURES],
      platform: 'linux',
      architecture: 'x64',
      executableSha256: 'c'.repeat(64),
    },
    ...overrides,
  }
}

function player(userId: SbUserId): GameLoadPlayer {
  return { userId, isObserver: false, capabilities: capabilities() }
}

function playerInfo(userId: SbUserId): PlayerInfo {
  return {
    id: `slot-${userId}`,
    userId,
    race: 'r',
    playerId: 0,
    teamId: 0,
    type: SlotType.Human,
    typeId: 6,
  }
}

function matchmakingConfig(type = MatchmakingType.Match1v1): GameConfig {
  return {
    gameSource: GameSource.Matchmaking,
    gameSourceExtra: { type },
    gameType: GameType.OneVsOne,
    gameSubType: 0,
    teams: [
      [
        { id: P1, race: 'r', isComputer: false },
        { id: P2, race: 'z', isComputer: false },
      ],
    ],
    lockedAlliances: true,
  } as GameConfig
}

async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve()
}

describe('GameLoader backend selection', () => {
  let loader: GameLoader
  let publisher: { publish: ReturnType<typeof vi.fn> }
  let createSession: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    register.clear()
    vi.stubEnv('SB_HYPERION_ROLLOUT', 'default')
    vi.stubEnv('SB_HYPERION_FIRST_ENABLED', 'true')
    vi.stubEnv('SB_HYPERION_SCR_COMPATIBILITY_ENABLED', 'true')
    vi.stubEnv('SB_RP2_ROLLBACK', 'true')
    vi.mocked(getMapInfos).mockResolvedValue([MAP])
    vi.mocked(findUsersById).mockResolvedValue([
      { id: P1, name: 'one', created: 0 },
      { id: P2, name: 'two', created: 0 },
    ])
    vi.mocked(registerGame).mockImplementation(
      async (_mapId, _config, _start, requestedGameId) => ({
        gameId: requestedGameId ?? 'game-id',
        resultCodes: new Map([
          [P1, 'code-1'],
          [P2, 'code-2'],
        ]),
      }),
    )
    vi.mocked(updateGameConfig).mockResolvedValue(undefined)

    publisher = { publish: vi.fn() }
    createSession = vi.fn().mockResolvedValue({
      session: 77,
      setups: new Map([
        [P1, {}],
        [P2, {}],
      ]),
    })
    const clients = new Map(
      [P1, P2].map(userId => [userId, { userId, subscribe: vi.fn(), unsubscribe: vi.fn() }]),
    )
    loader = new GameLoader(
      publisher as any,
      { getClientForUser: (userId: SbUserId) => clients.get(userId) } as any,
      { checkMultipleRestrictions: vi.fn().mockResolvedValue([]) } as any,
      {
        isEnabled: () => true,
        createSessionForGame: createSession,
        fetchSessionLoadState: vi.fn(),
      } as any,
      { setInGame: vi.fn() } as any,
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('persists and publishes Hyperion before creating a lockstep relay session', async () => {
    const load = loader.loadGame({
      gameId: 'native-game',
      players: [player(P1), player(P2)],
      playerInfos: [playerInfo(P1), playerInfo(P2)],
      mapId: MAP_ID,
      gameConfig: matchmakingConfig(),
    })
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))

    const registeredConfig = vi.mocked(registerGame).mock.calls[0][1]
    expect(registeredConfig.gameplay).toMatchObject({
      backend: GameplayBackend.Hyperion,
      reason: GameplayBackendSelectionReason.Preferred,
      rules: { ruleSet: 'classic' },
      simulation: 'lockstep',
    })
    expect(vi.mocked(updateGameConfig).mock.calls[0][1].gameplay).toEqual(registeredConfig.gameplay)
    expect(createSession.mock.calls[0][0].canRollBack).toBe(false)
    const setupEvents = publisher.publish.mock.calls.filter(
      call => call[1].type === 'setGameConfig',
    )
    expect(setupEvents).toHaveLength(2)
    for (const [, event] of setupEvents) {
      expect(event.setup.gameplay).toEqual(registeredConfig.gameplay)
      expect(event.setup.disableAllianceChanges).toBe(true)
    }

    loader.registerGameAsLoaded('native-game', P1)
    loader.registerGameAsLoaded('native-game', P2)
    expect((await load).isOk()).toBe(true)
  })

  it('rejects Hyperion-only capability mismatches before registration', async () => {
    const second = {
      ...player(P2),
      capabilities: capabilities({
        hyperion: { ...capabilities().hyperion!, engineBuild: 'incompatible' },
      }),
    }
    const result = await loader.loadGame({
      gameId: 'rejected-native-game',
      players: [player(P1), second],
      playerInfos: [playerInfo(P1), playerInfo(P2)],
      mapId: MAP_ID,
      gameConfig: matchmakingConfig(MatchmakingType.Hyperion1v1Rule2),
    })

    expect(result.isError()).toBe(true)
    expect(result.errorOrNull()).toMatchObject({
      code: GameLoadErrorType.BackendUnsupported,
      data: { reason: GameplayBackendSelectionReason.HyperionOnly },
    })
    expect(registerGame).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('uses the declared SC:R compatibility path for UMS without requesting rollback on EUD', async () => {
    vi.mocked(getMapInfos).mockResolvedValue([{ ...MAP, mapData: { ...MAP.mapData, isEud: true } }])
    const config = matchmakingConfig()
    config.gameType = GameType.UseMapSettings
    const load = loader.loadGame({
      gameId: 'ums-game',
      players: [player(P1), player(P2)],
      playerInfos: [playerInfo(P1), playerInfo(P2)],
      mapId: MAP_ID,
      gameConfig: config,
    })
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))

    expect(vi.mocked(registerGame).mock.calls[0][1].gameplay).toMatchObject({
      backend: GameplayBackend.Scr,
      reason: GameplayBackendSelectionReason.MissingNativeFeature,
      simulation: 'lockstep',
    })
    expect(createSession.mock.calls[0][0].canRollBack).toBe(false)
    loader.registerGameAsLoaded('ums-game', P1)
    loader.registerGameAsLoaded('ums-game', P2)
    expect((await load).isOk()).toBe(true)
  })

  it('rejects a same-ID retry whose native profile changed', async () => {
    const request = {
      gameId: 'idempotent-native-game',
      players: [player(P1), player(P2)],
      playerInfos: [playerInfo(P1), playerInfo(P2)],
      mapId: MAP_ID,
      gameConfig: matchmakingConfig(),
    }
    const first = loader.loadGame(request)
    await vi.waitFor(() => expect(registerGame).toHaveBeenCalledTimes(1))
    const changed = [
      player(P1),
      {
        ...player(P2),
        capabilities: capabilities({
          hyperion: { ...capabilities().hyperion!, dataFingerprint: 'deadbeef' },
        }),
      },
    ]
    const duplicate = await loader.loadGame({ ...request, players: changed })

    expect(duplicate.isError()).toBe(true)
    expect(duplicate.errorOrNull()?.code).toBe(GameLoadErrorType.Internal)
    expect(registerGame).toHaveBeenCalledTimes(1)
    loader.registerGameAsLoaded('idempotent-native-game', P1)
    loader.registerGameAsLoaded('idempotent-native-game', P2)
    expect((await first).isOk()).toBe(true)
  })

  it('fails closed before registration when no backend preserves the formation', async () => {
    const participants = [player(P1), player(P2)].map(p => ({
      ...p,
      capabilities: capabilities({ hyperion: undefined, scrAvailable: false }),
    }))
    const result = await loader.loadGame({
      gameId: 'no-backend-game',
      players: participants,
      playerInfos: [playerInfo(P1), playerInfo(P2)],
      mapId: MAP_ID,
      gameConfig: matchmakingConfig(),
    })

    expect(result.errorOrNull()).toMatchObject({
      code: GameLoadErrorType.BackendUnsupported,
      data: { reason: GameplayBackendSelectionReason.ScrUnavailable },
    })
    expect(registerGame).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    await flush()
  })
})
