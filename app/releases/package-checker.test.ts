import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  afterPack,
  checkHyperionPackage,
  validatePe32PlusAmd64,
} from '../../tools/check-hyperion-package.cjs'
import { makeElf64, makeMachOArm64, makePe32PlusAmd64, makePe32X86 } from './testing/fixtures'

let temporaryDirectory: string
let appOutDir: string
let resourceDirectory: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-hyperion-package-test-'))
  appOutDir = path.join(temporaryDirectory, 'app')
  resourceDirectory = path.join(appOutDir, 'resources', 'hyperion')
  await fs.mkdir(resourceDirectory, { recursive: true })
})

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

async function writeMetadata(): Promise<void> {
  await fs.writeFile(
    path.join(resourceDirectory, 'release.json'),
    JSON.stringify({
      product: 'Hyperion Shield Zero',
      version: '1.0.0',
      gameFilesBundled: false,
    }),
  )
  await fs.writeFile(path.join(resourceDirectory, 'EDITION.txt'), 'Public Hyperion Shield Zero\n')
}

async function writeWindowsPackage(): Promise<void> {
  await fs.mkdir(path.join(resourceDirectory, 'Data'))
  await fs.writeFile(path.join(resourceDirectory, 'Data', 'public.dat'), 'public engine data')
  await fs.writeFile(path.join(resourceDirectory, 'Hyperion.exe'), makePe32PlusAmd64())
  await fs.writeFile(path.join(resourceDirectory, 'SDL3.dll'), makePe32PlusAmd64())
  await writeMetadata()
}

async function writeLinuxPackage(): Promise<void> {
  await fs.mkdir(path.join(resourceDirectory, 'Data'))
  await fs.writeFile(path.join(resourceDirectory, 'Hyperion.x86_64'), makeElf64(), {
    mode: 0o755,
  })
  await fs.writeFile(path.join(resourceDirectory, 'libSDL3.so.0'), makeElf64())
  await writeMetadata()
}

async function writePlutoSupport(bridge: Uint8Array | string = makePe32X86()): Promise<void> {
  const plutoDirectory = path.join(resourceDirectory, 'Data', 'pluto')
  await fs.mkdir(plutoDirectory, { recursive: true })
  await fs.writeFile(path.join(plutoDirectory, 'pluto-bridge.exe'), bridge)
  await fs.writeFile(path.join(plutoDirectory, 'COPYING.BWAPI'), 'BWAPI copying notice')
  await fs.writeFile(path.join(plutoDirectory, 'SOURCE.BWAPI.txt'), 'BWAPI source notice')
}

async function writeMacPackage(): Promise<void> {
  appOutDir = path.join(temporaryDirectory, 'mac-arm64', 'HyperShield.app')
  resourceDirectory = path.join(appOutDir, 'Contents', 'Resources', 'hyperion')
  const macOsDirectory = path.join(resourceDirectory, 'Hyperion.app', 'Contents', 'MacOS')
  await fs.mkdir(path.join(resourceDirectory, 'Data'), { recursive: true })
  await fs.mkdir(macOsDirectory, { recursive: true })
  await fs.writeFile(path.join(resourceDirectory, 'Data', 'public.dat'), 'public engine data')
  await fs.writeFile(path.join(macOsDirectory, 'Hyperion'), makeMachOArm64(), { mode: 0o755 })
  await fs.writeFile(path.join(macOsDirectory, 'libSDL3.0.dylib'), makeMachOArm64('dynamicLibrary'))
  await writeMetadata()
}

