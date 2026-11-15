import { describe, expect, it } from 'vitest'
import {
  CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL,
  GameplayBackendPolicy,
  HYPERION_NATIVE_FEATURES,
} from '../../../common/games/backend'
import { gameplayCapabilitiesSchema } from './gameplay-capabilities-schema'

function capabilities(platform: 'darwin' | 'win32', architecture: 'x64' | 'arm64') {
  return {
    protocol: CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL,
    backendPolicy: GameplayBackendPolicy.HyperionFirst,
    scrAvailable: false,
    hyperion: {
      adapterProtocol: 1,
      engineBuild: 'hyperion-test',
      simRevision: 23,
      modId: 'bw',
      modFingerprint: 'b'.repeat(40),
      dataFingerprint: '0123abcd',
      features: [...HYPERION_NATIVE_FEATURES],
      platform,
      architecture,
      executableSha256: 'c'.repeat(64),
    },
  }
}

describe('gameplayCapabilitiesSchema platform profiles', () => {
  it('accepts Apple Silicon native capabilities without SC:R injection', () => {
    expect(
      gameplayCapabilitiesSchema.validate(capabilities('darwin', 'arm64')).error,
    ).toBeUndefined()
  })

  it('rejects unsupported processor combinations', () => {
    expect(gameplayCapabilitiesSchema.validate(capabilities('darwin', 'x64')).error).toBeDefined()
    expect(gameplayCapabilitiesSchema.validate(capabilities('win32', 'arm64')).error).toBeDefined()
  })
})
