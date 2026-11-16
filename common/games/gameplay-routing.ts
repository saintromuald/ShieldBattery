// Routing contracts shared by game configuration, launch setup, and matchmaking capabilities.
// Keep this module independent of those consumers so their serialized types do not form cycles.

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
  'plutoComputer',
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
  platform: 'win32' | 'linux' | 'darwin'
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
