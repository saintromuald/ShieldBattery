import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseInfo } from '../../common/release-center'
import {
  DOWNLOAD_CONNECTION_TIMEOUT_MS,
  DOWNLOAD_INACTIVITY_TIMEOUT_MS,
  downloadReleaseAssets,
  installDownloadedRelease,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_ASSET_BYTES,
  MAX_EXTRACTED_FILE_BYTES,
  MAX_RELEASE_BYTES,
  parseTarListing,
} from './installer'
import {
  installedReleaseExecutable,
  readInstalledRegistry,
  releaseCenterInstallRoot,
  validateInstalledRelease,
} from './storage'
import {
  makeHyperionZip,
  makeMachOArm64,
  makeMacHyperionZip,
  makePe32PlusAmd64,
  makePe32X86,
  makeZip,
  publicHyperionZipEntries,
  publicMacHyperionZipEntries,
  type ZipFixtureEntry,
} from './testing/fixtures'

const execFileAsync = promisify(execFile)
let temporaryDirectory: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-release-installer-test-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function digest(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function archiveRelease(contents: Uint8Array): ReleaseInfo {
  return {
    id: 'github:saintromuald/hyperion-public:1',
    product: 'hyperion',
    tag: 'v1.0.0',
    version: '1.0.0',
    title: 'Hyperion 1.0.0',
    channel: 'stable',
    releaseUrl: 'https://github.com/saintromuald/hyperion-public/releases/tag/v1.0.0',
    source: {
      label: 'GitHub',
      repository: 'saintromuald/hyperion-public',
      url: 'https://github.com/saintromuald/hyperion-public',
    },
    packageKind: 'archive',
    assets: [
      {
        name: 'Hyperion-Shield-Zero-1.0.0-linux-x64.tar.gz',
        url: 'https://github.com/download/Hyperion-Shield-Zero-1.0.0-linux-x64.tar.gz',
        size: contents.byteLength,
        sha256: digest(contents),
      },
    ],
  }
}

function windowsArchiveRelease(
  contents: Uint8Array,
  name = 'Hyperion-Shield-Zero-1.0.0-windows-x64.zip',
): ReleaseInfo {
  const release = archiveRelease(contents)
  release.assets[0].name = name
  release.assets[0].url = `https://github.com/download/${name}`
  return release
}

function plutoSupportZipEntries(bridge: Uint8Array | string = makePe32X86()) {
  return [
    { name: 'Data/pluto/', kind: 'directory' as const },
    { name: 'Data/pluto/pluto-bridge.exe', contents: bridge },
    { name: 'Data/pluto/COPYING.BWAPI', contents: 'BWAPI copying notice' },
    { name: 'Data/pluto/SOURCE.BWAPI.txt', contents: 'BWAPI source notice' },
  ]
}

function macArchiveRelease(contents: Uint8Array): ReleaseInfo {
  const release = windowsArchiveRelease(contents, 'Hyperion-Shield-Zero-1.0.0-mac-arm64.zip')
  return release
}

function macClientRelease(contents: Uint8Array): ReleaseInfo {
  const name = 'HyperShield-13.0.0-arm64-mac.zip'
  return {
    ...archiveRelease(contents),
    product: 'hypershield',
    packageKind: 'macZip',
    assets: [
      {
        name,
        url: `https://github.com/download/${name}`,
        size: contents.byteLength,
        sha256: digest(contents),
      },
    ],
  }
}

async function makeArchive(
  withSymlink = false,
  plutoBridge?: Uint8Array | string,
): Promise<Uint8Array> {
  const input = path.join(temporaryDirectory, withSymlink ? 'bad-input' : 'good-input')
  const packageDirectory = path.join(input, 'package')
  await fs.mkdir(path.join(packageDirectory, 'Data'), { recursive: true })
  await fs.writeFile(path.join(packageDirectory, 'Hyperion.x86_64'), 'native executable', {
    mode: 0o755,
  })
  await fs.writeFile(path.join(packageDirectory, 'libSDL3.so.0'), 'SDL library')
  await fs.writeFile(path.join(packageDirectory, 'Data', 'public.dat'), 'public engine data')
  if (plutoBridge !== undefined) {
    const plutoDirectory = path.join(packageDirectory, 'Data', 'pluto')
    await fs.mkdir(plutoDirectory, { recursive: true })
    await fs.writeFile(path.join(plutoDirectory, 'pluto-bridge.exe'), plutoBridge)
    await fs.writeFile(path.join(plutoDirectory, 'COPYING.BWAPI'), 'BWAPI copying notice')
    await fs.writeFile(path.join(plutoDirectory, 'SOURCE.BWAPI.txt'), 'BWAPI source notice')
  }
  if (withSymlink) {
    await fs.symlink('Hyperion.x86_64', path.join(packageDirectory, 'linked-executable'))
  }
  const archivePath = path.join(temporaryDirectory, withSymlink ? 'bad.tar.gz' : 'good.tar.gz')
  await execFileAsync('tar', ['-czf', archivePath, '-C', input, '.'])
  return fs.readFile(archivePath)
}

describe('release downloads', () => {
  it('rejects a mismatching published SHA-256 digest', async () => {
    const release = archiveRelease(new Uint8Array([1, 2, 3]))
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new Uint8Array([9, 8, 7]), { status: 200 }))
    await expect(
      downloadReleaseAssets(
        release,
        path.join(temporaryDirectory, 'downloads'),
        '1.0.0',
        fetchImpl,
        () => {},
      ),
    ).rejects.toThrow('SHA-256 verification failed')
  })

  it('reports aggregate byte progress for multi-file raw packages', async () => {
    const first = new TextEncoder().encode('abc')
    const second = new TextEncoder().encode('defgh')
    const release: ReleaseInfo = {
      ...archiveRelease(first),
      packageKind: 'raw',
      assets: [
        {
          name: 'Hyperion.x86_64',
          url: 'https://github.com/download/executable',
          size: first.length,
          sha256: digest(first),
        },
        {
          name: 'libSDL3.so.0',
          url: 'https://github.com/download/library',
          size: second.length,
          sha256: digest(second),
        },
      ],
    }
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(first, { status: 200 }))
      .mockResolvedValueOnce(new Response(second, { status: 200 }))
    const progress = vi.fn()
    const downloaded = await downloadReleaseAssets(
      release,
      path.join(temporaryDirectory, 'downloads'),
      '1.0.0',
      fetchImpl,
      progress,
    )
    expect(downloaded).toHaveLength(2)
    expect(progress).toHaveBeenLastCalledWith({ bytesTransferred: 8, totalBytes: 8 })
  })

  it('rejects an untrusted asset origin before fetching', async () => {
    const release = archiveRelease(new Uint8Array([1, 2, 3]))
    release.assets[0].url = 'https://example.test/asset'
    const fetchImpl = vi.fn<typeof globalThis.fetch>()
    await expect(
      downloadReleaseAssets(
        release,
        path.join(temporaryDirectory, 'downloads'),
        '1.0.0',
        fetchImpl,
        () => {},
      ),
    ).rejects.toThrow('untrusted origin')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['shorter', new Uint8Array([1, 2])],
    ['longer', new Uint8Array([1, 2, 3, 4])],
  ])('rejects a $name body instead of trusting its digest', async (_name, body) => {
    const release = archiveRelease(new Uint8Array([1, 2, 3]))
    await expect(
      downloadReleaseAssets(
        release,
        path.join(temporaryDirectory, 'downloads'),
        '1.0.0',
        vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
        () => {},
      ),
    ).rejects.toThrow('advertised')
  })

  it('writes every byte when FileHandle.write performs partial writes', async () => {
    const contents = new TextEncoder().encode('all bytes must reach disk')
    const originalOpen = fs.open.bind(fs)
    const write = vi.fn()
    vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await originalOpen(args[0], args[1], args[2])
      const originalWrite = handle.write.bind(handle)
      write.mockImplementation(async (buffer: Buffer, offset: number, length: number) =>
        originalWrite(buffer, offset, Math.min(length, 2)),
      )
      Object.defineProperty(handle, 'write', { value: write })
      return handle
    })

    const downloaded = await downloadReleaseAssets(
      archiveRelease(contents),
      path.join(temporaryDirectory, 'downloads'),
      '1.0.0',
      vi.fn().mockResolvedValue(new Response(contents, { status: 200 })),
      () => {},
    )

    await expect(fs.readFile(downloaded[0].path)).resolves.toEqual(Buffer.from(contents))
    expect(write.mock.calls.map(call => call[1])).toEqual(
      Array.from({ length: Math.ceil(contents.byteLength / 2) }, (_, index) => index * 2),
    )
  })

  it('rejects per-file and aggregate size caps before starting a request', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>()
    const perFile = archiveRelease(new Uint8Array([1]))
    perFile.assets[0].size = MAX_ASSET_BYTES + 1
    await expect(
      downloadReleaseAssets(
        perFile,
        path.join(temporaryDirectory, 'downloads'),
        '1.0.0',
        fetchImpl,
        () => {},
      ),
    ).rejects.toThrow('per-file download limit')

    const aggregate = archiveRelease(new Uint8Array([1]))
    aggregate.assets = Array.from({ length: 3 }, (_, index) => ({
      ...aggregate.assets[0],
      name: `asset-${index}`,
      size: MAX_ASSET_BYTES,
    }))
    await expect(
      downloadReleaseAssets(
        aggregate,
        path.join(temporaryDirectory, 'downloads'),
        '1.0.0',
        fetchImpl,
        () => {},
      ),
    ).rejects.toThrow('total download limit')
    expect(MAX_RELEASE_BYTES).toBe(2 * MAX_ASSET_BYTES)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows a caller-specific larger asset without changing the default cap', async () => {
    const release = archiveRelease(new Uint8Array([1]))
    release.assets[0].size = MAX_ASSET_BYTES + 1
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503, statusText: 'Unavailable' }))

    await expect(
      downloadReleaseAssets(
        release,
        path.join(temporaryDirectory, 'downloads'),
        '1.0.0',
        fetchImpl,
        () => {},
        { maxAssetBytes: MAX_ASSET_BYTES + 1 },
      ),
    ).rejects.toThrow('GitHub returned 503 Unavailable')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(MAX_ASSET_BYTES).toBe(1024 * 1024 * 1024)
  })

  it('times out a stalled connection and aborts its request', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn<typeof globalThis.fetch>((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const result = downloadReleaseAssets(
      archiveRelease(new Uint8Array([1, 2, 3])),
      path.join(temporaryDirectory, 'downloads'),
      '1.0.0',
      fetchImpl,
      () => {},
    )
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    const advancing = vi.advanceTimersByTimeAsync(DOWNLOAD_CONNECTION_TIMEOUT_MS)
    await expect(result).rejects.toThrow('Connection')
    await advancing
    expect(signal?.aborted).toBe(true)
  })

  it('times out a response that stops producing body data', async () => {
    vi.useFakeTimers()
    const contents = new Uint8Array([1, 2, 3])
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(contents)
      },
    })
    const progress = vi.fn()
    const result = downloadReleaseAssets(
      archiveRelease(contents),
      path.join(temporaryDirectory, 'downloads'),
      '1.0.0',
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      progress,
    )
    await vi.waitFor(() => expect(progress).toHaveBeenCalled())
    const advancing = vi.advanceTimersByTimeAsync(DOWNLOAD_INACTIVITY_TIMEOUT_MS)
    await expect(result).rejects.toThrow('received no data')
    await advancing
  })
})

