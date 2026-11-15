import { promises as fs } from 'node:fs'

const MH_MAGIC_64 = 0xfeedfacf
const CPU_TYPE_ARM64 = 0x0100000c
const MH_EXECUTE = 2
const MH_DYLIB = 6

export type MachOFileKind = 'executable' | 'dynamicLibrary'

/** Accepts only the thin, little-endian ARM64 Mach-O format shipped by the public Mac packages. */
export function validateMachOArm64(contents: Buffer, kind: MachOFileKind = 'executable'): void {
  if (contents.byteLength < 32) {
    throw new Error('the Mach-O header is truncated')
  }
  if (contents.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error('the 64-bit Mach-O signature is missing')
  }
  if (contents.readUInt32LE(4) !== CPU_TYPE_ARM64) {
    throw new Error('the Mach-O CPU type is not ARM64')
  }
  const expectedFileType = kind === 'executable' ? MH_EXECUTE : MH_DYLIB
  if (contents.readUInt32LE(12) !== expectedFileType) {
    throw new Error(
      `the Mach-O file type is not ${kind === 'executable' ? 'MH_EXECUTE' : 'MH_DYLIB'}`,
    )
  }
}

export async function validateMachOArm64File(
  filePath: string,
  kind: MachOFileKind = 'executable',
): Promise<void> {
  validateMachOArm64(await fs.readFile(filePath), kind)
}
