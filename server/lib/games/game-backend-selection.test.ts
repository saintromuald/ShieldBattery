import { describe, expect, test } from 'vitest'
import {
  ClientGameplayCapabilities,
  GameplayBackend,
  GameplayBackendPolicy,
  GameplayBackendSelectionReason,
  HYPERION_NATIVE_FEATURES,
  HyperionCapabilityProfile,
} from '../../../common/games/backend'
import { GameConfig, GameSource } from '../../../common/games/configuration'
import { PlayerInfo } from '../../../common/games/game-launch-config'
import { GameType } from '../../../common/games/game-type'
import { SlotType } from '../../../common/lobbies/slot'
import { makeSbMapId, MapInfo } from '../../../common/maps'
import {
  ALL_MATCHMAKING_TYPES,
  getMatchmakingModeInfo,
  MatchmakingType,
} from '../../../common/matchmaking'
import { makeSbUserId } from '../../../common/users/sb-user-id'
import {
  GameBackendSelectionError,
  GameBackendSelectionInput,
  GameplaySelectionPolicy,
  HyperionRolloutStage,
  missingNativeFeature,
  selectGameBackend,
} from './game-backend-selection'

const USERS = Array.from({ length: 6 }, (_, index) => makeSbUserId(index + 1))
const POLICY: GameplaySelectionPolicy = {
  stage: HyperionRolloutStage.Default,
  hyperionFirstEnabled: true,
  compatibilityFallbackEnabled: true,
  rollbackEnabled: false,
}
const MAP = {
  id: makeSbMapId('map'),
  hash: 'a'.repeat(64),
  mapData: { format: 'scm', isEud: false },
} as MapInfo

function nativeProfile(
  overrides: Partial<HyperionCapabilityProfile> = {},
): HyperionCapabilityProfile {
  return {
    adapterProtocol: 1,
    engineBuild: '0.7.1-beta+09603340',
    simRevision: 22,
    modId: 'bw',
    modFingerprint: 'a'.repeat(40),
    dataFingerprint: '1234abcd',
    features: [...HYPERION_NATIVE_FEATURES],
    platform: 'linux',
    architecture: 'x64',
    executableSha256: 'b'.repeat(64),
    ...overrides,
  }
}

function capabilities(
  overrides: Partial<ClientGameplayCapabilities> = {},
): ClientGameplayCapabilities {
  return {
    protocol: 1,
    backendPolicy: GameplayBackendPolicy.HyperionFirst,
    hyperion: nativeProfile(),
    scrAvailable: true,
    ...overrides,
  }
}

function matchmakingInput(type: MatchmakingType): GameBackendSelectionInput {
  const mode = getMatchmakingModeInfo(type)
  const players = USERS.slice(0, mode.teamSize * 2)
  const teams = Array.from({ length: 2 }, (_, teamId) =>
    players.slice(teamId * mode.teamSize, (teamId + 1) * mode.teamSize).map(id => ({
      id,
      race: 'r' as const,
      isComputer: false,
    })),
  )
  const solo = mode.teamSize === 1
  const playerInfos: PlayerInfo[] = players.map((userId, index) => ({
    id: `slot-${index}`,
    userId,
    race: 'r',
    playerId: 0,
    teamId: solo ? 0 : Math.floor(index / mode.teamSize),
    type: SlotType.Human,
    typeId: 6,
  }))
  return {
    gameConfig: {
      gameSource: GameSource.Matchmaking,
      gameSourceExtra:
        type === MatchmakingType.Match2v2 ? { type, parties: players.map(id => [id]) } : { type },
      gameType: solo ? GameType.OneVsOne : GameType.TopVsBottom,
      gameSubType: solo ? 0 : mode.teamSize,
      teams: solo ? [teams.flat()] : teams,
      lockedAlliances: true,
    } as GameConfig,
    players: players.map(userId => ({ userId, capabilities: capabilities() })),
    playerInfos,
    map: MAP,
    policy: POLICY,
  }
}

function lobbyInput(overrides: Partial<GameBackendSelectionInput> = {}): GameBackendSelectionInput {
  const base = matchmakingInput(MatchmakingType.Match1v1)
  return {
    ...base,
    gameConfig: {
      ...base.gameConfig,
      gameSource: GameSource.Lobby,
      gameSourceExtra: {
        host: USERS[0],
        useLegacyLimits: false,
        starcraftCompatibleReplays: true,
      },
      lockedAlliances: false,
    } as GameConfig,
    ...overrides,
  }
}