describe('Hyperion package native validation', () => {
  it('accepts a PE32+ AMD64 header', () => {
    expect(() => validatePe32PlusAmd64(makePe32PlusAmd64())).not.toThrow()
  })

  it.each([
    ['MZ signature', (contents: Buffer) => contents.write('NZ', 0, 'ascii'), 'MZ signature'],
    ['e_lfanew bounds', (contents: Buffer) => contents.writeUInt32LE(0xfffffff0, 0x3c), 'e_lfanew'],
    ['PE signature', (contents: Buffer) => contents.write('PX', 0x80, 'ascii'), 'PE signature'],
    ['AMD64 machine', (contents: Buffer) => contents.writeUInt16LE(0x14c, 0x84), 'not AMD64'],
    ['PE32+ magic', (contents: Buffer) => contents.writeUInt16LE(0x10b, 0x98), 'not PE32+'],
    [
      'optional header bounds',
      (contents: Buffer) => contents.writeUInt16LE(0xffff, 0x94),
      'optional header is truncated',
    ],
  ])('rejects an invalid %s', (_name, mutate, message) => {
    const contents = makePe32PlusAmd64()
    mutate(contents)
    expect(() => validatePe32PlusAmd64(contents)).toThrow(message)
  })

  it('accepts a Windows package with only its two required native binaries', async () => {
    await writeWindowsPackage()
    expect(() => checkHyperionPackage(appOutDir, 'win32')).not.toThrow()
  })

  it.each(['win32', 'linux'] as const)(
    'accepts the 32-bit Pluto bridge and BWAPI notices in a %s package',
    async platform => {
      if (platform === 'win32') {
        await writeWindowsPackage()
      } else {
        await writeLinuxPackage()
      }
      await writePlutoSupport()
      expect(() => checkHyperionPackage(appOutDir, platform)).not.toThrow()

      await writePlutoSupport('not a PE file')
      expect(() => checkHyperionPackage(appOutDir, platform)).toThrow(
        'pluto-bridge.exe is not a PE32 or PE32+ binary',
      )
    },
  )

  it.each(['win32', 'linux'] as const)(
    'rejects official Pluto payloads and unexpected executables in a %s package',
    async platform => {
      if (platform === 'win32') {
        await writeWindowsPackage()
      } else {
        await writeLinuxPackage()
      }
      await writePlutoSupport()
      for (const name of ['pluto.dll', 'pluto_infer.exe', 'pluto_weights.bin', 'unexpected.exe']) {
        await fs.writeFile(path.join(resourceDirectory, 'Data', 'pluto', name), 'forbidden')
        expect(() => checkHyperionPackage(appOutDir, platform)).toThrow('file is forbidden')
        await fs.rm(path.join(resourceDirectory, 'Data', 'pluto', name))
      }
    },
  )

  it.each(['Hyperion Shield', 'HyperShield Shield'])(
    'continues to accept legacy %s metadata',
    async product => {
      await writeWindowsPackage()
      const metadataPath = path.join(resourceDirectory, 'release.json')
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
      metadata.product = product
      await fs.writeFile(metadataPath, JSON.stringify(metadata))
      expect(() => checkHyperionPackage(appOutDir, 'win32')).not.toThrow()
    },
  )

  it('rejects invalid PE binaries and every additional executable or library', async () => {
    await writeWindowsPackage()
    await fs.writeFile(path.join(resourceDirectory, 'SDL3.dll'), 'not a PE file')
    expect(() => checkHyperionPackage(appOutDir, 'win32')).toThrow('SDL3.dll is not a PE32+')

    await fs.writeFile(path.join(resourceDirectory, 'SDL3.dll'), makePe32PlusAmd64())
    await fs.writeFile(path.join(resourceDirectory, 'Data', 'helper.exe'), makePe32PlusAmd64())
    expect(() => checkHyperionPackage(appOutDir, 'win32')).toThrow('file is forbidden')
  })

  it('allows only the public Pluto bridge and BWAPI notices inside Data/pluto', async () => {
    await writeWindowsPackage()
    const plutoDirectory = path.join(resourceDirectory, 'Data', 'pluto')
    await fs.mkdir(plutoDirectory)
    await fs.writeFile(path.join(plutoDirectory, 'pluto-bridge.exe'), makePe32PlusAmd64())
    await fs.writeFile(path.join(plutoDirectory, 'COPYING.BWAPI'), 'BWAPI license')
    await fs.writeFile(path.join(plutoDirectory, 'SOURCE.BWAPI.txt'), 'BWAPI source notice')
    expect(() => checkHyperionPackage(appOutDir, 'win32')).not.toThrow()

    await fs.writeFile(path.join(plutoDirectory, 'pluto-official.exe'), makePe32PlusAmd64())
    expect(() => checkHyperionPackage(appOutDir, 'win32')).toThrow('file is forbidden')
  })

  it.each(['docs/pluto.dll', 'Data/other/pluto_infer.exe', 'pluto_weights.bin'])(
    'rejects official Pluto payload %s outside Data/pluto',
    async name => {
      await writeWindowsPackage()
      const payloadPath = path.join(resourceDirectory, name)
      await fs.mkdir(path.dirname(payloadPath), { recursive: true })
      await fs.writeFile(payloadPath, 'official Pluto payload')
      expect(() => checkHyperionPackage(appOutDir, 'win32')).toThrow(
        'official Pluto payload is forbidden',
      )
    },
  )

  it('retains ELF validation for Linux packages', async () => {
    await fs.mkdir(path.join(resourceDirectory, 'Data'))
    await fs.writeFile(path.join(resourceDirectory, 'Hyperion.x86_64'), makeElf64(), {
      mode: 0o755,
    })
    await fs.writeFile(path.join(resourceDirectory, 'libSDL3.so.0'), makeElf64())
    await writeMetadata()
    expect(() => checkHyperionPackage(appOutDir, 'linux')).not.toThrow()

    await fs.writeFile(path.join(resourceDirectory, 'Hyperion.x86_64'), makePe32PlusAmd64(), {
      mode: 0o755,
    })
    expect(() => checkHyperionPackage(appOutDir, 'linux')).toThrow('not a native ELF executable')
  })

  it('validates the nested Hyperion.app and both ARM64 Mach-O binaries on macOS', async () => {
    await writeMacPackage()
    expect(() => checkHyperionPackage(appOutDir, 'darwin')).not.toThrow()

    const executablePath = path.join(
      resourceDirectory,
      'Hyperion.app',
      'Contents',
      'MacOS',
      'Hyperion',
    )
    const executable = makeMachOArm64()
    executable.writeUInt32LE(0x00000007, 4)
    await fs.writeFile(executablePath, executable, { mode: 0o755 })
    expect(() => checkHyperionPackage(appOutDir, 'darwin')).toThrow('CPU type is not ARM64')

    await fs.writeFile(executablePath, makeMachOArm64(), { mode: 0o755 })
    const libraryPath = path.join(path.dirname(executablePath), 'libSDL3.0.dylib')
    await fs.writeFile(libraryPath, makeMachOArm64())
    expect(() => checkHyperionPackage(appOutDir, 'darwin')).toThrow('not MH_DYLIB')
  })

  it("resolves electron-builder's Mac output directory to the product app bundle", async () => {
    await writeMacPackage()
    await expect(
      afterPack({
        appOutDir: path.dirname(appOutDir),
        electronPlatformName: 'darwin',
        packager: { appInfo: { productName: 'HyperShield' } },
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects foreign libraries and official Pluto payloads in the Mac package', async () => {
    await writeMacPackage()
    await fs.writeFile(path.join(resourceDirectory, 'Data', 'other.dylib'), makeMachOArm64())
    expect(() => checkHyperionPackage(appOutDir, 'darwin')).toThrow('file is forbidden')

    await fs.rm(path.join(resourceDirectory, 'Data', 'other.dylib'))
    const plutoDirectory = path.join(resourceDirectory, 'Data', 'pluto')
    await fs.mkdir(plutoDirectory)
    await fs.writeFile(path.join(plutoDirectory, 'pluto-bridge.exe'), makePe32PlusAmd64())
    expect(() => checkHyperionPackage(appOutDir, 'darwin')).not.toThrow()
    await fs.writeFile(path.join(plutoDirectory, 'Pluto.exe'), makePe32PlusAmd64())
    expect(() => checkHyperionPackage(appOutDir, 'darwin')).toThrow('file is forbidden')
  })

  it('requires Data and a valid native SDL library on Linux', async () => {
    await fs.writeFile(path.join(resourceDirectory, 'Hyperion.x86_64'), makeElf64(), {
      mode: 0o755,
    })
    await fs.writeFile(path.join(resourceDirectory, 'libSDL3.so.0'), makeElf64())
    await writeMetadata()
    expect(() => checkHyperionPackage(appOutDir, 'linux')).toThrow('Data is missing')

    await fs.mkdir(path.join(resourceDirectory, 'Data'))
    await fs.writeFile(path.join(resourceDirectory, 'libSDL3.so.0'), 'not an ELF library')
    expect(() => checkHyperionPackage(appOutDir, 'linux')).toThrow(
      'libSDL3.so.0 is not a native ELF library',
    )
  })
})
