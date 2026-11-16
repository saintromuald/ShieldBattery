import { getMatchmakingModeInfo } from '../matchmaking'
import { GameConfig, GameSource } from './configuration'
import { GameSetup } from './game-launch-config'
import {
  GameplayBackend,
  type GameplayRules,
  type HyperionCapabilityProfile,
  type ReplayFormat,
  type ReplayIdentity,
  type ResolvedHyperionProfile,
} from './gameplay-routing'

export * from './gameplay-routing'

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
