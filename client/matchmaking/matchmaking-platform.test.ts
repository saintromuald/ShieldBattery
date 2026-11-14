import { describe, expect, it } from 'vitest'
import { MatchmakingType } from '../../common/matchmaking'
import { isMatchmakingTypeSupported, matchmakingHealthCheckOptions } from './matchmaking-platform'

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

  it('keeps ordinary modes SC:R-gated before ordinary native rollout', () => {
    expect(isMatchmakingTypeSupported(MatchmakingType.Match1v1, false, true)).toBe(false)
    expect(isMatchmakingTypeSupported(MatchmakingType.Match2v2, false, true)).toBe(false)
    expect(isMatchmakingTypeSupported(MatchmakingType.Match3v3Fastest, false, true)).toBe(false)
  })

  it('allows ordinary canonical modes with native rollout and no SC:R', () => {
    expect(isMatchmakingTypeSupported(MatchmakingType.Match1v1, false, true, true)).toBe(true)
    expect(isMatchmakingTypeSupported(MatchmakingType.Match2v2, false, true, true)).toBe(true)
    expect(isMatchmakingTypeSupported(MatchmakingType.Match3v3Fastest, false, true, true)).toBe(
      true,
    )
  })
})

describe('matchmakingHealthCheckOptions', () => {
  it('requires SC:R for ordinary modes before native rollout even with healthy Hyperion', () => {
    const options = matchmakingHealthCheckOptions([MatchmakingType.Match1v1], false, true, false)
    expect(options.requiresScrBackend!()).toBe(true)
    expect(options.requiresHyperionBackend!()).toBe(false)
  })

  it('requires Hyperion for a native-only ordinary search when rollout enables it', () => {
    const options = matchmakingHealthCheckOptions([MatchmakingType.Match1v1], false, true, true)
    expect(options.requiresScrBackend!()).toBe(false)
    expect(options.requiresHyperionBackend!()).toBe(true)
  })

  it('always requires Hyperion for Hyperion-only variants', () => {
    const options = matchmakingHealthCheckOptions(
      [MatchmakingType.Hyperion1v1Rule1],
      true,
      true,
      false,
    )
    expect(options.requiresScrBackend!()).toBe(false)
    expect(options.requiresHyperionBackend!()).toBe(true)
  })
})
