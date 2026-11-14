import { getMatchmakingModeInfo, MatchmakingType } from '../../common/matchmaking'
import { HealthCheckOptions } from '../starcraft/health-checked'
import { isScrBackendSupported } from '../starcraft/scr-backend'

/** Returns whether this client has a backend capable of launching the matchmaking mode. */
export function isMatchmakingTypeSupported(
  type: MatchmakingType,
  scrBackendSupported = isScrBackendSupported(),
  hyperionSupported = false,
  ordinaryHyperionEnabled = false,
): boolean {
  return (
    scrBackendSupported ||
    getMatchmakingModeInfo(type).variant === 'hyperion' ||
    (hyperionSupported && ordinaryHyperionEnabled)
  )
}

/** Applies the same backend requirements to initial searches and Search Again. */
export function matchmakingHealthCheckOptions(
  types: Iterable<MatchmakingType>,
  scrBackendSupported: boolean,
  hyperionSupported: boolean,
  ordinaryHyperionEnabled: boolean,
): HealthCheckOptions {
  const selected = Array.from(types)
  const hasOrdinary = selected.some(type => getMatchmakingModeInfo(type).variant !== 'hyperion')
  const hasHyperionOnly = selected.some(type => getMatchmakingModeInfo(type).variant === 'hyperion')
  return {
    requiresScrBackend: () => (!ordinaryHyperionEnabled || !hyperionSupported) && hasOrdinary,
    requiresHyperionBackend: () =>
      (ordinaryHyperionEnabled && !scrBackendSupported) || hasHyperionOnly,
  }
}
