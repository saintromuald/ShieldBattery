import { deflateRawSync } from 'node:zlib'

export interface ZipFixtureEntry {
  name: string
  contents?: Uint8Array | string
  kind?: 'file' | 'directory' | 'symlink'
  advertisedSize?: number
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

function crc32(contents: Buffer): number {
  let crc = 0xffffffff
  for (const byte of contents) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function makePe32PlusAmd64(): Buffer {
  const contents = Buffer.alloc(0x200)
  contents.write('MZ', 0, 'ascii')
  contents.writeUInt32LE(0x80, 0x3c)
  contents.write('PE\0\0', 0x80, 'ascii')
  contents.writeUInt16LE(0x8664, 0x84)
  contents.writeUInt16LE(1, 0x86)
  contents.writeUInt16LE(0xf0, 0x94)
  contents.writeUInt16LE(0x20b, 0x98)
  return contents
}

export function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const contents =
      typeof entry.contents === 'string'
        ? Buffer.from(entry.contents)
        : Buffer.from(entry.contents ?? [])
    const directory = entry.kind === 'directory'
    const compression = directory || !contents.length ? 0 : 8
    const compressed = compression === 8 ? deflateRawSync(contents) : contents
    const size = entry.advertisedSize ?? contents.length
    const checksum = directory ? 0 : crc32(contents)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(compression, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    localParts.push(local, compressed)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(compression, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    let mode = 0o100644
    if (directory) {
      mode = 0o40755
    } else if (entry.kind === 'symlink') {
      mode = 0o120777
    }
    central.writeUInt32LE((((mode << 16) >>> 0) | (directory ? 0x10 : 0)) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    centralParts.push(central)
    localOffset += local.length + compressed.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

export function publicHyperionZipEntries(
  executable = makePe32PlusAmd64(),
  library = makePe32PlusAmd64(),
): ZipFixtureEntry[] {
  return [
    { name: 'Hyperion.exe', contents: executable },
    { name: 'SDL3.dll', contents: library },
    { name: 'Data/', kind: 'directory' },
    { name: 'Data/public.dat', contents: 'public engine data' },
    {
      name: 'release.json',
      contents: JSON.stringify({
        product: 'Hyperion Shield',
        version: '1.0.0',
        gameFilesBundled: false,
      }),
    },
    { name: 'EDITION.txt', contents: 'Public Hyperion Shield\n' },
  ]
}

export function makeHyperionZip(entries = publicHyperionZipEntries()): Buffer {
  return makeZip(entries)
}