describe.skipIf(process.platform !== 'linux')('safe tar extraction', () => {
  it.each([
    ['parent traversal', '-rw-r--r-- 0/0 1 2026-01-01 00:00 "../outside"', 'parent-directory'],
    ['absolute paths', '-rw-r--r-- 0/0 1 2026-01-01 00:00 "/etc/passwd"', 'absolute path'],
    [
      'symbolic links',
      'lrwxrwxrwx 0/0 1 2026-01-01 00:00 "link" -> "target"',
      'links and special files',
    ],
    [
      'hard links',
      'hrw-r--r-- 0/0 1 2026-01-01 00:00 "link" link to "target"',
      'links and special files',
    ],
    ['Game data', '-rw-r--r-- 0/0 1 2026-01-01 00:00 "./Game/starcraft.mpq"', 'forbidden'],
    ['Zero content', '-rw-r--r-- 0/0 1 2026-01-01 00:00 "./Zero/engine"', 'forbidden'],
  ])('rejects %s before extraction', (_name, listing, message) => {
    expect(() => parseTarListing(listing)).toThrow(message)
  })

  it.each(['pluto.dll', 'pluto_infer.exe', 'pluto_weights.bin', 'unexpected.exe'])(
    'rejects Data/pluto/%s in a Linux archive',
    name => {
      const listing = `-rw-r--r-- 0/0 1 2026-01-01 00:00 ${JSON.stringify(`package/Data/pluto/${name}`)}`
      expect(() => parseTarListing(listing)).toThrow('forbidden')
    },
  )

  it('enforces archive depth, entry, file-size, and cumulative-size limits', () => {
    const fileLine = (name: string, size = 1) =>
      `-rw-r--r-- 0/0 ${size} 2026-01-01 00:00 ${JSON.stringify(name)}`
    expect(() => parseTarListing(fileLine(`${'deep/'.repeat(33)}file`))).toThrow('depth limit')
    expect(() => parseTarListing(fileLine('large-file', MAX_EXTRACTED_FILE_BYTES + 1))).toThrow(
      'excessive file size',
    )
    expect(() =>
      parseTarListing(
        Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, index) =>
          fileLine(`file-${index}`),
        ).join('\n'),
      ),
    ).toThrow('entry limit')
    expect(() =>
      parseTarListing(
        Array.from({ length: 5 }, (_, index) =>
          fileLine(`file-${index}`, MAX_EXTRACTED_FILE_BYTES),
        ).join('\n'),
      ),
    ).toThrow('uncompressed size limit')
    expect(MAX_ARCHIVE_UNCOMPRESSED_BYTES).toBe(4 * MAX_EXTRACTED_FILE_BYTES)
  })

  it('installs a valid archive atomically and marks its executable runnable', async () => {
    const contents = await makeArchive()
    const release = archiveRelease(contents)
    const onDownloaded = vi.fn()
    const record = await installDownloadedRelease({
      userDataPath: path.join(temporaryDirectory, 'user-data'),
      appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
      product: 'hyperion',
      release,
      platform: 'linux',
      architecture: 'x64',
      clientVersion: '1.0.0',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(Uint8Array.from(contents).buffer, { status: 200 })),
      onDownloaded,
    })

    const executablePath = installedReleaseExecutable(
      path.join(temporaryDirectory, 'user-data'),
      'hyperion',
      record,
    )
    expect(onDownloaded).toHaveBeenCalledOnce()
    expect(record.executablePath).toBe(path.join('package', 'Hyperion.x86_64'))
    await expect(fs.readFile(executablePath, 'utf8')).resolves.toBe('native executable')
    await expect(fs.access(executablePath, fsConstants.X_OK)).resolves.toBeUndefined()
    await expect(
      fs.readFile(path.join(path.dirname(executablePath), 'Data', 'public.dat'), 'utf8'),
    ).resolves.toBe('public engine data')
    const entries = await fs.readdir(
      releaseCenterInstallRoot(path.join(temporaryDirectory, 'user-data'), 'hyperion'),
    )
    expect(entries).toEqual([record.directoryName])
  })

  it('installs the PE32 Pluto bridge and BWAPI notices but rejects an invalid bridge', async () => {
    const contents = await makeArchive(false, makePe32X86())
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const record = await installDownloadedRelease({
      userDataPath,
      appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
      product: 'hyperion',
      release: archiveRelease(contents),
      platform: 'linux',
      architecture: 'x64',
      clientVersion: '1.0.0',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(Uint8Array.from(contents).buffer, { status: 200 })),
    })
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    const plutoDirectory = path.join(path.dirname(executablePath), 'Data', 'pluto')
    await expect(fs.readFile(path.join(plutoDirectory, 'pluto-bridge.exe'))).resolves.toEqual(
      makePe32X86(),
    )
    await expect(fs.readFile(path.join(plutoDirectory, 'COPYING.BWAPI'), 'utf8')).resolves.toBe(
      'BWAPI copying notice',
    )
    await expect(fs.readFile(path.join(plutoDirectory, 'SOURCE.BWAPI.txt'), 'utf8')).resolves.toBe(
      'BWAPI source notice',
    )

    const invalidContents = await makeArchive(false, 'not a PE file')
    await expect(
      installDownloadedRelease({
        userDataPath: path.join(temporaryDirectory, 'invalid-user-data'),
        appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
        product: 'hyperion',
        release: archiveRelease(invalidContents),
        platform: 'linux',
        architecture: 'x64',
        clientVersion: '1.0.0',
        fetchImpl: vi
          .fn()
          .mockResolvedValue(
            new Response(Uint8Array.from(invalidContents).buffer, { status: 200 }),
          ),
      }),
    ).rejects.toThrow('invalid Pluto AI bridge')
  })

  it('rejects archives containing symlinks without publishing an install', async () => {
    const contents = await makeArchive(true)
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    await expect(
      installDownloadedRelease({
        userDataPath,
        appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
        product: 'hyperion',
        release: archiveRelease(contents),
        platform: 'linux',
        architecture: 'x64',
        clientVersion: '1.0.0',
        fetchImpl: vi
          .fn()
          .mockResolvedValue(new Response(Uint8Array.from(contents).buffer, { status: 200 })),
      }),
    ).rejects.toThrow('links and special files')
    await expect(readInstalledRegistry(userDataPath)).resolves.toEqual({
      hyperion: [],
      hypershield: [],
    })
    await expect(fs.readdir(releaseCenterInstallRoot(userDataPath, 'hyperion'))).resolves.toEqual(
      [],
    )
  })
})

