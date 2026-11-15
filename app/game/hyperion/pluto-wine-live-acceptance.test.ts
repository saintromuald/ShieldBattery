import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUTO_MACOS_DOWNLOAD_BYTES } from '../../../common/pluto-runtime'
import { computeFileSha256 } from '../../releases/storage'
import {
  installPlutoRuntime,
  isPlutoRuntimeInstalled,
  PLUTO_ARCHIVE_ASSET,
  PLUTO_PAYLOAD_SHA256,
} from './pluto-runtime-installer'
import { assertPlutoRuntimeReady } from './pluto-runtime-readiness'
import {
  METALSHARP_WINE_ARCHIVE_ASSET,
  metalSharpWineAppPath,
  verifyMetalSharpWineApp,
} from './pluto-wine-runtime'

vi.mock('../../logger', () => ({ default: { warning: vi.fn() } }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/unused/app',
    getPath: () => '/unused/user-data',
  },
}))

const ACTIVE_BRIDGE_PATH =
  process.env.PLUTO_ACCEPTANCE_BRIDGE ?? path.resolve('hyperion/Data/pluto/pluto-bridge.exe')
const LIVE_ACCEPTANCE_ROOT = process.env.PLUTO_ACCEPTANCE_TEMP ?? os.tmpdir()

// This suite downloads the real 1,666,412,159 bytes of official dependencies and validates their
// signatures on macOS. It must never run as an incidental unit test.
describe.runIf(
  process.env.RUN_PLUTO_MAC_LIVE_ACCEPTANCE === '1' &&
    process.platform === 'darwin' &&
    process.arch === 'arm64',
)('Apple Silicon Pluto dependency live acceptance', () => {
  let temporaryDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(LIVE_ACCEPTANCE_ROOT, 'pluto-mac-live-'))
  })

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  })

  it(
    'installs signed Wine/FEX and official Pluto through the combined production action',
    { timeout: 1_800_000 },
    async () => {
      const dataPath = path.join(temporaryDirectory, 'data')
      const installPath = path.join(dataPath, 'pluto')
      const wineApp = metalSharpWineAppPath(temporaryDirectory)
      const requestedUrls: string[] = []
      let finalProgress:
        | { bytesTransferred: number; totalBytes: number; bytesPerSecond?: number }
        | undefined
      const fetchImpl: typeof globalThis.fetch = (input, init) => {
        let url: string
        if (typeof input === 'string') {
          url = input
        } else if (input instanceof URL) {
          url = input.href
        } else {
          url = input.url
        }
        requestedUrls.push(url)
        return globalThis.fetch(input, init)
      }

      await installPlutoRuntime({
        dataPath,
        installPath,
        activeBridgePath: ACTIVE_BRIDGE_PATH,
        clientVersion: 'mac-live-acceptance',
        fetchImpl,
        installMetalSharpWine: { destination: wineApp },
        onProgress: progress => {
          finalProgress = progress
        },
      })

      expect(requestedUrls).toEqual([METALSHARP_WINE_ARCHIVE_ASSET.url, PLUTO_ARCHIVE_ASSET.url])
      expect(finalProgress).toMatchObject({
        bytesTransferred: PLUTO_MACOS_DOWNLOAD_BYTES,
        totalBytes: PLUTO_MACOS_DOWNLOAD_BYTES,
      })
      await verifyMetalSharpWineApp(wineApp)
      expect(await isPlutoRuntimeInstalled(installPath, PLUTO_PAYLOAD_SHA256, 'darwin')).toBe(true)
      await assertPlutoRuntimeReady(dataPath, computeFileSha256, 'darwin', temporaryDirectory)
      expect((await fs.readdir(dataPath)).sort()).toEqual(['pluto'])
      expect((await fs.readdir(path.dirname(wineApp))).sort()).toEqual([path.basename(wineApp)])

      console.info(
        `Apple Silicon Pluto dependency acceptance passed: ${METALSHARP_WINE_ARCHIVE_ASSET.url}; ` +
          `${PLUTO_ARCHIVE_ASSET.url}; ${finalProgress?.bytesTransferred} bytes; ` +
          `Wine archive SHA-256 ${METALSHARP_WINE_ARCHIVE_ASSET.sha256}; ` +
          `Pluto archive SHA-256 ${PLUTO_ARCHIVE_ASSET.sha256}; ` +
          `bridge SHA-256 ${await computeFileSha256(path.join(installPath, 'pluto-bridge.exe'))}; ` +
          'signed app, provisioning profiles, entitlements, readiness, and cleanup verified.',
      )
    },
  )
})
