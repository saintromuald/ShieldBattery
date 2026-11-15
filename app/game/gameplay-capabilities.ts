import {
  CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL,
  ClientGameplayCapabilities,
  GameplayBackendPolicy,
  HYPERION_NATIVE_FEATURES,
  HyperionCapabilityProfile,
} from '../../common/games/backend'
import { checkShieldBatteryFiles } from '../check-shieldbattery-files'
import { checkStarcraftPath } from './check-starcraft-path'
import { readEmbeddedHyperionInstall } from './hyperion/install'
import { HyperionInstall } from './hyperion/launch'

export interface GameplayCapabilitySnapshot {
  capabilities: ClientGameplayCapabilities
  hyperionInstall?: HyperionInstall
}

export function hyperionProfileForInstall(
  install: HyperionInstall,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): HyperionCapabilityProfile {
  if (!install.executableSha256 || !/^[0-9a-f]{64}$/.test(install.executableSha256)) {
    throw new Error('The Hyperion installation has no executable identity')
  }
  if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') {
    throw new Error('Hyperion gameplay is not supported on this operating system')
  }
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error('Hyperion gameplay is not supported on this processor architecture')
  }
  if (platform === 'win32' && architecture !== 'x64') {
    throw new Error('Hyperion gameplay requires an x64 Windows installation')
  }
  if (platform === 'darwin' && architecture !== 'arm64') {
    throw new Error('Hyperion gameplay requires an ARM64 macOS installation')
  }
  const compatibility = install.compatibility
  return {
    adapterProtocol: compatibility.adapterProtocol,
    engineBuild: compatibility.engineBuild,
    simRevision: compatibility.simRevision,
    modId: compatibility.modId,
    modFingerprint: compatibility.modFingerprint,
    dataFingerprint: compatibility.dataFingerprint.toLowerCase(),
    features: [...HYPERION_NATIVE_FEATURES],
    platform,
    architecture,
    executableSha256: install.executableSha256,
  }
}

/** Probes each backend independently so neither data source proves the other backend healthy. */
export async function collectGameplayCapabilities({
  gameDataPath,
  readHyperion = readEmbeddedHyperionInstall,
  checkScr = checkStarcraftPath,
  checkScrDll = checkShieldBatteryFiles,
  platform = process.platform,
  architecture = process.arch,
}: {
  gameDataPath?: string
  readHyperion?: typeof readEmbeddedHyperionInstall
  checkScr?: typeof checkStarcraftPath
  checkScrDll?: typeof checkShieldBatteryFiles
  platform?: NodeJS.Platform
  architecture?: string
}): Promise<GameplayCapabilitySnapshot> {
  const [nativeResult, scrResult] = await Promise.all([
    readHyperion({ gameDataPath, platform, architecture }).then(
      install => ({ install }),
      () => ({ install: undefined }),
    ),
    (async () => {
      if (platform !== 'win32' || !gameDataPath) return false
      try {
        const [path, dll] = await Promise.all([checkScr(gameDataPath), checkScrDll()])
        return path.path && path.version && dll.every(([, available]) => available)
      } catch {
        return false
      }
    })(),
  ])

  let profile: HyperionCapabilityProfile | undefined
  try {
    profile = nativeResult.install
      ? hyperionProfileForInstall(nativeResult.install, platform, architecture)
      : undefined
  } catch {
    profile = undefined
  }

  return {
    capabilities: {
      protocol: CLIENT_GAMEPLAY_CAPABILITY_PROTOCOL,
      backendPolicy: GameplayBackendPolicy.HyperionFirst,
      hyperion: profile,
      scrAvailable: scrResult,
    },
    hyperionInstall: profile ? nativeResult.install : undefined,
  }
}
