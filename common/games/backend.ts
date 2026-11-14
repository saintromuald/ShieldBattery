import { getMatchmakingModeInfo } from '../matchmaking'
import { GameConfig, GameSource } from './configuration'
import { GameSetup } from './game-launch-config'

export const GAMEPLAY_ROUTING_PROTOCOL = 1 as const
export const CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL = 1 as const

/** The executable selected by the server for every participant in one formation. */
export enum GameplayBackend {
  Hyperion = 'hyperion',
  Scr = 'scr',
}

/** The policy requested before participant capabilities and game features are considered. */
export enum GameplayBackendPolicy {
  HyperionFirst = 'hyperionFirst',
  ScrCompatibility = 'scrCompatibility',
}

export enum HyperionRolloutStage {
  /** Preserve ordinary SC:R routing while recording native-eligible selections. */
  Shadow = 'shadow',
  /** Preserve ordinary SC:R routing while backend-aware clients negotiate. */
  Compatibility = 'compatibility',
  /** Run only the pre-existing Hyperion-branded canonical modes natively. */
  Canonical = 'canonical',
  /** Prefer Hyperion for supported ordinary matchmaking as well. */
  Matchmaking = 'matchmaking',
  /** Prefer Hyperion for every supported live formation, including custom lobbies. */
  Default = 'default',
}

export enum GameplayBackendSelectionReason {
  Preferred = 'preferred',
  ExplicitCompatibility = 'explicitCompatibility',
  MissingNativeFeature = 'missingNativeFeature',
  IncompatibleNativeProfile = 'incompatibleNativeProfile',
  HyperionOnly = 'hyperionOnly',
  OperatorPolicy = 'operatorPolicy',
  ScrUnavailable = 'scrUnavailable',
}

export type GameplayRuleSet = 'classic' | 'hyperion'

export interface GameplayMutators {
  antiMeta?: 1
}

/** Exact gameplay semantics requested by a formation, independent of its backend. */
export interface GameplayRules {
  ruleSet: GameplayRuleSet
  mutators?: GameplayMutators
}

export type GameplayTransport = 'localOnly' | 'netcodeV2'
export type GameplaySimulationMode = 'lockstep' | 'rollback'
export type ReplayFormat = 'scr' | 'hxRS'

export interface ReplayIdentity {
  format: ReplayFormat
  playbackBackend: GameplayBackend
}

export const HYPERION_NATIVE_FEATURES = [
  'allHumanCanonicalTeams',
  'antiMeta',
  'classicRules',
  'fastest',
  'hyperionRules',
  'lockstep',
  'netcodeV2',
  'verifiedScmScx',
] as const

export type HyperionNativeFeature = (typeof HYPERION_NATIVE_FEATURES)[number]

/**
 * Non-secret native compatibility inputs advertised at queue/join time.
 *
 * Adapter protocol, engine build, simulation revision, and mod/data fingerprints must match across
 * a formation. Platform, architecture, and executable fingerprint identify the local install but
 * need not be identical in a supported mixed-OS session.
 */
export interface HyperionCapabilityProfile {
  adapterProtocol: number
  engineBuild: string
  simRevision: number
  modId: string
  modFingerprint: string
  dataFingerprint: string
  features: HyperionNativeFeature[]
  platform: 'win32' | 'linux'
  architecture: 'x64' | 'arm64'
  /** SHA-256 of the exact selected executable, used for local launch revalidation. */
  executableSha256: string
}

export interface ClientGameplayCapabilities {
  protocol: typeof CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL
  backendPolicy: GameplayBackendPolicy
  hyperion?: HyperionCapabilityProfile
  /** Whether this client can independently launch SC:R with the ShieldBattery DLL. */
  scrAvailable: boolean
}

/** The common native profile shared by every participant in a resolved Hyperion formation. */
export type ResolvedHyperionProfile = Omit<
  HyperionCapabilityProfile,
  'platform' | 'architecture' | 'executableSha256'
>

/** Server-owned, immutable backend and gameplay identity for one formation. */
export interface ResolvedGameplayRouting {
  version: typeof GAMEPLAY_ROUTING_PROTOCOL
  requestedPolicy: GameplayBackendPolicy
  backend: GameplayBackend
  reason: GameplayBackendSelectionReason
  rules: GameplayRules
  nativeProfile?: ResolvedHyperionProfile
  /** Set only for diagnostic shadow rollout; `backend` remains the actual launch backend. */
  shadowBackend?: GameplayBackend
  transport: GameplayTransport
  simulation: GameplaySimulationMode
  replay: ReplayIdentity
}

