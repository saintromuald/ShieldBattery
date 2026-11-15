import { promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeFileSha256 } from '../../releases/storage'
import {
  installPlutoRuntime,
  isPlutoRuntimeInstalled,
  PLUTO_ARCHIVE_ASSET,
  PLUTO_PAYLOAD_SHA256,
  validatePlutoBridgeFile,
} from './pluto-runtime-installer'

vi.mock('../../logger', () => ({ default: { warning: vi.fn() } }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/unused/app',
    getPath: () => '/unused/user-data',
  },
}))

const ACTIVE_BRIDGE_PATH =
  process.env.PLUTO_ACCEPTANCE_BRIDGE ?? path.resolve('hyperion/Data/pluto/pluto-bridge.exe')
const LIVE_ACCEPTANCE_ROOT = process.env.PLUTO_ACCEPTANCE_TEMP ?? '/tmp/opencode'

// This suite is intentionally opt-in: it downloads the real 309,686,477-byte closed-source archive.
describe.runIf(process.env.RUN_PLUTO_LIVE_ACCEPTANCE === '1')(
  'Pluto runtime live acceptance',
  () => {
    let temporaryDirectory: string

    beforeEach(async () => {
      temporaryDirectory = await fs.mkdtemp(
        path.join(LIVE_ACCEPTANCE_ROOT, 'pluto-live-acceptance-'),
      )
    })

    afterEach(async () => {
      await fs.rm(temporaryDirectory, { recursive: true, force: true })
    })

    it(
      'downloads, verifies, and installs the official runtime with the active Hyperion bridge',
      { timeout: 900_000 },
      async () => {
        const dataPath = path.join(temporaryDirectory, 'data')
        const installPath = path.join(dataPath, 'pluto')
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
          // No cache or fixture transport: delegate to Node's real HTTPS fetch implementation.
          return globalThis.fetch(input, init)
        }

        await installPlutoRuntime({
          dataPath,
          installPath,
          activeBridgePath: ACTIVE_BRIDGE_PATH,
          clientVersion: 'live-acceptance',
          fetchImpl,
          onProgress: progress => {
            finalProgress = progress
          },
        })

        expect(requestedUrls).toEqual([PLUTO_ARCHIVE_ASSET.url])
        expect(new URL(requestedUrls[0]).protocol).toBe('https:')
        if (!finalProgress) {
          throw new Error('The completed download did not report final progress.')
        }
        expect(finalProgress).toMatchObject({
          bytesTransferred: PLUTO_ARCHIVE_ASSET.size,
          totalBytes: PLUTO_ARCHIVE_ASSET.size,
        })

        const payloadDigests: Record<string, string> = {}
        for (const [name, expected] of Object.entries(PLUTO_PAYLOAD_SHA256)) {
          const payloadPath = path.join(installPath, ...name.split('/'))
          const stat = await fs.lstat(payloadPath)
          expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true)
          payloadDigests[name] = await computeFileSha256(payloadPath)
          expect(payloadDigests[name]).toBe(expected)
        }

        const installedBridge = path.join(installPath, 'pluto-bridge.exe')
        await validatePlutoBridgeFile(installedBridge)
        expect(await computeFileSha256(installedBridge)).toBe(
          await computeFileSha256(ACTIVE_BRIDGE_PATH),
        )
        await fs.access(path.join(installPath, 'pluto', 'pluto_infer.exe'), fsConstants.X_OK)
        expect(await isPlutoRuntimeInstalled(installPath, PLUTO_PAYLOAD_SHA256, 'linux')).toBe(true)
        expect((await fs.readdir(dataPath)).sort()).toEqual(['pluto'])

        console.info(
          `Pluto live acceptance passed: ${PLUTO_ARCHIVE_ASSET.url}; ` +
            `${finalProgress.bytesTransferred} bytes; ` +
            `payload SHA-256 ${JSON.stringify(payloadDigests)}; ` +
            `bridge SHA-256 ${await computeFileSha256(installedBridge)}; ` +
            'inference X_OK=true; ready=true.',
        )
      },
    )
  },
)
