import { promises as fs } from 'node:fs'

const DOS_HEADER_BYTES = 64
const PE_SIGNATURE_AND_COFF_BYTES = 26
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

function invalid(reason: string): never {
  throw new Error(`Invalid PE32+ AMD64 binary: ${reason}`)
}

function peOffset(dosHeader: Uint8Array): number {
  if (dosHeader.byteLength < DOS_HEADER_BYTES) {
    invalid('the DOS header is truncated')
  }
  if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
    invalid('the MZ signature is missing')
  }
  return uint32(dosHeader, 0x3c)
}

function validatePeHeader(offset: number, header: Uint8Array, fileSize: number): void {
  if (offset > fileSize - PE_SIGNATURE_AND_COFF_BYTES || header.byteLength < 26) {
    invalid('e_lfanew points outside the file or the PE header is truncated')
  }
  if (header[0] !== 0x50 || header[1] !== 0x45 || header[2] !== 0 || header[3] !== 0) {
    invalid('the PE signature is missing')
  }
  if (uint16(header, 4) !== AMD64_MACHINE) {
    invalid('the COFF machine is not AMD64')
  }
  const optionalHeaderSize = uint16(header, 20)
  if (optionalHeaderSize < 2 || offset + 24 + optionalHeaderSize > fileSize) {
    invalid('the optional header is truncated')
  }
  if (uint16(header, 24) !== PE32_PLUS_MAGIC) {
    invalid('the optional header is not PE32+')
  }
}

/** Validates the headers that distinguish a native AMD64 PE32+ executable or library. */
export function validatePe32PlusAmd64(contents: Uint8Array): void {
  const offset = peOffset(contents)
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

/** Reads only the PE headers instead of loading a native binary into memory. */
export async function validatePe32PlusAmd64File(pathname: string): Promise<void> {
  const handle = await fs.open(pathname, 'r')
  try {
    const { size } = await handle.stat()
    const dosHeader = await readAt(handle, DOS_HEADER_BYTES, 0)
    const offset = peOffset(dosHeader)
    if (offset > size - PE_SIGNATURE_AND_COFF_BYTES) {
      validatePeHeader(offset, new Uint8Array(), size)
    }
    const header = await readAt(handle, PE_SIGNATURE_AND_COFF_BYTES, offset)
    validatePeHeader(offset, header, size)
  } finally {
    await handle.close()
  }
}
