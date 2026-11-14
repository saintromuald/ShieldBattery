import { describe, expect, it } from 'vitest'
import { HyperionRolloutStage } from './games/backend'
import {
  canUseHyperionForOrdinaryLobbies,
  canUseHyperionForOrdinaryMatchmaking,
  ServerConfig,
} from './server-config'

const BASE_CONFIG: ServerConfig = {
  publicAssetsUrl: 'https://cdn.invalid/',
  graphqlOrigin: 'https://gql.invalid/',
}

describe('Hyperion ordinary-formation rollout gates', () => {
  it('keeps native-only ordinary formations disabled for old and canonical servers', () => {
    expect(canUseHyperionForOrdinaryMatchmaking(BASE_CONFIG)).toBe(false)
    expect(canUseHyperionForOrdinaryLobbies(BASE_CONFIG)).toBe(false)
    const canonical = { ...BASE_CONFIG, hyperionRollout: HyperionRolloutStage.Canonical }
    expect(canUseHyperionForOrdinaryMatchmaking(canonical)).toBe(false)
    expect(canUseHyperionForOrdinaryLobbies(canonical)).toBe(false)
  })

  it('enables matchmaking before custom lobbies', () => {
    const matchmaking = { ...BASE_CONFIG, hyperionRollout: HyperionRolloutStage.Matchmaking }
    expect(canUseHyperionForOrdinaryMatchmaking(matchmaking)).toBe(true)
    expect(canUseHyperionForOrdinaryLobbies(matchmaking)).toBe(false)

    const defaultStage = { ...BASE_CONFIG, hyperionRollout: HyperionRolloutStage.Default }
    expect(canUseHyperionForOrdinaryMatchmaking(defaultStage)).toBe(true)
    expect(canUseHyperionForOrdinaryLobbies(defaultStage)).toBe(true)
  })

  it('honors the independent Hyperion-first kill switch', () => {
    const disabled = {
      ...BASE_CONFIG,
      hyperionRollout: HyperionRolloutStage.Default,
      hyperionFirstEnabled: false,
    }
    expect(canUseHyperionForOrdinaryMatchmaking(disabled)).toBe(false)
    expect(canUseHyperionForOrdinaryLobbies(disabled)).toBe(false)
  })
})
