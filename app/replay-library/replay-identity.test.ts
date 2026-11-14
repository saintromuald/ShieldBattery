import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameplayBackend } from '../../common/games/backend'
import { detectReplayIdentity, parseReplayMetadata } from './replay-parser'

vi.mock('@shieldbattery/broodrep', () => ({
  init: vi.fn(),
  parseReplay: vi.fn(() => ({
    header: { startTime: 1 },
    players: () => [],
    getShieldBatterySection: () => undefined,
    free: vi.fn(),
  })),
}))

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true })))
})

async function recording(magic: string, sidecar?: unknown): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-replay-identity-'))
  directories.push(directory)
  const filePath = path.join(directory, 'HyperShield-game-id.rep')
  await fs.writeFile(filePath, `${magic} fixture`)
  if (sidecar !== undefined) {
    await fs.writeFile(
      filePath.replace(/\.rep$/i, '.hyperion.json'),
      typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar),
    )
  }
  return filePath
}

describe('detectReplayIdentity', () => {
  it('selects Hyperion for native Classic reRS with a matching sidecar', async () => {
    const filePath = await recording('reRS', {
      version: 1,
      backend: 'hyperion',
      replay: { format: 'scr', playbackBackend: 'hyperion' },
    })
    expect(await detectReplayIdentity(filePath)).toEqual({
      format: 'scr',
      playbackBackend: GameplayBackend.Hyperion,
    })
  })

  it('preserves the sidecar-aware identity through metadata parsing', async () => {
    const filePath = await recording('reRS', {
      version: 1,
      backend: 'hyperion',
      replay: { format: 'scr', playbackBackend: 'hyperion' },
    })
    const metadata = await parseReplayMetadata(filePath)
    expect(metadata.identity).toEqual({
      format: 'scr',
      playbackBackend: GameplayBackend.Hyperion,
    })
  })

  it('selects Hyperion for hxRS with a matching sidecar', async () => {
    const filePath = await recording('hxRS', {
      version: 1,
      backend: 'hyperion',
      replay: { format: 'hxRS', playbackBackend: 'hyperion' },
    })
    expect(await detectReplayIdentity(filePath)).toEqual({
      format: 'hxRS',
      playbackBackend: GameplayBackend.Hyperion,
    })
  })

  it('keeps unmarked and malformed reRS recordings on SC:R', async () => {
    expect(await detectReplayIdentity(await recording('reRS'))).toEqual({
      format: 'scr',
      playbackBackend: GameplayBackend.Scr,
    })
    expect(await detectReplayIdentity(await recording('reRS', '{not json'))).toEqual({
      format: 'scr',
      playbackBackend: GameplayBackend.Scr,
    })
    const contradictory = await recording('reRS', {
      version: 1,
      backend: 'hyperion',
      replay: { format: 'scr', playbackBackend: 'scr' },
    })
    expect(await detectReplayIdentity(contradictory)).toEqual({
      format: 'scr',
      playbackBackend: GameplayBackend.Scr,
    })
  })
})
