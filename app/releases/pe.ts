import { promises as fs } from 'node:fs'

const DOS_HEADER_BYTES = 64
const PE_SIGNATURE_AND_COFF_BYTES = 26
const PE32_MAGIC = 0x10b
const PE32_PLUS_MAGIC = 0x20b
const AMD64_MACHINE = 0x8664

function uint16(contents: Uint8Array, offset: number): number {
  return contents[offset] | (contents[offset + 1] << 8)
}

function uint32(contents: Uint8Array, offset: number): number {
  return (
    contents[offset] +
    contents[offset + 1] * 0x100 +
    contents[offset + 2] * 0x10000 +
    contents[offset + 3] * 0x1000000
  )
}

type InvalidPe = (reason: string) => never

function invalid(reason: string): never {
  throw new Error(`Invalid PE32+ AMD64 binary: ${reason}`)
}

function invalidPe(reason: string): never {
  throw new Error(`Invalid PE binary: ${reason}`)
}

function peOffset(dosHeader: Uint8Array, invalidBinary: InvalidPe): number {
  if (dosHeader.byteLength < DOS_HEADER_BYTES) {
    invalidBinary('the DOS header is truncated')
  }
  if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
    invalidBinary('the MZ signature is missing')
  }
  return uint32(dosHeader, 0x3c)
}

interface PeHeaderInfo {
  machine: number
  optionalHeaderMagic: number
}

function readPeHeader(
  offset: number,
  header: Uint8Array,
  fileSize: number,
  invalidBinary: InvalidPe,
): PeHeaderInfo {
  if (offset > fileSize - PE_SIGNATURE_AND_COFF_BYTES || header.byteLength < 26) {
    invalidBinary('e_lfanew points outside the file or the PE header is truncated')
  }
  if (header[0] !== 0x50 || header[1] !== 0x45 || header[2] !== 0 || header[3] !== 0) {
    invalidBinary('the PE signature is missing')
  }
  const optionalHeaderSize = uint16(header, 20)
  if (optionalHeaderSize < 2 || offset + 24 + optionalHeaderSize > fileSize) {
    invalidBinary('the optional header is truncated')
  }
  return {
    machine: uint16(header, 4),
    optionalHeaderMagic: uint16(header, 24),
  }
}

function validatePeHeader(offset: number, header: Uint8Array, fileSize: number): void {
  const info = readPeHeader(offset, header, fileSize, invalid)
  if (info.machine !== AMD64_MACHINE) {
    invalid('the COFF machine is not AMD64')
  }
  if (info.optionalHeaderMagic !== PE32_PLUS_MAGIC) {
    invalid('the optional header is not PE32+')
  }
}

function validateGenericPeHeader(offset: number, header: Uint8Array, fileSize: number): void {
  const info = readPeHeader(offset, header, fileSize, invalidPe)
  if (info.optionalHeaderMagic !== PE32_MAGIC && info.optionalHeaderMagic !== PE32_PLUS_MAGIC) {
    invalidPe('the optional header is neither PE32 nor PE32+')
  }
}

/** Validates the headers that distinguish a native AMD64 PE32+ executable or library. */
export function validatePe32PlusAmd64(contents: Uint8Array): void {
  const offset = peOffset(contents, invalid)
  validatePeHeader(offset, contents.subarray(offset, offset + 26), contents.byteLength)
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
  return result.subarray(0, transferred)
}

async function validatePeFileWith(
  pathname: string,
  invalidBinary: InvalidPe,
  validateHeader: (offset: number, header: Uint8Array, fileSize: number) => void,
): Promise<void> {
  const handle = await fs.open(pathname, 'r')
  try {
    const { size } = await handle.stat()
    const dosHeader = await readAt(handle, DOS_HEADER_BYTES, 0)
    const offset = peOffset(dosHeader, invalidBinary)
    if (offset > size - PE_SIGNATURE_AND_COFF_BYTES) {
      validateHeader(offset, new Uint8Array(), size)
    }
    const header = await readAt(handle, PE_SIGNATURE_AND_COFF_BYTES, offset)
    validateHeader(offset, header, size)
  } finally {
    await handle.close()
  }
}

/** Reads only the PE headers instead of loading a native binary into memory. */
export async function validatePe32PlusAmd64File(pathname: string): Promise<void> {
  return validatePeFileWith(pathname, invalid, validatePeHeader)
}

/** Validates PE32 or PE32+ headers without imposing a processor-architecture restriction. */
export async function validatePeFile(pathname: string): Promise<void> {
  return validatePeFileWith(pathname, invalidPe, validateGenericPeHeader)
}
