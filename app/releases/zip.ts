import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

const ZIP_LIST_LIMIT_BYTES = 32 * 1024 * 1024
const ZIP_END_RECORD_BYTES = 22
const ZIP_MAX_COMMENT_BYTES = 65_535
const ZIP_LOCAL_HEADER_BYTES = 30
const ZIP_CENTRAL_HEADER_BYTES = 46
const SUPPORTED_ZIP_FLAGS = 0x080e

export interface ZipEntry {
  kind: 'file' | 'directory'
  name: string
  size: number
  compressedSize: number
  compression: number
  crc32: number
  flags: number
  localHeaderOffset: number
  dataOffset: number
}

export interface ZipExtractionLimits {
  maxArchiveBytes: number
  maxEntries: number
  maxFileBytes: number
  maxUncompressedBytes: number
}

interface ZipDirectory {
  entries: ZipEntry[]
  centralDirectoryOffset: number
}

async function readAt(handle: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const result = Buffer.alloc(length)
  let transferred = 0
  while (transferred < length) {
    const { bytesRead } = await handle.read(
      result,
      transferred,
      length - transferred,
      position + transferred,
    )
    if (!bytesRead) {
      break
    }
    transferred += bytesRead
  }
  if (transferred !== length) {
    throw new Error('Hyperion ZIP is truncated.')
  }
  return result
}

function decodeName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some(byte => byte >= 0x80)) {
    throw new Error('Hyperion ZIP contains a non-UTF-8 filename that cannot be validated safely.')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error('Hyperion ZIP contains an invalid UTF-8 filename.', { cause: error })
  }
}

function canonicalName(name: string): string {
  return name
    .split('/')
    .filter(segment => segment && segment !== '.')
    .join('/')
    .toLowerCase()
}

function validateDirectoryLayout(entries: readonly ZipEntry[]): void {
  const kinds = new Map<string, ZipEntry['kind']>()
  for (const entry of entries) {
    const canonical = canonicalName(entry.name)
    if (!canonical && entry.kind === 'directory') {
      continue
    }
    if (kinds.has(canonical)) {
      throw new Error(`Hyperion ZIP contains a duplicate or ambiguous path: ${entry.name}`)
    }
    kinds.set(canonical, entry.kind)
  }
  for (const canonical of kinds.keys()) {
    const segments = canonical.split('/')
    for (let length = 1; length < segments.length; length += 1) {
      if (kinds.get(segments.slice(0, length).join('/')) === 'file') {
        throw new Error('Hyperion ZIP contains a file used as a parent directory.')
      }
    }
  }
}