describe('secure Windows Hyperion ZIP installation', () => {
  async function installWindows(contents: Uint8Array) {
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const release = windowsArchiveRelease(contents)
    const record = await installDownloadedRelease({
      userDataPath,
      appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
      product: 'hyperion',
      release,
      platform: 'win32',
      architecture: 'x64',
      clientVersion: '1.0.0',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(Uint8Array.from(contents).buffer, { status: 200 })),
    })
    return { record, userDataPath }
  }

  it('installs exact-root AMD64 binaries, public metadata, and Data without bundling game files', async () => {
    const { record, userDataPath } = await installWindows(makeHyperionZip())

    expect(record).toMatchObject({
      executablePath: 'Hyperion.exe',
      packageKind: 'archive',
      platform: 'win32',
      architecture: 'x64',
    })
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    await expect(fs.readFile(executablePath)).resolves.toEqual(makePe32PlusAmd64())
    await expect(
      fs.readFile(path.join(path.dirname(executablePath), 'Data', 'public.dat'), 'utf8'),
    ).resolves.toBe('public engine data')
    await expect(
      validateInstalledRelease(userDataPath, 'hyperion', record, 'win32', 'x64'),
    ).resolves.toBe(true)
    await expect(
      validateInstalledRelease(userDataPath, 'hyperion', record, 'linux', 'x64'),
    ).resolves.toBe(false)
  })

  it('installs the PE32 Pluto bridge and BWAPI notices but rejects an invalid bridge', async () => {
    const entries = [...publicHyperionZipEntries(), ...plutoSupportZipEntries()]
    const { record, userDataPath } = await installWindows(makeHyperionZip(entries))
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    const plutoDirectory = path.join(path.dirname(executablePath), 'Data', 'pluto')
    await expect(fs.readFile(path.join(plutoDirectory, 'pluto-bridge.exe'))).resolves.toEqual(
      makePe32X86(),
    )
    await expect(fs.readFile(path.join(plutoDirectory, 'COPYING.BWAPI'), 'utf8')).resolves.toBe(
      'BWAPI copying notice',
    )
    await expect(fs.readFile(path.join(plutoDirectory, 'SOURCE.BWAPI.txt'), 'utf8')).resolves.toBe(
      'BWAPI source notice',
    )

    const invalidEntries = [
      ...publicHyperionZipEntries(),
      ...plutoSupportZipEntries('not a PE file'),
    ]
    await expect(installWindows(makeHyperionZip(invalidEntries))).rejects.toThrow(
      'invalid Pluto AI bridge',
    )
  })

  it.each(['Hyperion Shield', 'HyperShield Shield'])(
    'continues to install legacy %s metadata',
    async product => {
      const entries = publicHyperionZipEntries().map(entry =>
        entry.name === 'release.json'
          ? {
              ...entry,
              contents: JSON.stringify({ product, version: '1.0.0', gameFilesBundled: false }),
            }
          : entry,
      )
      const { record } = await installWindows(makeHyperionZip(entries))
      expect(record.executablePath).toBe('Hyperion.exe')
    },
  )

  it('requires a published SHA-256 before downloading a Windows ZIP', async () => {
    const contents = makeHyperionZip()
    const release = windowsArchiveRelease(contents)
    release.assets[0].sha256 = undefined
    const fetchImpl = vi.fn()

    await expect(
      installDownloadedRelease({
        userDataPath: path.join(temporaryDirectory, 'user-data'),
        appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
        product: 'hyperion',
        release,
        platform: 'win32',
        architecture: 'x64',
        clientVersion: '1.0.0',
        fetchImpl,
      }),
    ).rejects.toThrow('published SHA-256')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['Hyperion.exe', 'SDL3.dll'])('rejects an invalid PE32+ AMD64 %s', async name => {
    const entries = publicHyperionZipEntries()
    const binary = entries.find(entry => entry.name === name)!
    binary.contents = Buffer.from('not a native Windows binary')

    await expect(installWindows(makeHyperionZip(entries))).rejects.toThrow('invalid native binary')
  })

  it.each([
    [
      'parent traversal',
      [...publicHyperionZipEntries(), { name: '../outside.dat', contents: 'outside' }],
      'parent-directory',
    ],
    [
      'symbolic links',
      [
        ...publicHyperionZipEntries(),
        { name: 'Data/link', contents: 'public.dat', kind: 'symlink' as const },
      ],
      'links are forbidden',
    ],
    [
      'extra executables',
      [...publicHyperionZipEntries(), { name: 'Data/helper.exe', contents: makePe32PlusAmd64() }],
      'forbidden executable',
    ],
    [
      'extra libraries',
      [...publicHyperionZipEntries(), { name: 'Other.dll', contents: makePe32PlusAmd64() }],
      'forbidden executable',
    ],
    [
      'proprietary game data',
      [...publicHyperionZipEntries(), { name: 'Data/starcraft.mpq', contents: 'game data' }],
      'forbidden',
    ],
    [
      'out-of-place pluto.dll',
      [...publicHyperionZipEntries(), { name: 'docs/pluto.dll', contents: 'official payload' }],
      'official Pluto payload',
    ],
    [
      'out-of-place pluto_infer.exe',
      [
        ...publicHyperionZipEntries(),
        { name: 'Data/other/pluto_infer.exe', contents: 'official payload' },
      ],
      'official Pluto payload',
    ],
    [
      'out-of-place pluto_weights.bin',
      [...publicHyperionZipEntries(), { name: 'pluto_weights.bin', contents: 'official payload' }],
      'official Pluto payload',
    ],
    [
      'excessive path depth',
      [...publicHyperionZipEntries(), { name: `${'deep/'.repeat(33)}file.dat`, contents: 'depth' }],
      'depth limit',
    ],
    [
      'wrapped root files',
      publicHyperionZipEntries().map(entry => ({ ...entry, name: `package/${entry.name}` })),
      'forbidden executable',
    ],
  ])('rejects %s without publishing an install', async (_name, entries, message) => {
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    await expect(installWindows(makeHyperionZip(entries))).rejects.toThrow(message)
    await expect(fs.readdir(releaseCenterInstallRoot(userDataPath, 'hyperion'))).resolves.toEqual(
      [],
    )
  })

  it.each(['pluto.dll', 'pluto_infer.exe', 'pluto_weights.bin'])(
    'rejects official Pluto payload %s without publishing an install',
    async name => {
      const userDataPath = path.join(temporaryDirectory, 'user-data')
      const entries = [
        ...publicHyperionZipEntries(),
        { name: `Data/pluto/${name}`, contents: 'official payload' },
      ]
      await expect(installWindows(makeHyperionZip(entries))).rejects.toThrow(
        'forbidden official Pluto payload',
      )
      await expect(fs.readdir(releaseCenterInstallRoot(userDataPath, 'hyperion'))).resolves.toEqual(
        [],
      )
    },
  )

  it('requires Data and release metadata at the ZIP root', async () => {
    const withoutData = publicHyperionZipEntries().filter(
      entry => entry.name !== 'Data/' && !entry.name.startsWith('Data/'),
    )
    await expect(installWindows(makeHyperionZip(withoutData))).rejects.toThrow(
      'must include Data at its root',
    )

    const withoutMetadata = publicHyperionZipEntries().filter(
      entry => entry.name !== 'release.json',
    )
    await expect(installWindows(makeHyperionZip(withoutMetadata))).rejects.toThrow(
      'must include release.json at its root',
    )
  })

  it('enforces ZIP entry, per-file, and cumulative uncompressed size limits', async () => {
    const tooMany = makeZip(
      Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, index) => ({
        name: `file-${index}.dat`,
      })),
    )
    await expect(installWindows(tooMany)).rejects.toThrow('entry limit')

    const oversized = makeHyperionZip([
      ...publicHyperionZipEntries(),
      {
        name: 'oversized.dat',
        advertisedSize: MAX_EXTRACTED_FILE_BYTES + 1,
      },
    ])
    await expect(installWindows(oversized)).rejects.toThrow('excessive file size')

    const excessiveTotal = makeZip(
      Array.from({ length: 5 }, (_, index) => ({
        name: `large-${index}.dat`,
        advertisedSize: MAX_EXTRACTED_FILE_BYTES,
      })),
    )
    await expect(installWindows(excessiveTotal)).rejects.toThrow('uncompressed size limit')
  })
})

