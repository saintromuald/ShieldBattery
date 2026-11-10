import { describe, expect, it } from 'vitest'
import { MatchmakingType } from '../../common/matchmaking'
import { isMatchmakingTypeSupported } from './matchmaking-platform'

describe('isMatchmakingTypeSupported', () => {
  it('supports every mode when the SC:R backend is available', () => {
    expect(isMatchmakingTypeSupported(MatchmakingType.Match1v1, true)).toBe(true)
    expect(isMatchmakingTypeSupported(MatchmakingType.Hyperion1v1Rule1, true)).toBe(true)
  })

  it('allows only Hyperion modes when the SC:R backend is unavailable', () => {
    expect(isMatchmakingTypeSupported(MatchmakingType.Match1v1, false)).toBe(false)
    expect(isMatchmakingTypeSupported(MatchmakingType.Match2v2, false)).toBe(false)
    expect(isMatchmakingTypeSupported(MatchmakingType.Hyperion1v1Rule1, false)).toBe(true)
    expect(isMatchmakingTypeSupported(MatchmakingType.Hyperion2v2Rule2, false)).toBe(true)
  })
})
