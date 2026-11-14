import {
  ClientGameplayCapabilities,
  GAMEPLAY_ROUTING_PROTOCOL,
  GameplayBackend,
  GameplayBackendPolicy,
  GameplayBackendSelectionReason,
  GameplayRules,
  HyperionNativeFeature,
  hyperionProfileCompatibility,
  HyperionRolloutStage,
  ResolvedGameplayRouting,
  ResolvedHyperionProfile,
  rulesAreHyperionOnly,
  sameResolvedHyperionProfile,
} from '../../../common/games/backend'
import { GameConfig, GameSource } from '../../../common/games/configuration'
import { PlayerInfo } from '../../../common/games/game-launch-config'
import { GameType } from '../../../common/games/game-type'
import { SlotType } from '../../../common/lobbies/slot'
import { MapInfo } from '../../../common/maps'
import { getMatchmakingModeInfo, MatchmakingType } from '../../../common/matchmaking'
import { SbUserId } from '../../../common/users/sb-user-id'

export { HyperionRolloutStage } from '../../../common/games/backend'

export interface GameplaySelectionPolicy {
  stage: HyperionRolloutStage
  hyperionFirstEnabled: boolean
  compatibilityFallbackEnabled: boolean
  rollbackEnabled: boolean
}

/** Environment controls are read per formation so an operator can reverse a rollout without a rebuild. */
export function gameplaySelectionPolicyFromEnvironment(): GameplaySelectionPolicy {
  const stage = Object.values(HyperionRolloutStage).includes(
    process.env.SB_HYPERION_ROLLOUT as HyperionRolloutStage,
  )
    ? (process.env.SB_HYPERION_ROLLOUT as HyperionRolloutStage)
    : HyperionRolloutStage.Canonical
  return {
    stage,
    hyperionFirstEnabled: process.env.SB_HYPERION_FIRST_ENABLED !== 'false',
    compatibilityFallbackEnabled: process.env.SB_HYPERION_SCR_COMPATIBILITY_ENABLED !== 'false',
    rollbackEnabled: process.env.SB_RP2_ROLLBACK === 'true',
  }
}

export interface GameBackendParticipant {
  userId: SbUserId
  capabilities?: ClientGameplayCapabilities
}

export interface GameBackendSelectionInput {
  gameConfig: GameConfig
  players: ReadonlyArray<GameBackendParticipant>
  playerInfos: PlayerInfo[]
  map: MapInfo
  policy: GameplaySelectionPolicy
}

export class GameBackendSelectionError extends Error {
  constructor(
    readonly reason: GameplayBackendSelectionReason,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'GameBackendSelectionError'
  }
}

export function requestedGameplayRules(gameConfig: GameConfig): GameplayRules {
  if (gameConfig.gameSource === GameSource.Matchmaking) {
    switch (gameConfig.gameSourceExtra.type) {
      case MatchmakingType.Hyperion1v1Rule1:
      case MatchmakingType.Hyperion2v2Rule1:
      case MatchmakingType.Hyperion3v3Rule1:
        return { ruleSet: 'hyperion' }
      case MatchmakingType.Hyperion1v1Rule2:
      case MatchmakingType.Hyperion2v2Rule2:
      case MatchmakingType.Hyperion3v3Rule2:
        return { ruleSet: 'hyperion', mutators: { antiMeta: 1 } }
      case MatchmakingType.Hyperion1v1Rule3:
        throw new GameBackendSelectionError(
          GameplayBackendSelectionReason.HyperionOnly,
          'HyperShield Rule 3 is disabled',
          'disabledRule',
        )
      default:
        // Matchmaking rules are server-owned. A caller cannot turn a standard queue into Hyperion
        // QoL merely by supplying a requested-rules field.
        return { ruleSet: 'classic' }
    }
  }
  const requested = gameConfig.requestedRules ?? { ruleSet: 'classic' as const }
  return {
    ruleSet: requested.ruleSet,
    ...(requested.mutators ? { mutators: { ...requested.mutators } } : {}),
  }
}

function isHyperionMatchmaking(gameConfig: GameConfig): boolean {
  return (
    gameConfig.gameSource === GameSource.Matchmaking &&
    getMatchmakingModeInfo(gameConfig.gameSourceExtra.type).variant === 'hyperion'
  )
}

function validateRequestedRules(rules: GameplayRules): void {
  const mutators = Object.entries(rules.mutators ?? {})
  if (mutators.length === 0) return
  if (rules.ruleSet === 'hyperion' && mutators.length === 1 && mutators[0][0] === 'antiMeta') {
    if (mutators[0][1] === 1) return
  }
  throw new GameBackendSelectionError(
    GameplayBackendSelectionReason.HyperionOnly,
    'The requested rules or mutators are not supported by either gameplay backend',
    'unsupportedRules',
  )
}

