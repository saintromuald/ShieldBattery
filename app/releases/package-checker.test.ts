import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkHyperionPackage, validatePe32PlusAmd64 } from '../../tools/check-hyperion-package.cjs'
import { makePe32PlusAmd64 } from './testing/fixtures'

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
      product: 'Hyperion Shield',
      version: '1.0.0',
      gameFilesBundled: false,
    }),
  )
  await fs.writeFile(path.join(resourceDirectory, 'EDITION.txt'), 'Public Hyperion Shield\n')
}

async function writeWindowsPackage(): Promise<void> {
  await fs.mkdir(path.join(resourceDirectory, 'Data'))
  await fs.writeFile(path.join(resourceDirectory, 'Data', 'public.dat'), 'public engine data')
  await fs.writeFile(path.join(resourceDirectory, 'Hyperion.exe'), makePe32PlusAmd64())
  await fs.writeFile(path.join(resourceDirectory, 'SDL3.dll'), makePe32PlusAmd64())
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

  it('rejects invalid PE binaries and every additional executable or library', async () => {
    await writeWindowsPackage()
    await fs.writeFile(path.join(resourceDirectory, 'SDL3.dll'), 'not a PE file')
    expect(() => checkHyperionPackage(appOutDir, 'win32')).toThrow('SDL3.dll is not a PE32+')

    await fs.writeFile(path.join(resourceDirectory, 'SDL3.dll'), makePe32PlusAmd64())
    await fs.writeFile(path.join(resourceDirectory, 'Data', 'helper.exe'), makePe32PlusAmd64())
    expect(() => checkHyperionPackage(appOutDir, 'win32')).toThrow('file is forbidden')
  })

  it('retains ELF validation for Linux packages', async () => {
    await fs.mkdir(path.join(resourceDirectory, 'Data'))
    await fs.writeFile(
      path.join(resourceDirectory, 'Hyperion.x86_64'),
      new Uint8Array([127, 69, 76, 70]),
      {
        mode: 0o755,
      },
    )
    await fs.writeFile(path.join(resourceDirectory, 'libSDL3.so.0'), 'ELF library')
    await writeMetadata()
    expect(() => checkHyperionPackage(appOutDir, 'linux')).not.toThrow()

    await fs.writeFile(path.join(resourceDirectory, 'Hyperion.x86_64'), makePe32PlusAmd64(), {
      mode: 0o755,
    })
    expect(() => checkHyperionPackage(appOutDir, 'linux')).toThrow('not a native ELF executable')
  })
})
