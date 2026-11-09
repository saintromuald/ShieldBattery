/* eslint-disable eslint-core/camelcase */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_REQUEST_TIMEOUT_MS,
  fetchGitHubReleasePages,
  fetchReleaseCatalog,
  type GitHubRelease,
  type GitHubReleaseAsset,
  normalizeReleaseVersion,
  RELEASE_SOURCES,
  toReleaseInfo,
} from './catalog'

const originalToken = process.env.GITHUB_TOKEN

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN
  } else {
    process.env.GITHUB_TOKEN = originalToken
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function asset(name: string, digest?: string): GitHubReleaseAsset {
  return {
    name,
    browser_download_url: `https://github.com/saintromuald/hyperion-public/releases/download/test/${name}`,
    size: 123,
    digest,
  }
}

function release(id: number, overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    id,
    tag_name: `v${id}.0.0`,
    name: `Hyperion ${id}`,
    body: 'release notes',
    draft: false,
    prerelease: false,
    published_at: `2026-01-${String(id).padStart(2, '0')}T00:00:00Z`,
    html_url: `https://github.com/saintromuald/hyperion-public/releases/tag/v${id}.0.0`,
    assets: [asset('Hyperion.x86_64', `sha256:${'a'.repeat(64)}`), asset('libSDL3.so.0')],
    ...overrides,
  }
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('GitHub release catalogs', () => {
  it('paginates Link next, sends API headers, includes prereleases, and skips drafts and duplicates', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    const first = release(1)
    const second = release(2, { prerelease: true, tag_name: 'v2.0.0-beta' })
    const draft = release(3, { draft: true })
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse([first, draft], {
          Link: '<https://api.github.com/repos/saintromuald/hyperion-public/releases?per_page=100&page=2>; rel="next", <https://api.github.com/example>; rel="last"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([first, second]))

    const catalog = await fetchReleaseCatalog('hyperion', '12.3.6', 'linux', 'x64', fetchImpl)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toContain('releases?per_page=100&page=1')
    expect(fetchImpl.mock.calls[1][0]).toContain('per_page=100&page=2')
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer test-token',
      'User-Agent': 'HyperShield/12.3.6',
    })
    expect(catalog.map(item => item.id)).toEqual([
      'github:saintromuald/hyperion-public:2',
      'github:saintromuald/hyperion-public:1',
    ])
    expect(catalog.map(item => item.channel)).toEqual(['prerelease', 'stable'])
    expect(catalog[1].packageKind).toBe('raw')
    expect(catalog[1].assets[0].sha256).toBe('a'.repeat(64))
    expect(catalog[1].version).toBe('1.0.0')
  })

  it('returns a clear HTTP error and rejects cyclic pagination', async () => {
    const source = RELEASE_SOURCES.hyperion[0]
    await expect(
      fetchGitHubReleasePages(
        source,
        '1.0.0',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'X-RateLimit-Remaining': '0' },
          }),
        ),
      ),
    ).rejects.toThrow('rate limited: API rate limit exceeded')

    const url = `${source.apiUrl}/releases?per_page=100&page=1`
    await expect(
      fetchGitHubReleasePages(
        source,
        '1.0.0',
        vi.fn().mockResolvedValue(jsonResponse([], { Link: `<${url}>; rel="next"` })),
      ),
    ).rejects.toThrow('cyclic pagination')
  })

  it('aborts a catalog request that never completes', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn<typeof globalThis.fetch>((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const result = fetchGitHubReleasePages(RELEASE_SOURCES.hyperion[0], '1.0.0', fetchImpl)
    const advancing = vi.advanceTimersByTimeAsync(CATALOG_REQUEST_TIMEOUT_MS)
    await expect(result).rejects.toThrow('timed out')
    await advancing
    expect(signal?.aborted).toBe(true)
  })
})

