import { describe, expect, test } from 'vitest'
import { MatchmakingType } from '../matchmaking'
import {
  GameplayBackend,
  hasExactReplayMagic,
  historicalGameplayBackend,
  HYPERION_NATIVE_FEATURES,
  hyperionProfileCompatibility,
  launchGameplayBackend,
  rulesAreHyperionOnly,
} from './backend'
import { GameConfig, GameSource } from './configuration'
import { GameSetup } from './game-launch-config'
import { GameType } from './game-type'

function matchmakingConfig(type: MatchmakingType): GameConfig {
  return {
    gameSource: GameSource.Matchmaking,
    gameSourceExtra: { type },
    gameType: GameType.OneVsOne,
    gameSubType: 0,
    teams: [[], []],
  } as GameConfig
}

describe('historicalGameplayBackend', () => {
  test('interprets only legacy Hyperion variants as native', () => {
    expect(historicalGameplayBackend(matchmakingConfig(MatchmakingType.Hyperion1v1Rule1))).toBe(
      GameplayBackend.Hyperion,
    )
    expect(historicalGameplayBackend(matchmakingConfig(MatchmakingType.Match1v1))).toBe(
      GameplayBackend.Scr,
    )
  })

  test('uses a persisted explicit backend without rewriting the old record', () => {
    const config = matchmakingConfig(MatchmakingType.Match1v1)
    config.gameplay = { backend: GameplayBackend.Hyperion } as any
    expect(historicalGameplayBackend(config)).toBe(GameplayBackend.Hyperion)
    expect(config.gameplay).toEqual({ backend: GameplayBackend.Hyperion })
  })
})

describe('launchGameplayBackend', () => {
  test('retains old-server Hyperion variant behavior', () => {
    expect(
      launchGameplayBackend({ matchmakingType: MatchmakingType.Hyperion1v1Rule1, map: {} } as any),
    ).toBe(GameplayBackend.Hyperion)
  })

  test('lets explicit SC:R compatibility override a Hyperion matchmaking variant', () => {
    expect(
      launchGameplayBackend({
        matchmakingType: MatchmakingType.Hyperion1v1Rule1,
        map: {},
        gameplay: { backend: GameplayBackend.Scr },
      } as any),
    ).toBe(GameplayBackend.Scr)
  })

  test('selects hxRS playback from recording metadata, never the live-game default', () => {
    expect(
      launchGameplayBackend({
        map: {
          isReplay: true,
          path: '/replays/native.rep',
          replay: { format: 'hxRS', playbackBackend: GameplayBackend.Hyperion },
        },
      } as unknown as GameSetup),
    ).toBe(GameplayBackend.Hyperion)
  })

  test('keeps unmarked historical recordings on SC:R', () => {
    expect(
      launchGameplayBackend({
        matchmakingType: MatchmakingType.Hyperion1v1Rule1,
        map: { isReplay: true, path: '/replays/historical.rep' },
      } as any),
    ).toBe(GameplayBackend.Scr)
  })
})

test('normalizes native feature order for cross-seat comparison', () => {
  const profile = hyperionProfileCompatibility({
    adapterProtocol: 1,
    engineBuild: 'build',
    simRevision: 22,
    modId: 'bw',
    modFingerprint: 'a'.repeat(40),
    dataFingerprint: '1234abcd',
    features: [...HYPERION_NATIVE_FEATURES].reverse(),
    platform: 'linux',
    architecture: 'x64',
    executableSha256: 'b'.repeat(64),
  })
  expect(profile.features).toEqual([...profile.features].sort())
  expect(profile).not.toHaveProperty('executableSha256')
  expect(profile).not.toHaveProperty('platform')
})

test('validates exact native and Classic replay magic at either container offset', () => {
  const nativeHeader = Buffer.from([0x7f, 0xf9, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0])
  const classicHeader = Buffer.from([1, 2, 3, 4, 1, 0, 0, 0, 4, 0, 0, 0])
  expect(hasExactReplayMagic(Buffer.from('hxRS-data'), 'hxRS')).toBe(true)
  expect(hasExactReplayMagic(Buffer.concat([nativeHeader, Buffer.from('hxRS')]), 'hxRS')).toBe(true)
  expect(
    hasExactReplayMagic(
      Buffer.concat([Buffer.from([0x7f, 0xf9, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0]), Buffer.from('hxRS')]),
      'hxRS',
    ),
  ).toBe(false)
  expect(hasExactReplayMagic(Buffer.from('reRS-data'), 'scr')).toBe(true)
  expect(hasExactReplayMagic(Buffer.concat([classicHeader, Buffer.from('reRS')]), 'scr')).toBe(true)
  expect(hasExactReplayMagic(Buffer.from('not a replay'), 'scr')).toBe(false)
  expect(hasExactReplayMagic(Buffer.from('not a replayreRS'), 'scr')).toBe(false)
  expect(hasExactReplayMagic(Buffer.from('reRS-data'), 'hxRS')).toBe(false)
  expect(hasExactReplayMagic(Buffer.from('hxRS-data'), 'scr')).toBe(false)
})

test('distinguishes Hyperion-only rules from Classic semantics', () => {
  expect(rulesAreHyperionOnly({ ruleSet: 'classic' })).toBe(false)
  expect(rulesAreHyperionOnly({ ruleSet: 'hyperion' })).toBe(true)
  expect(rulesAreHyperionOnly({ ruleSet: 'hyperion', mutators: { antiMeta: 1 } })).toBe(true)
})