function expectedPlayerCount(gameConfig: GameConfig): number | undefined {
  if (gameConfig.gameType === GameType.OneVsOne && gameConfig.gameSubType === 0) return 2
  if (gameConfig.gameType === GameType.TopVsBottom && gameConfig.gameSubType === 2) return 4
  if (gameConfig.gameType === GameType.TopVsBottom && gameConfig.gameSubType === 3) return 6
  return undefined
}

/** Returns the first native-envelope violation, or undefined when the formation is canonical. */
export function missingNativeFeature(
  input: Omit<GameBackendSelectionInput, 'policy'>,
): string | undefined {
  const { gameConfig, players, playerInfos, map } = input
  const expected = expectedPlayerCount(gameConfig)
  if (expected === undefined) return 'gameType'
  if (players.length <= 1) return 'localOnly'
  if ((gameConfig.observers?.length ?? 0) > 0) return 'observers'
  if (gameConfig.teams.some(team => team.some(player => player.isComputer))) return 'computers'
  if (playerInfos.length !== expected || players.length !== expected) return 'arbitrarySlots'
  if (playerInfos.some(player => player.type !== SlotType.Human || player.userId === undefined)) {
    return 'arbitrarySlots'
  }
  if (new Set(playerInfos.map(player => player.userId)).size !== expected) return 'arbitrarySlots'
  if (new Set(players.map(player => player.userId)).size !== expected) return 'arbitrarySlots'
  if (gameConfig.gameType === GameType.TopVsBottom) {
    if (gameConfig.lockedAlliances !== true) return 'unlockedAlliances'
    if (
      gameConfig.teams.length !== 2 ||
      gameConfig.teams.some(team => team.length !== gameConfig.gameSubType)
    ) {
      return 'teamLayout'
    }
  }
  if (gameConfig.gameSource === GameSource.Lobby) {
    if (gameConfig.gameSourceExtra?.useLegacyLimits) return 'legacyLimits'
    if (gameConfig.gameSourceExtra?.starcraftCompatibleReplays === false) {
      return 'starcraftCompatibleReplays'
    }
  }
  if (!/^[0-9a-f]{64}$/.test(map.hash) || !['scm', 'scx'].includes(map.mapData.format)) {
    return 'mapFormat'
  }
  if (map.mapData.isEud) return 'eudMap'

  if (gameConfig.gameType === GameType.TopVsBottom) {
    const hostUserId =
      gameConfig.gameSource === GameSource.Lobby
        ? gameConfig.gameSourceExtra?.host
        : playerInfos[0]?.userId
    const host = players.find(player => player.userId === hostUserId) ?? players[0]
    const ordered = [host, ...players.filter(player => player !== host)]
    const infoByUser = new Map(playerInfos.map(info => [info.userId, info]))
    const teamSize = gameConfig.gameSubType
    for (const [slot, player] of ordered.entries()) {
      const info = infoByUser.get(player.userId)
      if (!info || info.teamId !== Math.floor(slot / teamSize)) return 'canonicalHostTeamLayout'
    }
  }
  return undefined
}

function requestedPolicy(
  gameConfig: GameConfig,
  players: ReadonlyArray<GameBackendParticipant>,
): GameplayBackendPolicy {
  if (gameConfig.requestedBackendPolicy === GameplayBackendPolicy.ScrCompatibility) {
    return GameplayBackendPolicy.ScrCompatibility
  }
  if (
    players.length > 0 &&
    players.every(
      player => player.capabilities?.backendPolicy === GameplayBackendPolicy.ScrCompatibility,
    )
  ) {
    return GameplayBackendPolicy.ScrCompatibility
  }
  return GameplayBackendPolicy.HyperionFirst
}

function allScrAvailable(players: ReadonlyArray<GameBackendParticipant>): boolean {
  // A client with no capability record is a legacy SC:R client. New clients must explicitly report
  // SC:R availability; native game data alone never satisfies this contract.
  return players.every(player => player.capabilities?.scrAvailable ?? true)
}

function commonNativeProfile(
  players: ReadonlyArray<GameBackendParticipant>,
): ResolvedHyperionProfile | undefined {
  const first = players[0]?.capabilities?.hyperion
  if (!first) return undefined
  const resolved = hyperionProfileCompatibility(first)
  for (const player of players.slice(1)) {
    const profile = player.capabilities?.hyperion
    if (!profile || !sameResolvedHyperionProfile(resolved, hyperionProfileCompatibility(profile))) {
      return undefined
    }
  }
  return resolved
}

function nativeStageAllows(gameConfig: GameConfig, policy: GameplaySelectionPolicy): boolean {
  if (isHyperionMatchmaking(gameConfig)) return true
  if (!policy.hyperionFirstEnabled) return false
  if (gameConfig.gameSource === GameSource.Matchmaking) {
    return [HyperionRolloutStage.Matchmaking, HyperionRolloutStage.Default].includes(policy.stage)
  }
  return policy.stage === HyperionRolloutStage.Default
}

