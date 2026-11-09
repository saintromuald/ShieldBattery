import { ServerConfig } from '../common/server-config'
import { JsonLocalStorageValue } from './local-storage'
import { baseUrl } from './network/server-base-url'

const UPSTREAM_FALLBACK_SERVER_CONFIG: ServerConfig = {
  publicAssetsUrl: 'https://cdn.shieldbattery.net/public/',
  graphqlOrigin: 'https://gql.shieldbattery.net/',
}

const CUSTOM_FALLBACK_SERVER_CONFIG: ServerConfig = {
  publicAssetsUrl: 'http://192.168.40.253:5555/',
  graphqlOrigin: 'http://192.168.40.253:5556',
}

const UPSTREAM_SERVER_ORIGINS: ReadonlySet<string> = new Set([
  'https://shieldbattery.net',
  'https://staging.shieldbattery.net',
])

function isUpstreamServer(serverUrl: unknown): boolean {
  if (typeof serverUrl !== 'string') {
    return false
  }

  try {
    return UPSTREAM_SERVER_ORIGINS.has(new URL(serverUrl).origin)
  } catch {
    return false
  }
}

const isCustomServer = IS_ELECTRON && !isUpstreamServer(baseUrl)
const fallbackServerConfig = isCustomServer
  ? CUSTOM_FALLBACK_SERVER_CONFIG
  : UPSTREAM_FALLBACK_SERVER_CONFIG

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false
  }

  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isShieldBatteryUrl(value: string): boolean {
  const hostname = new URL(value).hostname.replace(/\.+$/, '')
  return hostname === 'shieldbattery.net' || hostname.endsWith('.shieldbattery.net')
}

function isCustomSafeServerConfig(value: unknown): value is ServerConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { publicAssetsUrl, graphqlOrigin } = value as ServerConfig
  return (
    isHttpUrl(publicAssetsUrl) &&
    isHttpUrl(graphqlOrigin) &&
    !isShieldBatteryUrl(publicAssetsUrl) &&
    !isShieldBatteryUrl(graphqlOrigin)
  )
}

const localStorageKey = IS_ELECTRON ? `${baseUrl}~serverConfig` : 'serverConfig'
const serverConfig = new JsonLocalStorageValue<ServerConfig>(localStorageKey)

export function getFallbackServerConfig(): ServerConfig {
  return fallbackServerConfig
}

export function setServerConfig(config: ServerConfig) {
  serverConfig.setValue(
    isCustomServer && !isCustomSafeServerConfig(config) ? fallbackServerConfig : config,
  )
}

export function getServerConfig(): ServerConfig {
  const cachedConfig = serverConfig.getValue()
  if (isCustomServer && !isCustomSafeServerConfig(cachedConfig)) {
    return fallbackServerConfig
  }
  return cachedConfig ?? fallbackServerConfig
}
