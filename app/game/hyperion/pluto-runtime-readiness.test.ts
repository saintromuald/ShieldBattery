import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertPlutoRuntimeReady } from './pluto-runtime-readiness'
import { metalSharpWineAppPath, metalSharpWineExecutablePath } from './pluto-wine-runtime'

const HASHES: Readonly<Record<string, string>> = {
  'pluto.dll': '603fea2f77a4b652f29b832c2977cf5bc9d83bbcb927febd04499220020ce3bc',
  'pluto_infer.exe': '3f2814a51034b9817b396e52b38d30341ede506a2baedc7cbc11cb6ebcece2cc',
  'pluto_weights.bin': 'c53a559b4910777dc0e1c561c0d89d243091f465d8e9fc0f5f72e56597067d86',
}

describe('assertPlutoRuntimeReady', () => {
  let dataPath: string

  beforeEach(async () => {
    dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-pluto-readiness-'))
    const runtime = path.join(dataPath, 'pluto')
    await fs.mkdir(path.join(runtime, 'pluto'), { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(runtime, 'pluto.dll'), 'dll'),
      fs.writeFile(path.join(runtime, 'pluto', 'pluto_infer.exe'), 'inference'),
      fs.writeFile(path.join(runtime, 'pluto', 'pluto_weights.bin'), 'weights'),
      fs.writeFile(path.join(runtime, 'pluto-bridge.exe'), 'bridge'),
    ])
  })

  afterEach(async () => {
    await fs.rm(dataPath, { recursive: true, force: true })
  })

  it('verifies the official payloads and bridge locally', async () => {
    const hashFile = vi.fn(async (filePath: string) => HASHES[path.basename(filePath)]!)

    await expect(assertPlutoRuntimeReady(dataPath, hashFile, 'win32')).resolves.toBeUndefined()
    expect(hashFile).toHaveBeenCalledTimes(3)
  })

  it('requires the app-managed Wine executable for Apple Silicon readiness', async () => {
    const hashFile = vi.fn(async (filePath: string) => HASHES[path.basename(filePath)]!)
    const homeDirectory = path.join(dataPath, 'home')

    await expect(
      assertPlutoRuntimeReady(dataPath, hashFile, 'darwin', homeDirectory),
    ).rejects.toThrow('Install or repair Pluto AI in Release Center')

    const winePath = metalSharpWineExecutablePath(metalSharpWineAppPath(homeDirectory))
    await fs.mkdir(path.dirname(winePath), { recursive: true })
    await fs.writeFile(winePath, 'wine', { mode: 0o755 })
    await expect(
      assertPlutoRuntimeReady(dataPath, hashFile, 'darwin', homeDirectory),
    ).resolves.toBeUndefined()
  })

  it('rejects a missing or modified owner payload with a useful setup error', async () => {
    const hashFile = vi.fn(async () => '0'.repeat(64))

    await expect(assertPlutoRuntimeReady(dataPath, hashFile, 'win32')).rejects.toThrow(
      'Install or repair Pluto AI in Release Center',
    )
  })
})