function expectSelectionError(input: GameBackendSelectionInput, detail?: string) {
  let thrown: unknown
  try {
    selectGameBackend(input)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(GameBackendSelectionError)
  expect(thrown).toMatchObject(detail === undefined ? {} : { detail })
  return thrown as GameBackendSelectionError
}

describe('selectGameBackend', () => {
  test.each(ALL_MATCHMAKING_TYPES.filter(type => !type.startsWith('hyperion')))(
    'prefers Hyperion with Classic rules for ordinary %s when canonical and compatible',
    type => {
      const routing = selectGameBackend(matchmakingInput(type))
      expect(routing).toMatchObject({
        backend: GameplayBackend.Hyperion,
        reason: GameplayBackendSelectionReason.Preferred,
        rules: { ruleSet: 'classic' },
        transport: 'netcodeV2',
        simulation: 'lockstep',
        replay: { format: 'scr', playbackBackend: GameplayBackend.Hyperion },
      })
    },
  )

  test.each([
    MatchmakingType.Hyperion1v1Rule1,
    MatchmakingType.Hyperion1v1Rule2,
    MatchmakingType.Hyperion2v2Rule1,
    MatchmakingType.Hyperion2v2Rule2,
    MatchmakingType.Hyperion3v3Rule1,
    MatchmakingType.Hyperion3v3Rule2,
  ])('keeps %s Hyperion-only with its exact rules', type => {
    const routing = selectGameBackend(matchmakingInput(type))
    expect(routing.backend).toBe(GameplayBackend.Hyperion)
    expect(routing.reason).toBe(GameplayBackendSelectionReason.HyperionOnly)
    expect(routing.rules).toEqual(
      type.endsWith('rule2')
        ? { ruleSet: 'hyperion', mutators: { antiMeta: 1 } }
        : { ruleSet: 'hyperion' },
    )
  })

  test('keeps Rule 3 disabled before registration', () => {
    expectSelectionError(matchmakingInput(MatchmakingType.Hyperion1v1Rule3), 'disabledRule')
  })

  test('does not let a standard queue request Hyperion QoL', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.gameConfig.requestedRules = { ruleSet: 'hyperion', mutators: { antiMeta: 1 } }
    expect(selectGameBackend(input).rules).toEqual({ ruleSet: 'classic' })
  })

  test('allows mixed Windows and Linux installs with the same simulation identity', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.players[1].capabilities = capabilities({
      hyperion: nativeProfile({
        platform: 'win32',
        executableSha256: 'c'.repeat(64),
      }),
    })
    expect(selectGameBackend(input).backend).toBe(GameplayBackend.Hyperion)
  })

  test.each([
    ['engineBuild', 'different-build'],
    ['simRevision', 23],
    ['adapterProtocol', 2],
    ['modFingerprint', 'b'.repeat(40)],
    ['dataFingerprint', 'deadbeef'],
  ] as const)('uses SC:R for an ordinary formation with mismatched %s', (field, value) => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.players[1].capabilities = capabilities({
      hyperion: nativeProfile({ [field]: value }),
    })
    expect(selectGameBackend(input)).toMatchObject({
      backend: GameplayBackend.Scr,
      reason: GameplayBackendSelectionReason.IncompatibleNativeProfile,
    })
  })

  test('rejects Hyperion-only rules on a profile mismatch instead of changing gameplay', () => {
    const input = matchmakingInput(MatchmakingType.Hyperion1v1Rule2)
    input.players[1].capabilities = capabilities({
      hyperion: nativeProfile({ dataFingerprint: 'deadbeef' }),
    })
    expect(expectSelectionError(input).reason).toBe(GameplayBackendSelectionReason.HyperionOnly)
  })

  test('honors whole-formation explicit SC:R compatibility', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.players = input.players.map(player => ({
      ...player,
      capabilities: capabilities({ backendPolicy: GameplayBackendPolicy.ScrCompatibility }),
    }))
    expect(selectGameBackend(input)).toMatchObject({
      backend: GameplayBackend.Scr,
      requestedPolicy: GameplayBackendPolicy.ScrCompatibility,
      reason: GameplayBackendSelectionReason.ExplicitCompatibility,
      rules: { ruleSet: 'classic' },
    })
  })

  test('rejects explicit SC:R compatibility for Hyperion-only rules', () => {
    const input = matchmakingInput(MatchmakingType.Hyperion1v1Rule1)
    input.gameConfig.requestedBackendPolicy = GameplayBackendPolicy.ScrCompatibility
    expect(expectSelectionError(input).reason).toBe(GameplayBackendSelectionReason.HyperionOnly)
  })

  test('treats missing capabilities as a legacy SC:R client for ordinary games', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.players[1].capabilities = undefined
    expect(selectGameBackend(input)).toMatchObject({
      backend: GameplayBackend.Scr,
      reason: GameplayBackendSelectionReason.IncompatibleNativeProfile,
    })
  })

  test('rejects a Hyperion-only formation for a legacy participant', () => {
    const input = matchmakingInput(MatchmakingType.Hyperion1v1Rule1)
    input.players[1].capabilities = undefined
    expect(expectSelectionError(input).reason).toBe(GameplayBackendSelectionReason.HyperionOnly)
  })

  test('requires declared SC:R availability from new clients', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.players = input.players.map(player => ({
      ...player,
      capabilities: capabilities({ hyperion: undefined, scrAvailable: false }),
    }))
    expect(expectSelectionError(input).reason).toBe(GameplayBackendSelectionReason.ScrUnavailable)
  })

  test('uses SC:R local-only transport for a lone human', () => {
    const input = lobbyInput()
    input.players = input.players.slice(0, 1)
    input.playerInfos = input.playerInfos.slice(0, 1)
    input.gameConfig.teams = [[{ id: USERS[0], race: 'r', isComputer: false }]]
    const routing = selectGameBackend(input)
    expect(routing).toMatchObject({
      backend: GameplayBackend.Scr,
      reason: GameplayBackendSelectionReason.MissingNativeFeature,
      transport: 'localOnly',
      simulation: 'lockstep',
    })
  })

  test('keeps Hyperion lockstep even when rollback is enabled globally', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.policy = { ...POLICY, rollbackEnabled: true }
    expect(selectGameBackend(input).simulation).toBe('lockstep')
  })

  test('marks an eligible SC:R networked formation as rollback', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.policy = { ...POLICY, rollbackEnabled: true }
    input.players[1].capabilities = undefined
    expect(selectGameBackend(input).simulation).toBe('rollback')
  })

  test.each([
    ['UMS', GameType.UseMapSettings, 2, 'gameType'],
    ['Melee', GameType.Melee, 2, 'gameType'],
    ['FFA', GameType.FreeForAll, 2, 'gameType'],
    ['Team Melee', GameType.TeamMelee, 2, 'gameType'],
    ['Team FFA', GameType.TeamFreeForAll, 2, 'gameType'],
    ['unsupported team size', GameType.TopVsBottom, 4, 'gameType'],
  ] as const)('routes %s to SC:R before launch', (_name, gameType, gameSubType, detail) => {
    const input = lobbyInput()
    input.gameConfig.gameType = gameType
    input.gameConfig.gameSubType = gameSubType
    const routing = selectGameBackend(input)
    expect(routing.backend).toBe(GameplayBackend.Scr)
    expect(routing.reason).toBe(GameplayBackendSelectionReason.MissingNativeFeature)
    expect(missingDetail(input)).toBe(detail)
  })

  test.each([
    [
      'computers',
      (input: GameBackendSelectionInput) => {
        input.gameConfig.teams[0][0].isComputer = true
      },
      'computers',
    ],
    [
      'observers',
      (input: GameBackendSelectionInput) => {
        input.gameConfig.observers = [makeSbUserId(99)]
      },
      'observers',
    ],
    [
      'open slots',
      (input: GameBackendSelectionInput) => {
        input.playerInfos[1] = { ...input.playerInfos[1], userId: undefined, type: SlotType.Open }
      },
      'arbitrarySlots',
    ],
    [
      'legacy limits',
      (input: GameBackendSelectionInput) => {
        ;(input.gameConfig as any).gameSourceExtra.useLegacyLimits = true
      },
      'legacyLimits',
    ],
    [
      'SC:R replay fixes',
      (input: GameBackendSelectionInput) => {
        ;(input.gameConfig as any).gameSourceExtra.starcraftCompatibleReplays = false
      },
      'starcraftCompatibleReplays',
    ],
    [
      'EUD maps',
      (input: GameBackendSelectionInput) => {
        input.map = { ...MAP, mapData: { ...MAP.mapData, isEud: true } }
      },
      'eudMap',
    ],
  ] as const)('routes %s to SC:R without partially translating it', (_name, mutate, detail) => {
    const input = lobbyInput()
    mutate(input)
    expect(selectGameBackend(input).backend).toBe(GameplayBackend.Scr)
    expect(missingDetail(input)).toBe(detail)
  })

  test('routes unlocked team alliances to SC:R', () => {
    const input = matchmakingInput(MatchmakingType.Match2v2)
    input.gameConfig.gameSource = GameSource.Lobby
    input.gameConfig.gameSourceExtra = { host: USERS[0] } as any
    input.gameConfig.lockedAlliances = false
    expect(selectGameBackend(input).backend).toBe(GameplayBackend.Scr)
  })

  test('rejects Hyperion-only semantics when a native feature is absent', () => {
    const input = lobbyInput()
    input.gameConfig.requestedRules = { ruleSet: 'hyperion' }
    input.gameConfig.gameType = GameType.UseMapSettings
    expect(expectSelectionError(input).reason).toBe(GameplayBackendSelectionReason.HyperionOnly)
  })

  test('rejects unsupported custom mutators rather than dropping them', () => {
    const input = lobbyInput()
    input.gameConfig.requestedRules = {
      ruleSet: 'classic',
      mutators: { antiMeta: 1 },
    }
    expect(expectSelectionError(input).detail).toBe('unsupportedRules')
  })

  test('routes a noncanonical host/team roster to SC:R before relay creation', () => {
    const input = matchmakingInput(MatchmakingType.Match2v2)
    input.gameConfig.gameSource = GameSource.Lobby
    input.gameConfig.gameSourceExtra = { host: USERS[2] } as any
    const routing = selectGameBackend(input)
    expect(routing.backend).toBe(GameplayBackend.Scr)
    expect(routing.reason).toBe(GameplayBackendSelectionReason.MissingNativeFeature)
  })

  test('shadow rollout records native eligibility while retaining SC:R launch', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.policy = { ...POLICY, stage: HyperionRolloutStage.Shadow }
    expect(selectGameBackend(input)).toMatchObject({
      backend: GameplayBackend.Scr,
      reason: GameplayBackendSelectionReason.OperatorPolicy,
      shadowBackend: GameplayBackend.Hyperion,
    })
  })

  test.each([
    [HyperionRolloutStage.Compatibility, GameSource.Matchmaking],
    [HyperionRolloutStage.Canonical, GameSource.Matchmaking],
    [HyperionRolloutStage.Matchmaking, GameSource.Lobby],
  ] as const)('stage %s retains SC:R for %s', (stage, source) => {
    const input =
      source === GameSource.Lobby ? lobbyInput() : matchmakingInput(MatchmakingType.Match1v1)
    input.policy = { ...POLICY, stage }
    expect(selectGameBackend(input)).toMatchObject({
      backend: GameplayBackend.Scr,
      reason: GameplayBackendSelectionReason.OperatorPolicy,
    })
  })

  test('Hyperion-branded modes remain native during compatibility rollout', () => {
    const input = matchmakingInput(MatchmakingType.Hyperion1v1Rule1)
    input.policy = { ...POLICY, stage: HyperionRolloutStage.Compatibility }
    expect(selectGameBackend(input).backend).toBe(GameplayBackend.Hyperion)
  })

  test('operator kill switches produce actionable failures when no backend is valid', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    input.policy = { ...POLICY, hyperionFirstEnabled: false, compatibilityFallbackEnabled: false }
    expect(expectSelectionError(input).reason).toBe(GameplayBackendSelectionReason.OperatorPolicy)
  })

  test('an existing resolved identity is immutable input to a retry', () => {
    const input = matchmakingInput(MatchmakingType.Match1v1)
    const resolved = selectGameBackend(input)
    input.gameConfig.gameplay = resolved
    input.players[1].capabilities = undefined
    expect(selectGameBackend(input)).toBe(resolved)
  })
})

function missingDetail(input: GameBackendSelectionInput): string | undefined {
  // Keep assertions on the public feature-matrix helper independent of the final fallback choice.
  return missingNativeFeature({
    gameConfig: input.gameConfig,
    players: input.players,
    playerInfos: input.playerInfos,
    map: input.map,
  })
}