function requiredNativeFeatures(rules: GameplayRules): HyperionNativeFeature[] {
  return [
    'allHumanCanonicalTeams',
    'fastest',
    'lockstep',
    'netcodeV2',
    'verifiedScmScx',
    rules.ruleSet === 'classic' ? 'classicRules' : 'hyperionRules',
    ...(rules.mutators?.antiMeta === 1 ? (['antiMeta'] as const) : []),
  ]
}

function profileSupports(profile: ResolvedHyperionProfile, rules: GameplayRules): boolean {
  return requiredNativeFeatures(rules).every(feature => profile.features.includes(feature))
}

function scrRouting(
  input: GameBackendSelectionInput,
  reason: GameplayBackendSelectionReason,
  policy: GameplayBackendPolicy,
  rules: GameplayRules,
): ResolvedGameplayRouting {
  const localOnly = input.players.length <= 1
  return {
    version: GAMEPLAY_ROUTING_PROTOCOL,
    requestedPolicy: policy,
    backend: GameplayBackend.Scr,
    reason,
    rules,
    transport: localOnly ? 'localOnly' : 'netcodeV2',
    simulation:
      !localOnly &&
      input.policy.rollbackEnabled &&
      !(input.gameConfig.gameType === GameType.UseMapSettings && input.map.mapData.isEud)
        ? 'rollback'
        : 'lockstep',
    replay: { format: 'scr', playbackBackend: GameplayBackend.Scr },
  }
}

function requireScrFallback(
  input: GameBackendSelectionInput,
  reason: GameplayBackendSelectionReason,
  policy: GameplayBackendPolicy,
  rules: GameplayRules,
): ResolvedGameplayRouting {
  if (rulesAreHyperionOnly(rules)) {
    throw new GameBackendSelectionError(
      GameplayBackendSelectionReason.HyperionOnly,
      'This formation requires Hyperion and cannot use the SC:R compatibility backend',
      reason,
    )
  }
  if (!input.policy.compatibilityFallbackEnabled) {
    throw new GameBackendSelectionError(
      GameplayBackendSelectionReason.OperatorPolicy,
      'SC:R compatibility fallback is disabled by the server operator',
      reason,
    )
  }
  if (!allScrAvailable(input.players)) {
    throw new GameBackendSelectionError(
      GameplayBackendSelectionReason.ScrUnavailable,
      'At least one participant cannot use the required SC:R compatibility backend',
      reason,
    )
  }
  return scrRouting(input, reason, policy, rules)
}

/** Selects exactly one backend for a formation before registration or relay creation. */
export function selectGameBackend(input: GameBackendSelectionInput): ResolvedGameplayRouting {
  if (input.gameConfig.gameplay) return input.gameConfig.gameplay

  const rules = requestedGameplayRules(input.gameConfig)
  validateRequestedRules(rules)
  const policy = requestedPolicy(input.gameConfig, input.players)
  const hyperionOnly = isHyperionMatchmaking(input.gameConfig) || rulesAreHyperionOnly(rules)

  if (policy === GameplayBackendPolicy.ScrCompatibility) {
    return requireScrFallback(
      input,
      GameplayBackendSelectionReason.ExplicitCompatibility,
      policy,
      rules,
    )
  }

  const missingFeature = missingNativeFeature(input)
  if (missingFeature) {
    return requireScrFallback(
      input,
      GameplayBackendSelectionReason.MissingNativeFeature,
      policy,
      rules,
    )
  }

  const nativeProfile = commonNativeProfile(input.players)
  const nativeCompatible = !!nativeProfile && profileSupports(nativeProfile, rules)
  if (nativeStageAllows(input.gameConfig, input.policy) && nativeCompatible) {
    return nativeSelection(input, policy, rules, nativeProfile!, hyperionOnly)
  }

  if (!nativeCompatible) {
    return requireScrFallback(
      input,
      GameplayBackendSelectionReason.IncompatibleNativeProfile,
      policy,
      rules,
    )
  }
  const fallback = requireScrFallback(
    input,
    GameplayBackendSelectionReason.OperatorPolicy,
    policy,
    rules,
  )
  if (input.policy.stage === HyperionRolloutStage.Shadow && !hyperionOnly) {
    fallback.shadowBackend = GameplayBackend.Hyperion
  }
  return fallback
}

function nativeSelection(
  input: GameBackendSelectionInput,
  policy: GameplayBackendPolicy,
  rules: GameplayRules,
  nativeProfile: ResolvedHyperionProfile,
  hyperionOnly: boolean,
): ResolvedGameplayRouting {
  return {
    version: GAMEPLAY_ROUTING_PROTOCOL,
    requestedPolicy: policy,
    backend: GameplayBackend.Hyperion,
    reason: hyperionOnly
      ? GameplayBackendSelectionReason.HyperionOnly
      : GameplayBackendSelectionReason.Preferred,
    rules,
    nativeProfile,
    transport: 'netcodeV2',
    simulation: 'lockstep',
    replay:
      rules.ruleSet === 'classic'
        ? { format: 'scr', playbackBackend: GameplayBackend.Hyperion }
        : { format: 'hxRS', playbackBackend: GameplayBackend.Hyperion },
  }
}