/**
 * Historical rows have no persisted routing object. Only the explicitly native matchmaking family
 * is interpreted as Hyperion; every other legacy record retains its SC:R meaning.
 */
export function historicalGameplayBackend(config: GameConfig): GameplayBackend {
  if (config.gameplay) {
    return config.gameplay.backend
  }
  if (
    config.gameSource === GameSource.Matchmaking &&
    getMatchmakingModeInfo(config.gameSourceExtra.type).variant === 'hyperion'
  ) {
    return GameplayBackend.Hyperion
  }
  return GameplayBackend.Scr
}

/** Resolves new-server routing while retaining the old-server launch behavior for old clients. */
export function launchGameplayBackend(setup: GameSetup): GameplayBackend {
  if (setup.gameplay) {
    return setup.gameplay.backend
  }
  if ('isReplay' in setup.map && setup.map.replay) {
    return setup.map.replay.playbackBackend
  }
  if (
    setup.matchmakingType !== undefined &&
    getMatchmakingModeInfo(setup.matchmakingType).variant === 'hyperion' &&
    !('isReplay' in setup.map)
  ) {
    return GameplayBackend.Hyperion
  }
  return GameplayBackend.Scr
}

export function hyperionProfileCompatibility(
  profile: HyperionCapabilityProfile,
): ResolvedHyperionProfile {
  return {
    adapterProtocol: profile.adapterProtocol,
    engineBuild: profile.engineBuild,
    simRevision: profile.simRevision,
    modId: profile.modId,
    modFingerprint: profile.modFingerprint,
    dataFingerprint: profile.dataFingerprint,
    features: [...new Set(profile.features)].sort(),
  }
}

export function sameResolvedHyperionProfile(
  a: ResolvedHyperionProfile,
  b: ResolvedHyperionProfile,
): boolean {
  return (
    a.adapterProtocol === b.adapterProtocol &&
    a.engineBuild === b.engineBuild &&
    a.simRevision === b.simRevision &&
    a.modId === b.modId &&
    a.modFingerprint === b.modFingerprint &&
    a.dataFingerprint === b.dataFingerprint &&
    a.features.length === b.features.length &&
    a.features.every((feature, index) => feature === b.features[index])
  )
}

export function rulesAreHyperionOnly(rules: GameplayRules): boolean {
  return rules.ruleSet === 'hyperion' || Object.keys(rules.mutators ?? {}).length > 0
}

/** Returns the native magic offset for the two replay container forms Hyperion writes. */
export function hyperionReplayMagicOffset(bytes: Uint8Array): 0 | 12 | undefined {
  const matches = (offset: number, magic: string) =>
    bytes.length >= offset + magic.length &&
    Array.from(magic).every((character, index) => bytes[offset + index] === magic.charCodeAt(index))
  const compressedDword = matches(4, '\x01\x00\x00\x00') && matches(8, '\x04\x00\x00\x00')
  if (matches(0, 'hxRS') || (compressedDword && matches(0, '\x7f\xf9') && matches(12, 'hxRS'))) {
    return matches(0, 'hxRS') ? 0 : 12
  }
  return undefined
}

export function replayIdentityForBytes(bytes: Uint8Array): ReplayIdentity {
  return hyperionReplayMagicOffset(bytes) !== undefined
    ? { format: 'hxRS', playbackBackend: GameplayBackend.Hyperion }
    : { format: 'scr', playbackBackend: GameplayBackend.Scr }
}

/** Checks exact recording magic instead of treating every unmarked file as legacy SC:R. */
export function hasExactReplayMagic(bytes: Uint8Array, format: ReplayFormat): boolean {
  const matches = (offset: number, magic: string) =>
    bytes.length >= offset + magic.length &&
    Array.from(magic).every((character, index) => bytes[offset + index] === magic.charCodeAt(index))
  // A compressed one-DWORD block stores its CRC, then nBlocks = 1 and nOut = 4 before the magic.
  const compressedDword = matches(4, '\x01\x00\x00\x00') && matches(8, '\x04\x00\x00\x00')
  return format === 'hxRS'
    ? hyperionReplayMagicOffset(bytes) !== undefined
    : matches(0, 'reRS') || (compressedDword && matches(12, 'reRS'))
}
