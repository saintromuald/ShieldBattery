import Joi from 'joi'
import {
  CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL,
  GameplayBackendPolicy,
  HYPERION_NATIVE_FEATURES,
} from '../../../common/games/backend'

const nativeFeatureSchema = Joi.string().valid(...HYPERION_NATIVE_FEATURES)

/** Wire validation for non-secret launch capabilities. Private keys, paths, and tokens are rejected. */
export const gameplayCapabilitiesSchema = Joi.object({
  protocol: Joi.number().valid(CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL).required(),
  backendPolicy: Joi.string()
    .valid(...Object.values(GameplayBackendPolicy))
    .required(),
  scrAvailable: Joi.boolean().required(),
  hyperion: Joi.object({
    adapterProtocol: Joi.number().integer().min(1).max(0xffff).required(),
    engineBuild: Joi.string().min(1).max(128).required(),
    simRevision: Joi.number().integer().min(0).max(0xffffffff).required(),
    modId: Joi.string().allow('').max(64).required(),
    modFingerprint: Joi.string().hex().length(40).required(),
    dataFingerprint: Joi.string().hex().length(8).required(),
    features: Joi.array().items(nativeFeatureSchema).unique().max(32).required(),
    platform: Joi.string().valid('win32', 'linux').required(),
    architecture: Joi.string().valid('x64', 'arm64').required(),
    executableSha256: Joi.string().hex().length(64).required(),
  })
    .custom((profile, helpers) => {
      if (profile.platform === 'win32' && profile.architecture !== 'x64') {
        return helpers.error('any.invalid')
      }
      return profile
    })
    .optional(),
}).unknown(false)
