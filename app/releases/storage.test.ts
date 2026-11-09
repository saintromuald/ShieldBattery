import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultReleasePreferences,
  readReleasePreferences,
  supportsReleaseInstallation,
  writeJsonAtomic,
  writeReleasePreferences,
} from './storage'

let temporaryDirectory: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-release-storage-test-'))
})

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

describe('release persistence', () => {
  it('limits Windows installs to x64 Hyperion and AppImages to Linux', () => {
    expect(supportsReleaseInstallation('hyperion', 'win32', 'x64')).toBe(true)
    expect(supportsReleaseInstallation('hyperion', 'win32', 'arm64')).toBe(false)
    expect(supportsReleaseInstallation('hypershield', 'win32', 'x64')).toBe(false)
    expect(supportsReleaseInstallation('hyperion', 'linux', 'arm64')).toBe(true)
    expect(supportsReleaseInstallation('hypershield', 'linux', 'x64')).toBe(true)
  })

  it('serializes concurrent snapshots for the same file and leaves no temporary files', async () => {
    const pathname = path.join(temporaryDirectory, 'state.json')
    await Promise.all(
      Array.from({ length: 20 }, (_, value) => writeJsonAtomic(pathname, { value })),
    )

    await expect(fs.readFile(pathname, 'utf8')).resolves.toBe(
      `${JSON.stringify({ value: 19 }, null, 2)}\n`,
    )
    await expect(fs.readdir(temporaryDirectory)).resolves.toEqual(['state.json'])
  })

  it('round-trips preferences and supplies stable defaults when no file exists', async () => {
    const userDataPath = path.join(temporaryDirectory, 'missing')
    await expect(readReleasePreferences(userDataPath)).resolves.toEqual(defaultReleasePreferences())

    const preferences = defaultReleasePreferences()
    preferences.hyperion.channel = 'prerelease'
    preferences.hyperion.automaticUpdates = false
    preferences.hypershield.selection = 'pinned'
    preferences.hypershield.pinnedReleaseId = 'github:saintromuald/ShieldBattery:1'
    preferences.hypershield.activeReleaseId = 'github:saintromuald/ShieldBattery:1'
    await writeReleasePreferences(userDataPath, preferences)
    await expect(readReleasePreferences(userDataPath)).resolves.toEqual(preferences)
  })
})
