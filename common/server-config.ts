import { HyperionRolloutStage } from './games/backend'

/**
 * Config that the client requests from the server when it launches in case of an Electron app, or
 * injected into the HTML document for the web version.
 */
export interface ServerConfig {
  /** URL to the server's public directory containing static content. */
  publicAssetsUrl: string
  /** Network origin for any GraphQL requests. */
  graphqlOrigin: string
  /** Public rollout stage used to avoid offering formations this server would route to SC:R. */
  hyperionRollout?: HyperionRolloutStage
  /** Independent Hyperion-first kill switch. Missing values retain the enabled default. */
  hyperionFirstEnabled?: boolean
}

/** Whether ordinary matchmaking may use Hyperion for a native-only participant. */
export function canUseHyperionForOrdinaryMatchmaking(config: ServerConfig): boolean {
  return (
    config.hyperionFirstEnabled !== false &&
    (config.hyperionRollout === HyperionRolloutStage.Matchmaking ||
      config.hyperionRollout === HyperionRolloutStage.Default)
  )
}

/** Whether an ordinary custom lobby may use Hyperion for a native-only participant. */
export function canUseHyperionForOrdinaryLobbies(config: ServerConfig): boolean {
  return (
    config.hyperionFirstEnabled !== false && config.hyperionRollout === HyperionRolloutStage.Default
  )
}
