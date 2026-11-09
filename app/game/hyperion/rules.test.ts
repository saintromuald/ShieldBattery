import { describe, expect, it } from 'vitest'
import { MatchmakingType } from '../../../common/matchmaking'
import { hyperionRuleConfigurationForMatchmakingType } from './rules'

describe('hyperionRuleConfigurationForMatchmakingType', () => {
  it('maps every enabled Rule 1 format to Hyperion QoL without mutators', () => {
    for (const type of [
      MatchmakingType.Hyperion1v1Rule1,
      MatchmakingType.Hyperion2v2Rule1,
      MatchmakingType.Hyperion3v3Rule1,
    ]) {
      expect(hyperionRuleConfigurationForMatchmakingType(type)).toEqual({
        ruleSet: 'hyperion',
        antiMeta: false,
      })
    }
  })

  it('maps every enabled Rule 2 format to Hyperion QoL with only anti-meta enabled', () => {
    for (const type of [
      MatchmakingType.Hyperion1v1Rule2,
      MatchmakingType.Hyperion2v2Rule2,
      MatchmakingType.Hyperion3v3Rule2,
    ]) {
      expect(hyperionRuleConfigurationForMatchmakingType(type)).toEqual({
        ruleSet: 'hyperion',
        antiMeta: true,
      })
    }
  })

  it('does not provide a launch configuration for disabled or ordinary modes', () => {
    expect(
      hyperionRuleConfigurationForMatchmakingType(MatchmakingType.Hyperion1v1Rule3),
    ).toBeUndefined()
    expect(hyperionRuleConfigurationForMatchmakingType(MatchmakingType.Match1v1)).toBeUndefined()
    expect(hyperionRuleConfigurationForMatchmakingType(undefined)).toBeUndefined()
  })
})
