import { getMatchmakingModeInfo, MatchmakingType } from '../../common/matchmaking'
import { isScrBackendSupported } from '../starcraft/scr-backend'

/** Returns whether this client has a backend capable of launching the matchmaking mode. */
export function isMatchmakingTypeSupported(
  type: MatchmakingType,
  scrBackendSupported = isScrBackendSupported(),
): boolean {
  return scrBackendSupported || getMatchmakingModeInfo(type).variant === 'hyperion'
}