describe('Linux package selection', () => {
  it('normalizes product-specific tags into readable versions', () => {
    expect(normalizeReleaseVersion('hyperion-shield-v0.7.1-beta')).toBe('0.7.1-beta')
    expect(normalizeReleaseVersion('HyperShield-v12.4.0-rc.1')).toBe('12.4.0-rc.1')
    expect(normalizeReleaseVersion('Hyperion-v0.8.0')).toBe('0.8.0')
    expect(normalizeReleaseVersion('v0.7.1-remastered')).toBe('0.7.1-remastered')
  })

  it('requires both raw Hyperion files but still returns unavailable releases', () => {
    const result = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, { assets: [asset('Hyperion.x86_64')] }),
      'linux',
      'x64',
    )
    expect(result).toMatchObject({
      packageKind: 'none',
      assets: [],
    })
    expect(result?.unavailableReason).toContain('Linux x64')
  })

  it('selects arm64 raw assets and future Shield archives by architecture', () => {
    const armRaw = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, {
        assets: [asset('Hyperion.aarch64'), asset('libSDL3.so.0'), asset('Hyperion.x86_64')],
      }),
      'linux',
      'arm64',
    )
    expect(armRaw?.packageKind).toBe('raw')
    expect(armRaw?.assets.map(item => item.name)).toEqual(['Hyperion.aarch64', 'libSDL3.so.0'])

    const archive = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(2, {
        assets: [
          asset('Hyperion-Shield-2.0-linux-arm64.tar.gz'),
          asset('Hyperion-Shield-2.0-linux-x64.tar.gz'),
        ],
      }),
      'linux',
      'arm64',
    )
    expect(archive?.packageKind).toBe('archive')
    expect(archive?.assets.map(item => item.name)).toEqual([
      'Hyperion-Shield-2.0-linux-arm64.tar.gz',
    ])
  })

  it('never selects Zero packages and prefers a public Shield archive over raw files', () => {
    const zeroOnly = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, {
        assets: [asset('Hyperion-Zero-1.0-linux-x64.tar.gz')],
      }),
      'linux',
      'x64',
    )
    expect(zeroOnly?.packageKind).toBe('none')

    const zeroRaw = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, { name: 'Hyperion Zero' }),
      'linux',
      'x64',
    )
    expect(zeroRaw?.packageKind).toBe('none')

    const archive = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, {
        assets: [
          asset('Hyperion-Shield-1.0-linux-x64.tar.gz'),
          asset('Hyperion.x86_64'),
          asset('libSDL3.so.0'),
        ],
      }),
      'linux',
      'x64',
    )
    expect(archive?.packageKind).toBe('archive')
    expect(archive?.assets).toHaveLength(1)
  })

  it('selects only matching HyperShield AppImages', () => {
    const result = toReleaseInfo(
      'hypershield',
      RELEASE_SOURCES.hypershield[0],
      release(1, {
        assets: [
          asset('HyperShield-1.0.0-x86_64.AppImage'),
          asset('HyperShield-1.0.0-arm64.AppImage'),
          asset('HyperShield-Zero-1.0.0-x86_64.AppImage'),
        ],
      }),
      'linux',
      'x64',
    )
    expect(result?.packageKind).toBe('appImage')
    expect(result?.assets.map(item => item.name)).toEqual(['HyperShield-1.0.0-x86_64.AppImage'])
  })

  it('marks unsupported platforms and malformed published digests unavailable', () => {
    const windows = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1),
      'win32',
      'x64',
    )
    expect(windows?.packageKind).toBe('none')
    expect(windows?.unavailableReason).toContain('Windows x64')

    const badDigest = toReleaseInfo(
      'hypershield',
      RELEASE_SOURCES.hypershield[0],
      release(1, {
        assets: [asset('HyperShield-1.0.0-x86_64.AppImage', 'sha512:abcd')],
      }),
      'linux',
      'x64',
    )
    expect(badDigest?.packageKind).toBe('none')
    expect(badDigest?.unavailableReason).toContain('digest')
  })
})

describe('Windows package selection', () => {
  it('prefers the Windows x64 Shield ZIP and tolerates the generic Shield ZIP', () => {
    const specific = 'Hyperion-Shield-1.0.0-windows-x64.zip'
    const generic = 'Hyperion-Shield-1.0.0.zip'
    const result = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, {
        assets: [
          asset(generic, `sha256:${'a'.repeat(64)}`),
          asset('Hyperion-Shield-1.0.0-mac.zip', `sha256:${'c'.repeat(64)}`),
          asset('Hyperion-Shield-Zero-1.0.0.zip', `sha256:${'d'.repeat(64)}`),
          asset(specific, `sha256:${'b'.repeat(64)}`),
        ],
      }),
      'win32',
      'x64',
    )
    expect(result).toMatchObject({ packageKind: 'archive' })
    expect(result?.assets.map(item => item.name)).toEqual([specific])
    expect(result?.assets[0].sha256).toBe('b'.repeat(64))

    const genericResult = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, { assets: [asset(generic, `sha256:${'a'.repeat(64)}`)] }),
      'win32',
      'x64',
    )
    expect(genericResult).toMatchObject({ packageKind: 'archive' })
    expect(genericResult?.assets.map(item => item.name)).toEqual([generic])
  })

  it('requires a published SHA-256 and Windows x64', () => {
    const generic = 'Hyperion-Shield-1.0.0.zip'
    const missingDigest = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, { assets: [asset(generic)] }),
      'win32',
      'x64',
    )
    expect(missingDigest?.packageKind).toBe('none')
    expect(missingDigest?.unavailableReason).toContain('SHA-256')

    const arm64 = toReleaseInfo(
      'hyperion',
      RELEASE_SOURCES.hyperion[0],
      release(1, { assets: [asset(generic, `sha256:${'a'.repeat(64)}`)] }),
      'win32',
      'arm64',
    )
    expect(arm64?.packageKind).toBe('none')
    expect(arm64?.unavailableReason).toContain('arm64')
  })

  it('keeps HyperShield client updates off the AppImage staging path on Windows', () => {
    const result = toReleaseInfo(
      'hypershield',
      RELEASE_SOURCES.hypershield[0],
      release(1, {
        assets: [asset('HyperShield-1.0.0-x86_64.AppImage', `sha256:${'a'.repeat(64)}`)],
      }),
      'win32',
      'x64',
    )
    expect(result?.packageKind).toBe('none')
    expect(result?.unavailableReason).toContain('NSIS')
  })
})
