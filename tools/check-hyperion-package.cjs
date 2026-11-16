// Validates the native Hyperion resources in a package after electron-builder copies them.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PUBLIC_PRODUCT_NAMES = new Set([
  'Hyperion Shield Zero',
  'Hyperion Shield',
  'HyperShield Shield',
])
const PUBLIC_PLUTO_FILES = new Set([
  'Data/pluto/pluto-bridge.exe',
  'Data/pluto/COPYING.BWAPI',
  'Data/pluto/SOURCE.BWAPI.txt',
])
const OFFICIAL_PLUTO_BASENAMES = new Set(['pluto.dll', 'pluto_infer.exe', 'pluto_weights.bin'])
const MAC_EXECUTABLE = 'Hyperion.app/Contents/MacOS/Hyperion'
const MAC_LIBRARY = 'Hyperion.app/Contents/MacOS/libSDL3.0.dylib'
const FORBIDDEN_SUFFIXES = new Set([
  '.mpq',
  '.dll',
  '.dylib',
  '.exe',
  '.scm',
  '.scx',
  '.rep',
  '.grp',
  '.casc',
])
const PLUTO_BRIDGE_RELATIVE = 'Data/pluto/pluto-bridge.exe'

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Hyperion package contains a symbolic link: ${entryPath}`)
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`Hyperion package contains a special file: ${entryPath}`)
    }
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

function readPeHeader(contents) {
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
  const optionalHeaderSize = contents.readUInt16LE(offset + 20)
  if (optionalHeaderSize < 2 || offset + 24 + optionalHeaderSize > contents.byteLength) {
    throw new Error('the optional header is truncated')
  }
  return {
    machine: contents.readUInt16LE(offset + 4),
    optionalHeaderMagic: contents.readUInt16LE(offset + 24),
  }
}

function validatePe32PlusAmd64(contents) {
  const header = readPeHeader(contents)
  if (header.machine !== 0x8664) {
    throw new Error('the COFF machine is not AMD64')
  }
  if (header.optionalHeaderMagic !== 0x20b) {
    throw new Error('the optional header is not PE32+')
  }
}

function validatePe(contents) {
  const header = readPeHeader(contents)
  if (header.optionalHeaderMagic !== 0x10b && header.optionalHeaderMagic !== 0x20b) {
    throw new Error('the optional header is neither PE32 nor PE32+')
  }
}

function validateElf64(contents, expectedMachine) {
  if (contents.byteLength < 20) {
    throw new Error('the ELF header is truncated')
  }
  if (contents[0] !== 127 || contents[1] !== 69 || contents[2] !== 76 || contents[3] !== 70) {
    throw new Error('the ELF signature is missing')
  }
  if (contents[4] !== 2 || contents[5] !== 1) {
    throw new Error('the ELF header is not little-endian 64-bit')
  }
  if (contents.readUInt16LE(18) !== expectedMachine) {
    throw new Error(`the ELF machine is not ${expectedMachine === 62 ? 'AMD64' : 'AArch64'}`)
  }
}

function validateMachOArm64(contents, expectedFileType = 2) {
  if (contents.byteLength < 32) {
    throw new Error('the Mach-O header is truncated')
  }
  if (contents.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error('the 64-bit Mach-O signature is missing')
  }
  if (contents.readUInt32LE(4) !== 0x0100000c) {
    throw new Error('the Mach-O CPU type is not ARM64')
  }
  if (contents.readUInt32LE(12) !== expectedFileType) {
    throw new Error(
      `the Mach-O file type is not ${expectedFileType === 2 ? 'MH_EXECUTE' : 'MH_DYLIB'}`,
    )
  }
}

function nativeMachine(executablePath) {
  return path.basename(executablePath).toLowerCase().includes('aarch64') ? 183 : 62
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
  if (platform === 'darwin') {
    try {
      validateMachOArm64(contents)
    } catch (error) {
      return `Hyperion is not an ARM64 Mach-O executable: ${error.message}`
    }
    return undefined
  }
  try {
    validateElf64(contents, nativeMachine(executablePath))
  } catch (error) {
    return `${path.basename(executablePath)} is not a native ELF executable: ${error.message}`
  }
  return undefined
}

function checkHyperionPackage(appOutDir, platform = process.platform) {
  if (platform === 'mac') {
    platform = 'darwin'
  }
  if (platform !== 'linux' && platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`Hyperion package validation does not support ${platform}.`)
  }
  const windows = platform === 'win32'
  const mac = platform === 'darwin'
  let executable = 'Hyperion.x86_64'
  let library = 'libSDL3.so.0'
  if (windows) {
    executable = 'Hyperion.exe'
    library = 'SDL3.dll'
  } else if (mac) {
    executable = MAC_EXECUTABLE
    library = MAC_LIBRARY
  }
  const resourceDirectory = mac
    ? path.join(appOutDir, 'Contents', 'Resources', 'hyperion')
    : path.join(appOutDir, 'resources', 'hyperion')
  const executablePath = path.join(resourceDirectory, executable)
  const problems = []
  const required = [executable, library, 'release.json', 'EDITION.txt', 'Data']

  for (const name of required) {
    if (!fs.existsSync(path.join(resourceDirectory, name))) {
      problems.push(`${name} is missing`)
    }
  }
  if (fs.existsSync(path.join(resourceDirectory, 'Game'))) {
    problems.push('Game/ must not be shipped')
  }
  if (fs.existsSync(path.join(resourceDirectory, 'Data'))) {
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
  if (fs.existsSync(libraryPath)) {
    if (windows) {
      try {
        validatePe32PlusAmd64(fs.readFileSync(libraryPath))
      } catch (error) {
        problems.push(`SDL3.dll is not a PE32+ AMD64 library: ${error.message}`)
      }
    } else if (mac) {
      try {
        validateMachOArm64(fs.readFileSync(libraryPath), 6)
      } catch (error) {
        problems.push(`libSDL3.0.dylib is not an ARM64 Mach-O library: ${error.message}`)
      }
    } else {
      try {
        validateElf64(fs.readFileSync(libraryPath), nativeMachine(executablePath))
      } catch (error) {
        problems.push(`${library} is not a native ELF library: ${error.message}`)
      }
    }
  }

  const releasePath = path.join(resourceDirectory, 'release.json')
  if (fs.existsSync(releasePath)) {
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
    if (
      !PUBLIC_PRODUCT_NAMES.has(release.product) ||
      release.gameFilesBundled !== false ||
      typeof release.version !== 'string' ||
      !release.version
    ) {
      problems.push('release.json is not for public Hyperion Shield Zero without game files')
    }
  }

  const plutoBridgePath = path.join(resourceDirectory, ...PLUTO_BRIDGE_RELATIVE.split('/'))
  if (fs.existsSync(plutoBridgePath)) {
    const bridge = fs.lstatSync(plutoBridgePath)
    if (!bridge.isFile() || bridge.isSymbolicLink()) {
      problems.push('Data/pluto/pluto-bridge.exe must be a regular file')
    } else {
      try {
        validatePe(fs.readFileSync(plutoBridgePath))
      } catch (error) {
        problems.push(`pluto-bridge.exe is not a PE32 or PE32+ binary: ${error.message}`)
      }
    }
  }

  if (fs.existsSync(resourceDirectory)) {
    for (const filePath of walk(resourceDirectory)) {
      const relative = path.relative(resourceDirectory, filePath).split(path.sep).join('/')
      const basename = path.posix.basename(relative).toLowerCase()
      if (OFFICIAL_PLUTO_BASENAMES.has(basename)) {
        problems.push(
          `official Pluto payload is forbidden; this file is forbidden anywhere in Hyperion packages: ${filePath}`,
        )
      }
      const publicPlutoFile = PUBLIC_PLUTO_FILES.has(relative)
      if (/^Data\/pluto\//i.test(relative) && !publicPlutoFile) {
        problems.push(`only the public Pluto bridge and BWAPI notices may be shipped: ${filePath}`)
      }
      const allowedNativeBinary =
        (windows && (relative === 'Hyperion.exe' || relative === 'SDL3.dll')) ||
        (mac && (relative === MAC_EXECUTABLE || relative === MAC_LIBRARY)) ||
        relative === PLUTO_BRIDGE_RELATIVE
      if (FORBIDDEN_SUFFIXES.has(path.extname(filePath).toLowerCase()) && !allowedNativeBinary) {
        problems.push(`proprietary or foreign-platform file is forbidden: ${filePath}`)
      }
    }
  }

  if (problems.length) {
    throw new Error(`Hyperion package validation failed: ${problems.join('; ')}`)
  }
}

async function afterPack(context) {
  const platform = context.electronPlatformName ?? process.platform
  // electron-builder's Mac appOutDir contains the product bundle rather than being the bundle itself.
  const appOutDir =
    (platform === 'darwin' || platform === 'mac') && path.extname(context.appOutDir) !== '.app'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productName}.app`)
      : context.appOutDir
  checkHyperionPackage(appOutDir, platform)
}

exports.default = afterPack
exports.afterPack = afterPack
exports.checkHyperionPackage = checkHyperionPackage
exports.validatePe32PlusAmd64 = validatePe32PlusAmd64
exports.validatePe = validatePe
exports.validateMachOArm64 = validateMachOArm64

if (require.main === module) {
  try {
    checkHyperionPackage(process.argv[2], process.argv[3] ?? process.platform)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