async function readZipDirectory(
  handle: fs.FileHandle,
  fileSize: number,
  limits: ZipExtractionLimits,
  validateEntry: (entry: ZipEntry) => void,
): Promise<ZipDirectory> {
  if (fileSize < ZIP_END_RECORD_BYTES) {
    throw new Error('Hyperion ZIP is truncated.')
  }
  const tailLength = Math.min(fileSize, ZIP_END_RECORD_BYTES + ZIP_MAX_COMMENT_BYTES)
  const tail = await readAt(handle, tailLength, fileSize - tailLength)
  let endOffset = -1
  for (let index = tail.length - ZIP_END_RECORD_BYTES; index >= 0; index -= 1) {
    if (
      tail.readUInt32LE(index) === 0x06054b50 &&
      index + ZIP_END_RECORD_BYTES + tail.readUInt16LE(index + 20) === tail.length
    ) {
      endOffset = index
      break
    }
  }
  if (endOffset < 0) {
    throw new Error('Hyperion ZIP has no valid end-of-central-directory record.')
  }
  const end = tail.subarray(endOffset)
  const entryCount = end.readUInt16LE(10)
  const centralDirectorySize = end.readUInt32LE(12)
  const centralDirectoryOffset = end.readUInt32LE(16)
  if (
    end.readUInt16LE(4) !== 0 ||
    end.readUInt16LE(6) !== 0 ||
    end.readUInt16LE(8) !== entryCount ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('Multi-disk, empty, and ZIP64 Hyperion archives are not supported.')
  }
  if (entryCount > limits.maxEntries) {
    throw new Error(`Hyperion ZIP exceeds the ${limits.maxEntries}-entry limit.`)
  }
  if (centralDirectorySize > ZIP_LIST_LIMIT_BYTES) {
    throw new Error('Hyperion ZIP central directory exceeds the validation size limit.')
  }
  const absoluteEndOffset = fileSize - tailLength + endOffset
  if (
    centralDirectoryOffset > absoluteEndOffset ||
    centralDirectorySize !== absoluteEndOffset - centralDirectoryOffset
  ) {
    throw new Error('Hyperion ZIP has an invalid central directory range.')
  }

  const central = await readAt(handle, centralDirectorySize, centralDirectoryOffset)
  const entries: ZipEntry[] = []
  let offset = 0
  let uncompressedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset > central.length - ZIP_CENTRAL_HEADER_BYTES ||
      central.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw new Error('Hyperion ZIP contains an invalid central directory entry.')
    }
    const nameLength = central.readUInt16LE(offset + 28)
    const extraLength = central.readUInt16LE(offset + 30)
    const commentLength = central.readUInt16LE(offset + 32)
    const nextOffset = offset + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength
    if (nextOffset > central.length) {
      throw new Error('Hyperion ZIP contains a truncated central directory entry.')
    }
    const flags = central.readUInt16LE(offset + 8)
    const compression = central.readUInt16LE(offset + 10)
    const size = central.readUInt32LE(offset + 24)
    const compressedSize = central.readUInt32LE(offset + 20)
    const localHeaderOffset = central.readUInt32LE(offset + 42)
    if (
      flags & ~SUPPORTED_ZIP_FLAGS ||
      (compression !== 0 && compression !== 8) ||
      size === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      central.readUInt16LE(offset + 34) !== 0
    ) {
      throw new Error(
        'Hyperion ZIP uses encryption, ZIP64, multiple disks, or an unsupported method.',
      )
    }

    const name = decodeName(
      central.subarray(
        offset + ZIP_CENTRAL_HEADER_BYTES,
        offset + ZIP_CENTRAL_HEADER_BYTES + nameLength,
      ),
      (flags & 0x0800) !== 0,
    )
    const versionMadeBy = central.readUInt16LE(offset + 4)
    const externalAttributes = central.readUInt32LE(offset + 38)
    const unixFileType = versionMadeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xf000 : 0
    if (unixFileType && unixFileType !== 0x8000 && unixFileType !== 0x4000) {
      throw new Error(
        'Hyperion ZIP may contain only regular files and directories; links are forbidden.',
      )
    }
    const directory = name.endsWith('/') || (externalAttributes & 0x10) !== 0
    if (
      (directory && unixFileType === 0x8000) ||
      (!directory && unixFileType === 0x4000) ||
      (directory && (size !== 0 || compressedSize !== 0))
    ) {
      throw new Error('Hyperion ZIP contains inconsistent file types or directory data.')
    }
    const entry: ZipEntry = {
      kind: directory ? 'directory' : 'file',
      name,
      size,
      compressedSize,
      compression,
      crc32: central.readUInt32LE(offset + 16),
      flags,
      localHeaderOffset,
      dataOffset: 0,
    }
    validateEntry(entry)
    if (entry.kind === 'file') {
      if (size > limits.maxFileBytes) {
        throw new Error(`Hyperion ZIP contains an excessive file size: ${name}`)
      }
      if (size > limits.maxUncompressedBytes - uncompressedBytes) {
        throw new Error(
          `Hyperion ZIP exceeds the ${limits.maxUncompressedBytes}-byte uncompressed size limit.`,
        )
      }
      uncompressedBytes += size
    }
    entries.push(entry)
    offset = nextOffset
  }
  if (offset !== central.length) {
    throw new Error('Hyperion ZIP central directory has inconsistent entry counts.')
  }
  validateDirectoryLayout(entries)

  for (const entry of entries) {
    if (entry.localHeaderOffset > centralDirectoryOffset - ZIP_LOCAL_HEADER_BYTES) {
      throw new Error(`Hyperion ZIP has an invalid local header for ${entry.name}.`)
    }
    const local = await readAt(handle, ZIP_LOCAL_HEADER_BYTES, entry.localHeaderOffset)
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(6) !== entry.flags ||
      local.readUInt16LE(8) !== entry.compression
    ) {
      throw new Error(`Hyperion ZIP has inconsistent local metadata for ${entry.name}.`)
    }
    const nameLength = local.readUInt16LE(26)
    const extraLength = local.readUInt16LE(28)
    const nameBytes = await readAt(
      handle,
      nameLength,
      entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES,
    )
    if (!nameBytes.equals(Buffer.from(entry.name, 'utf8'))) {
      throw new Error(`Hyperion ZIP has a local filename mismatch for ${entry.name}.`)
    }
    entry.dataOffset = entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + nameLength + extraLength
    if (
      entry.dataOffset > centralDirectoryOffset ||
      entry.compressedSize > centralDirectoryOffset - entry.dataOffset
    ) {
      throw new Error(`Hyperion ZIP has an invalid compressed data range for ${entry.name}.`)
    }
  }
  return { entries, centralDirectoryOffset }
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

