// Validates the native Hyperion resources in a package after electron-builder copies them.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PUBLIC_PRODUCT_NAMES = new Set(['HyperShield Shield', 'Hyperion Shield'])
const FORBIDDEN_SUFFIXES = new Set([
  '.mpq',
  '.dll',
  '.exe',
  '.scm',
  '.scx',
  '.rep',
  '.grp',
  '.casc',
])

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Hyperion package contains a symbolic link: ${entryPath}`)
    }
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

function validatePe32PlusAmd64(contents) {
  if (contents.byteLength < 64) {
    throw new Error('the DOS header is truncated')
  }
  if (contents[0] !== 0x4d || contents[1] !== 0x5a) {
    throw new Error('the MZ signature is missing')
  }
  const offset = contents.readUInt32LE(0x3c)
  if (offset > contents.byteLength - 26) {
    throw new Error('e_lfanew points outside the file or the PE header is truncated')
  }
  if (
    contents[offset] !== 0x50 ||
    contents[offset + 1] !== 0x45 ||
    contents[offset + 2] !== 0 ||
    contents[offset + 3] !== 0
  ) {
    throw new Error('the PE signature is missing')
  }
  if (contents.readUInt16LE(offset + 4) !== 0x8664) {
    throw new Error('the COFF machine is not AMD64')
  }
  const optionalHeaderSize = contents.readUInt16LE(offset + 20)
  if (optionalHeaderSize < 2 || offset + 24 + optionalHeaderSize > contents.byteLength) {
    throw new Error('the optional header is truncated')
  }
  if (contents.readUInt16LE(offset + 24) !== 0x20b) {
    throw new Error('the optional header is not PE32+')
  }
}

function validateNativeExecutable(executablePath, platform) {
  const contents = fs.readFileSync(executablePath)
  if (platform === 'win32') {
    try {
      validatePe32PlusAmd64(contents)
    } catch (error) {
      return `Hyperion.exe is not a PE32+ AMD64 binary: ${error.message}`
    }
    return undefined
  }
  if (contents.byteLength < 4) {
    return 'Hyperion.x86_64 is truncated'
  }
  if (contents[0] !== 127 || contents[1] !== 69 || contents[2] !== 76 || contents[3] !== 70) {
    return 'Hyperion.x86_64 is not a native ELF executable'
  }
  return undefined
}

function checkHyperionPackage(appOutDir, platform = process.platform) {
  if (platform !== 'linux' && platform !== 'win32') {
    throw new Error(`Hyperion package validation does not support ${platform}.`)
  }
  const windows = platform === 'win32'
  const executable = windows ? 'Hyperion.exe' : 'Hyperion.x86_64'
  const library = windows ? 'SDL3.dll' : 'libSDL3.so.0'
  const resourceDirectory = path.join(appOutDir, 'resources', 'hyperion')
  const executablePath = path.join(resourceDirectory, executable)
  const problems = []
  const required = [executable, library, 'release.json', 'EDITION.txt']
  if (windows) {
    required.push('Data')
  }

  for (const name of required) {
    if (!fs.existsSync(path.join(resourceDirectory, name))) {
      problems.push(`${name} is missing`)
    }
  }
  if (fs.existsSync(path.join(resourceDirectory, 'Game'))) {
    problems.push('Game/ must not be shipped')
  }
  if (windows && fs.existsSync(path.join(resourceDirectory, 'Data'))) {
    const data = fs.lstatSync(path.join(resourceDirectory, 'Data'))
    if (!data.isDirectory() || data.isSymbolicLink()) {
      problems.push('Data must be a regular directory')
    }
  }

  if (fs.existsSync(executablePath)) {
    if (!windows) {
      fs.accessSync(executablePath, fs.constants.X_OK)
    }
    const nativeProblem = validateNativeExecutable(executablePath, platform)
    if (nativeProblem) {
      problems.push(nativeProblem)
    }
  }
  const libraryPath = path.join(resourceDirectory, library)
  if (windows && fs.existsSync(libraryPath)) {
    try {
      validatePe32PlusAmd64(fs.readFileSync(libraryPath))
    } catch (error) {
      problems.push(`SDL3.dll is not a PE32+ AMD64 library: ${error.message}`)
    }
  }

  const releasePath = path.join(resourceDirectory, 'release.json')
  if (fs.existsSync(releasePath)) {
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
    if (
      !PUBLIC_PRODUCT_NAMES.has(release.product) ||
      release.gameFilesBundled !== false ||
      (windows && (typeof release.version !== 'string' || !release.version))
    ) {
      problems.push('release.json is not for public HyperShield Shield without game files')
    }
  }

  if (fs.existsSync(resourceDirectory)) {
    for (const filePath of walk(resourceDirectory)) {
      const relative = path.relative(resourceDirectory, filePath).split(path.sep).join('/')
      const allowedWindowsBinary =
        windows && (relative === 'Hyperion.exe' || relative === 'SDL3.dll')
      if (FORBIDDEN_SUFFIXES.has(path.extname(filePath).toLowerCase()) && !allowedWindowsBinary) {
        problems.push(`proprietary or foreign-platform file is forbidden: ${filePath}`)
      }
    }
  }

  if (problems.length) {
    throw new Error(`Hyperion package validation failed: ${problems.join('; ')}`)
  }
}

exports.default = async function afterPack(context) {
  checkHyperionPackage(context.appOutDir, context.electronPlatformName ?? process.platform)
}
exports.checkHyperionPackage = checkHyperionPackage
exports.validatePe32PlusAmd64 = validatePe32PlusAmd64

if (require.main === module) {
  try {
    checkHyperionPackage(process.argv[2], process.argv[3] ?? process.platform)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