describe('secure macOS package installation', () => {
  async function installMacHyperion(contents: Uint8Array) {
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const record = await installDownloadedRelease({
      userDataPath,
      appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
      product: 'hyperion',
      release: macArchiveRelease(contents),
      platform: 'darwin',
      architecture: 'arm64',
      clientVersion: '1.0.0',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(Uint8Array.from(contents).buffer, { status: 200 })),
    })
    return { record, userDataPath }
  }

  function macClientEntries(): ZipFixtureEntry[] {
    return [
      {
        name: 'HyperShield.app/Contents/MacOS/HyperShield',
        contents: makeMachOArm64(),
        executable: true,
      },
      {
        name: 'HyperShield.app/Contents/Info.plist',
        contents: '<plist><dict/></plist>',
      },
      {
        name: 'HyperShield.app/Contents/Resources/app.asar',
        contents: 'packaged app fixture',
      },
      {
        name: 'HyperShield.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
        contents: makeMachOArm64('dynamicLibrary'),
        executable: true,
      },
      {
        name: 'HyperShield.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
        contents: 'A',
        kind: 'symlink',
      },
      {
        name: 'HyperShield.app/Contents/Frameworks/Electron Framework.framework/Electron Framework',
        contents: 'Versions/Current/Electron Framework',
        kind: 'symlink',
      },
    ]
  }

  it('stages the wrapped Hyperion.app with Data beside it and validates both Mach-O files', async () => {
    const { record, userDataPath } = await installMacHyperion(makeMacHyperionZip())
    expect(record).toMatchObject({
      executablePath: path.join('package', 'Hyperion.app', 'Contents', 'MacOS', 'Hyperion'),
      packageKind: 'archive',
      platform: 'darwin',
      architecture: 'arm64',
    })
    const executablePath = installedReleaseExecutable(userDataPath, 'hyperion', record)
    await expect(fs.access(executablePath, fsConstants.X_OK)).resolves.toBeUndefined()
    await expect(
      fs.readFile(
        path.join(
          userDataPath,
          'release-center',
          'installs',
          'hyperion',
          record.directoryName,
          'package',
          'Data',
          'public.dat',
        ),
        'utf8',
      ),
    ).resolves.toBe('public engine data')
    await expect(
      validateInstalledRelease(userDataPath, 'hyperion', record, 'darwin', 'arm64'),
    ).resolves.toBe(true)
  })

  it('rejects non-ARM64 engines and official Pluto payloads while allowing our exact bridge', async () => {
    const wrongArchitecture = makeMachOArm64()
    wrongArchitecture.writeUInt32LE(7, 4)
    await expect(
      installMacHyperion(makeMacHyperionZip(publicMacHyperionZipEntries(wrongArchitecture))),
    ).rejects.toThrow('CPU type is not ARM64')

    const withBridge = makeMacHyperionZip([
      ...publicMacHyperionZipEntries(),
      {
        name: 'package/Data/pluto/pluto-bridge.exe',
        contents: makePe32PlusAmd64(),
      },
      { name: 'package/Data/pluto/COPYING.BWAPI', contents: 'BWAPI license' },
      { name: 'package/Data/pluto/SOURCE.BWAPI.txt', contents: 'BWAPI source notice' },
    ])
    await expect(installMacHyperion(withBridge)).resolves.toMatchObject({
      record: { platform: 'darwin' },
    })

    const officialPayload = makeMacHyperionZip([
      ...publicMacHyperionZipEntries(),
      { name: 'package/Data/pluto/official-payload.zip', contents: 'official Pluto payload' },
    ])
    await expect(installMacHyperion(officialPayload)).rejects.toThrow(
      'only our bridge and BWAPI notices',
    )
  })

  it('stages HyperShield.app with safe framework links and executable permissions', async () => {
    const contents = makeZip(macClientEntries())
    const userDataPath = path.join(temporaryDirectory, 'user-data')
    const record = await installDownloadedRelease({
      userDataPath,
      appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
      product: 'hypershield',
      release: macClientRelease(contents),
      platform: 'darwin',
      architecture: 'arm64',
      clientVersion: '12.3.13',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(Uint8Array.from(contents).buffer, { status: 200 })),
    })

    expect(record).toMatchObject({
      executablePath: path.join('HyperShield.app', 'Contents', 'MacOS', 'HyperShield'),
      packageKind: 'macZip',
    })
    const executablePath = installedReleaseExecutable(userDataPath, 'hypershield', record)
    await expect(fs.access(executablePath, fsConstants.X_OK)).resolves.toBeUndefined()
    const installDirectory = path.dirname(path.dirname(path.dirname(path.dirname(executablePath))))
    const frameworkLink = path.join(
      installDirectory,
      'HyperShield.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    )
    expect((await fs.lstat(frameworkLink)).isSymbolicLink()).toBe(true)
    await expect(fs.access(frameworkLink, fsConstants.X_OK)).resolves.toBeUndefined()
    await expect(
      validateInstalledRelease(userDataPath, 'hypershield', record, 'darwin', 'arm64'),
    ).resolves.toBe(true)

    await fs.rm(path.join(installDirectory, 'HyperShield.app', 'Contents', 'Resources', 'app.asar'))
    await expect(
      validateInstalledRelease(userDataPath, 'hypershield', record, 'darwin', 'arm64'),
    ).resolves.toBe(false)
  })

  it('rejects escaping framework links and files outside HyperShield.app', async () => {
    const escaping = makeZip([
      ...macClientEntries(),
      {
        name: 'HyperShield.app/Contents/Frameworks/escape',
        contents: '../../../../outside',
        kind: 'symlink',
      },
    ])
    await expect(
      installDownloadedRelease({
        userDataPath: path.join(temporaryDirectory, 'escape-user-data'),
        appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
        product: 'hypershield',
        release: macClientRelease(escaping),
        platform: 'darwin',
        architecture: 'arm64',
        clientVersion: '12.3.13',
        fetchImpl: vi
          .fn()
          .mockResolvedValue(new Response(Uint8Array.from(escaping).buffer, { status: 200 })),
      }),
    ).rejects.toThrow('link escapes')

    const outside = makeZip([
      ...macClientEntries(),
      { name: 'official-payload.exe', contents: makePe32PlusAmd64() },
    ])
    await expect(
      installDownloadedRelease({
        userDataPath: path.join(temporaryDirectory, 'outside-user-data'),
        appPath: path.join(temporaryDirectory, 'resources', 'app.asar'),
        product: 'hypershield',
        release: macClientRelease(outside),
        platform: 'darwin',
        architecture: 'arm64',
        clientVersion: '12.3.13',
        fetchImpl: vi
          .fn()
          .mockResolvedValue(new Response(Uint8Array.from(outside).buffer, { status: 200 })),
      }),
    ).rejects.toThrow('outside HyperShield.app')
  })
})
