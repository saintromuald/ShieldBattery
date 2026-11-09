import { describe, expect, it } from 'vitest'
import { APP_ENABLE_DISCORD_PRESENCE, APP_MODEL_ID, APP_UPDATE_URL } from './branding'

describe('HyperShield application identity', () => {
  it('uses an independent Windows application ID and update service', () => {
    expect(APP_MODEL_ID).toBe('gg.angelicgaming.hypershield')
    expect(APP_ENABLE_DISCORD_PRESENCE).toBe(false)

    const updateUrl = new URL(APP_UPDATE_URL)
    expect(updateUrl.protocol).toBe('https:')
    expect(updateUrl.hostname).toBe('angelicgaming-hypershield-files.nyc3.digitaloceanspaces.com')
    expect(updateUrl.pathname).toBe('/public/app/')
  })
})
