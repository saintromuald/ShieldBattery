import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerConfig } from '../common/server-config'

const CUSTOM_SAFE_CONFIG: ServerConfig = {
  publicAssetsUrl: 'http://192.168.40.253:5555/',
  graphqlOrigin: 'http://192.168.40.253:5556',
}

const UPSTREAM_CONFIG: ServerConfig = {
  publicAssetsUrl: 'https://cdn.shieldbattery.net/public/',
  graphqlOrigin: 'https://gql.shieldbattery.net/',
}

async function loadServerConfig(server: string) {
  vi.resetModules()
  window.SHIELDBATTERY_ELECTRON_API = { env: { SB_SERVER: server } } as any
  return import('./server-config-storage')
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.resetModules()
})

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  delete window.SHIELDBATTERY_ELECTRON_API
  vi.resetModules()
})

describe('custom Electron server config', () => {
  it('uses loopback-safe endpoints when no config is cached', async () => {
    const { getServerConfig } = await loadServerConfig('http://192.168.40.253:5555')

    expect(getServerConfig()).toEqual(CUSTOM_SAFE_CONFIG)
  })

  it('rejects cached ShieldBattery CDN and GraphQL endpoints', async () => {
    localStorage.setItem('http://192.168.40.253:5555~serverConfig', JSON.stringify(UPSTREAM_CONFIG))
    const { getServerConfig } = await loadServerConfig('http://192.168.40.253:5555')

    expect(getServerConfig()).toEqual(CUSTOM_SAFE_CONFIG)
  })

  it('replaces unsafe fresh configs instead of caching them', async () => {
    const { getServerConfig, setServerConfig } = await loadServerConfig('http://192.168.40.253:5555')

    setServerConfig(UPSTREAM_CONFIG)

    expect(getServerConfig()).toEqual(CUSTOM_SAFE_CONFIG)
    expect(JSON.parse(localStorage.getItem('http://192.168.40.253:5555~serverConfig')!)).toEqual(
      CUSTOM_SAFE_CONFIG,
    )

    setServerConfig({
      publicAssetsUrl: 'https://cdn.shieldbattery.net./public/',
      graphqlOrigin: 'https://gql.shieldbattery.net./',
    })
    expect(getServerConfig()).toEqual(CUSTOM_SAFE_CONFIG)
  })

  it('rejects malformed cached configs', async () => {
    localStorage.setItem(
      'http://192.168.40.253:5555~serverConfig',
      JSON.stringify({ publicAssetsUrl: '', graphqlOrigin: 'not a URL' }),
    )
    const { getServerConfig, setServerConfig } = await loadServerConfig('http://192.168.40.253:5555')

    expect(getServerConfig()).toEqual(CUSTOM_SAFE_CONFIG)
    const { makePublicAssetUrl } = await import('./network/server-url')
    expect(makePublicAssetUrl('/maps/test.png')).toBe('http://192.168.40.253:5555/maps/test.png')

    setServerConfig({ publicAssetsUrl: '', graphqlOrigin: '' })
    expect(getServerConfig()).toEqual(CUSTOM_SAFE_CONFIG)
  })

  it('namespaces credentials with the runtime server default', async () => {
    await loadServerConfig('http://192.168.40.253:5555')
    const { CREDENTIAL_STORAGE, CredentialStorageType } = await import('./network/fetch')

    CREDENTIAL_STORAGE.store('test-token', CredentialStorageType.Session)

    expect(sessionStorage.getItem('sbjwt|http://192.168.40.253:5555')).toBe('test-token')
    expect(sessionStorage.getItem('sbjwt')).toBeNull()
  })

  it('accepts non-ShieldBattery HTTP endpoints from the custom server', async () => {
    const customConfig: ServerConfig = {
      publicAssetsUrl: 'https://assets.hypershield.example/public/',
      graphqlOrigin: 'https://graphql.hypershield.example/',
    }
    const { getServerConfig, setServerConfig } = await loadServerConfig(
      'https://play.hypershield.example',
    )

    setServerConfig(customConfig)

    expect(getServerConfig()).toEqual(customConfig)
  })
})

describe('upstream Electron server config', () => {
  it.each(['https://shieldbattery.net', 'https://staging.shieldbattery.net'])(
    'preserves the existing fallback for %s',
    async server => {
      const { getServerConfig } = await loadServerConfig(server)

      expect(getServerConfig()).toEqual(UPSTREAM_CONFIG)
    },
  )

  it('continues to return upstream-provided configs unchanged', async () => {
    const config: ServerConfig = {
      publicAssetsUrl: 'https://assets.example.com/',
      graphqlOrigin: 'https://graphql.example.com/',
    }
    const { getServerConfig, setServerConfig } = await loadServerConfig(
      'https://shieldbattery.net/',
    )

    setServerConfig(config)

    expect(getServerConfig()).toEqual(config)
  })
})
