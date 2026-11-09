import { MatchmakingType } from '../../../common/matchmaking'
import { HyperionRuleConfiguration } from './native-protocol'

/** The complete native rule configuration for each server-owned ladder mode. */
export function hyperionRuleConfigurationForMatchmakingType(
  type: MatchmakingType | undefined,
): HyperionRuleConfiguration | undefined {
  switch (type) {
    case MatchmakingType.Hyperion1v1Rule1:
    case MatchmakingType.Hyperion2v2Rule1:
    case MatchmakingType.Hyperion3v3Rule1:
      return { ruleSet: 'hyperion', antiMeta: false }
    case MatchmakingType.Hyperion1v1Rule2:
    case MatchmakingType.Hyperion2v2Rule2:
    case MatchmakingType.Hyperion3v3Rule2:
      return { ruleSet: 'hyperion', antiMeta: true }
    default:
      return undefined
  }
}