function updateCrc32(crc: number, contents: Buffer): number {
  let result = crc
  for (const byte of contents) {
    result = CRC32_TABLE[(result ^ byte) & 0xff] ^ (result >>> 8)
  }
  return result >>> 0
}

class ZipVerificationTransform extends Transform {
  private transferred = 0
  private crc = 0xffffffff

  constructor(private readonly entry: ZipEntry) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (chunk.byteLength > this.entry.size - this.transferred) {
      callback(new Error(`Hyperion ZIP entry exceeds its advertised size: ${this.entry.name}`))
      return
    }
    this.transferred += chunk.byteLength
    this.crc = updateCrc32(this.crc, chunk)
    callback(undefined, chunk)
  }

  override _flush(callback: TransformCallback): void {
    if (this.transferred !== this.entry.size) {
      callback(
        new Error(`Hyperion ZIP entry is shorter than its advertised size: ${this.entry.name}`),
      )
      return
    }
    if ((this.crc ^ 0xffffffff) >>> 0 !== this.entry.crc32) {
      callback(new Error(`Hyperion ZIP entry failed CRC-32 verification: ${this.entry.name}`))
      return
    }
    callback()
  }
}

function destinationPath(destination: string, name: string): string {
  const segments = name.split('/').filter(segment => segment && segment !== '.')
  const result = path.resolve(destination, ...segments)
  if (result !== destination && !result.startsWith(`${destination}${path.sep}`)) {
    throw new Error(`Hyperion ZIP entry escapes its destination: ${name}`)
  }
  return result
}

async function extractEntry(
  archivePath: string,
  destination: string,
  entry: ZipEntry,
): Promise<void> {
  const outputPath = destinationPath(destination, entry.name)
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  const source = entry.compressedSize
    ? createReadStream(archivePath, {
        start: entry.dataOffset,
        end: entry.dataOffset + entry.compressedSize - 1,
      })
    : Readable.from([])
  const verifier = new ZipVerificationTransform(entry)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  if (entry.compression === 8) {
    await pipeline(source, createInflateRaw(), verifier, output)
  } else {
    await pipeline(source, verifier, output)
  }
}

/** Validates every ZIP record before writing files, then streams each verified entry to private storage. */
export async function extractHyperionZip(
  archivePath: string,
  destination: string,
  limits: ZipExtractionLimits,
  validateEntry: (entry: ZipEntry) => void,
): Promise<void> {
  const handle = await fs.open(archivePath, 'r')
  let directory: ZipDirectory
  try {
    const { size } = await handle.stat()
    if (size > limits.maxArchiveBytes) {
      throw new Error(`Hyperion ZIP exceeds the ${limits.maxArchiveBytes}-byte archive size limit.`)
    }
    directory = await readZipDirectory(handle, size, limits, validateEntry)
  } finally {
    await handle.close()
  }

  await fs.mkdir(destination, { recursive: false, mode: 0o700 })
  for (const entry of directory.entries) {
    if (entry.kind === 'directory') {
      await fs.mkdir(destinationPath(destination, entry.name), { recursive: true, mode: 0o700 })
    }
  }
  for (const entry of directory.entries) {
    if (entry.kind === 'file') {
      await extractEntry(archivePath, destination, entry)
    }
  }
}
