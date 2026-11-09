import type {
  ReleaseAsset,
  ReleaseChannel,
  ReleaseInfo,
  ReleaseProduct,
  ReleaseSourceInfo,
} from '../../common/release-center'
import { errorMessage } from './storage'

export interface ReleaseSource extends ReleaseSourceInfo {
  apiUrl: string
}

export interface GitHubReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
  digest?: unknown
}

export interface GitHubRelease {
  id?: unknown
  tag_name?: unknown
  name?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  published_at?: unknown
  html_url?: unknown
  assets?: unknown
}

export type ReleaseFetch = typeof globalThis.fetch

const GITHUB_API_ROOT = 'https://api.github.com/repos'
export const CATALOG_REQUEST_TIMEOUT_MS = 30_000

function githubSource(repository: string, label: string): ReleaseSource {
  return {
    label,
    repository,
    url: `https://github.com/${repository}`,
    apiUrl: `${GITHUB_API_ROOT}/${repository}`,
  }
}

/** Sources are tried together and their release identities remain distinct across repositories. */
export const RELEASE_SOURCES: Record<ReleaseProduct, readonly ReleaseSource[]> = {
  hyperion: [githubSource('saintromuald/hyperion-public', 'Hyperion releases on GitHub')],
  hypershield: [githubSource('saintromuald/ShieldBattery', 'HyperShield releases on GitHub')],
}

export function releaseRequestHeaders(
  clientVersion: string,
  accept = 'application/vnd.github+json',
): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim()
  return {
    Accept: accept,
    'User-Agent': `HyperShield/${clientVersion}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function nextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined
  }
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>\s*((?:;\s*[^;]+)*)\s*$/.exec(part)
    if (!match) {
      continue
    }
    const parameters = match[2]
    if (/(?:^|;)\s*rel\s*=\s*"?next"?(?:\s*;|\s*$)/i.test(parameters)) {
      return match[1]
    }
  }
  return undefined
}

async function githubError(response: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await response.json()) as unknown
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const message = (body as { message?: unknown }).message
      if (typeof message === 'string') {
        detail = `: ${message}`
      }
    }
  } catch {
    // Status text below still describes non-JSON error responses.
  }
  const rateLimited =
    response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
  const prefix = rateLimited
    ? 'GitHub release request was rate limited'
    : `GitHub release request failed (${response.status} ${response.statusText || 'HTTP error'})`
  return `${prefix}${detail}`
}

export async function fetchGitHubReleasePages(
  source: ReleaseSource,
  clientVersion: string,
  fetchImpl: ReleaseFetch = globalThis.fetch,
): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = []
  const visited = new Set<string>()
  let url: string | undefined = `${source.apiUrl}/releases?per_page=100&page=1`

  while (url) {
    if (visited.has(url)) {
      throw new Error(`GitHub returned a cyclic pagination link for ${source.repository}.`)
    }
    visited.add(url)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(
          new Error(
            `GitHub release request for ${source.repository} timed out after ${CATALOG_REQUEST_TIMEOUT_MS / 1000} seconds.`,
          ),
        )
      }, CATALOG_REQUEST_TIMEOUT_MS)
    })
    let response: Response
    let page: unknown
    try {
      try {
        response = await Promise.race([
          fetchImpl(url, {
            headers: releaseRequestHeaders(clientVersion),
            signal: controller.signal,
          }),
          timeout,
        ])
      } catch (error) {
        throw new Error(`Could not reach GitHub for ${source.repository}: ${errorMessage(error)}`, {
          cause: error,
        })
      }
      if (!response.ok) {
        throw new Error(await Promise.race([githubError(response), timeout]))
      }
      page = await Promise.race([response.json(), timeout])
    } finally {
      clearTimeout(timer!)
    }
    if (!Array.isArray(page)) {
      throw new Error(`GitHub returned an invalid release list for ${source.repository}.`)
    }
    releases.push(...(page as GitHubRelease[]))
    url = nextLink(response.headers.get('link'))
  }
  return releases
}

export function normalizeReleaseVersion(tag: string): string {
  return tag
    .replace(/^Hyperion-Shield-v?(?=\d)/i, '')
    .replace(/^HyperShield-v?(?=\d)/i, '')
    .replace(/^Hyperion-v?(?=\d)/i, '')
    .replace(/^v(?=\d)/, '')
}

function normalizeArchitecture(
  platform: NodeJS.Platform,
  architecture: string,
): 'x64' | 'arm64' | undefined {
  if (platform === 'win32') {
    return architecture === 'x64' ? 'x64' : undefined
  }
  if (platform !== 'linux') {
    return undefined
  }
  return architecture === 'x64' || architecture === 'arm64' ? architecture : undefined
}

function architecturePattern(architecture: 'x64' | 'arm64'): string {
  return architecture === 'x64' ? '(?:x64|x86_64|amd64)' : '(?:arm64|aarch64)'
}

function digestSha256(digest: unknown): string | undefined {
  if (digest === undefined || digest === null || digest === '') {
    return undefined
  }
  if (typeof digest !== 'string') {
    throw new Error('GitHub published an invalid asset digest.')
  }
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest.trim())
  if (!match) {
    throw new Error('GitHub published an unsupported or malformed asset digest.')
  }
  return match[1].toLowerCase()
}

function makeAsset(asset: GitHubReleaseAsset): ReleaseAsset {
  if (
    typeof asset.name !== 'string' ||
    typeof asset.browser_download_url !== 'string' ||
    typeof asset.size !== 'number' ||
    !Number.isFinite(asset.size) ||
    asset.size < 0
  ) {
    throw new Error('GitHub returned incomplete release asset metadata.')
  }
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: digestSha256(asset.digest),
  }
}

function unavailable(
  release: Omit<ReleaseInfo, 'assets' | 'packageKind' | 'unavailableReason'>,
  reason: string,
): ReleaseInfo {
  return { ...release, assets: [], packageKind: 'none', unavailableReason: reason }
}

interface PackageSelection {
  assets: ReleaseAsset[]
  packageKind: ReleaseInfo['packageKind']
  unavailableReason?: string
}

function selectWindowsHyperionPackage(assets: GitHubReleaseAsset[]): PackageSelection {
  const excludedName = /(?:zero|mac|darwin|osx)/i
  const platformSpecific = assets.find(
    asset =>
      typeof asset.name === 'string' &&
      /^Hyperion-Shield-[^/]+-windows-x64\.zip$/i.test(asset.name) &&
      !excludedName.test(asset.name),
  )
  const generic = assets.find(
    asset =>
      typeof asset.name === 'string' &&
      /^Hyperion-Shield-[^/]+\.zip$/i.test(asset.name) &&
      !/(?:zero|mac|darwin|osx|windows|linux|arm64|aarch64|x86_64)/i.test(asset.name),
  )
  const archive = platformSpecific ?? generic
  if (!archive) {
    return {
      assets: [],
      packageKind: 'none',
      unavailableReason:
        'No public Hyperion Shield ZIP package for Windows x64 is attached to this release.',
    }
  }
  try {
    const selected = makeAsset(archive)
    if (!selected.sha256) {
      throw new Error('The Windows Hyperion ZIP does not have a published SHA-256 digest.')
    }
    return { assets: [selected], packageKind: 'archive' }
  } catch (error) {
    return { assets: [], packageKind: 'none', unavailableReason: errorMessage(error) }
  }
}

function selectHyperionPackage(
  assets: GitHubReleaseAsset[],
  platform: NodeJS.Platform,
  architecture: 'x64' | 'arm64',
): PackageSelection {
  if (platform === 'win32') {
    return selectWindowsHyperionPackage(assets)
  }
  const archivePattern = new RegExp(
    `^Hyperion-Shield-.*linux.*${architecturePattern(architecture)}.*\\.tar\\.gz$`,
    'i',
  )
  const archive = assets.find(
    asset =>
      typeof asset.name === 'string' &&
      archivePattern.test(asset.name) &&
      !/zero/i.test(asset.name),
  )
  try {
    if (archive) {
      return { assets: [makeAsset(archive)], packageKind: 'archive' }
    }

    const executableName = architecture === 'x64' ? 'Hyperion.x86_64' : 'Hyperion.aarch64'
    const executable = assets.find(asset => asset.name === executableName)
    const library = assets.find(asset => asset.name === 'libSDL3.so.0')
    if (executable && library) {
      return { assets: [makeAsset(executable), makeAsset(library)], packageKind: 'raw' }
    }
    return {
      assets: [],
      packageKind: 'none',
      unavailableReason: `No public Hyperion Shield package for Linux ${architecture} is attached to this release.`,
    }
  } catch (error) {
    return { assets: [], packageKind: 'none', unavailableReason: errorMessage(error) }
  }
}

function selectHyperShieldPackage(
  assets: GitHubReleaseAsset[],
  architecture: 'x64' | 'arm64',
): PackageSelection {
  const appImagePattern = new RegExp(
    `^HyperShield-.*${architecturePattern(architecture)}.*\\.AppImage$`,
    'i',
  )
  const appImage = assets.find(
    asset =>
      typeof asset.name === 'string' &&
      appImagePattern.test(asset.name) &&
      !/zero/i.test(asset.name),
  )
  if (!appImage) {
    return {
      assets: [],
      packageKind: 'none',
      unavailableReason: `No HyperShield AppImage for Linux ${architecture} is attached to this release.`,
    }
  }
  try {
    return { assets: [makeAsset(appImage)], packageKind: 'appImage' }
  } catch {
    return {
      assets: [],
      packageKind: 'none',
      unavailableReason: 'The compatible AppImage has an invalid or unsupported SHA-256 digest.',
    }
  }
}

export function toReleaseInfo(
  product: ReleaseProduct,
  source: ReleaseSource,
  release: GitHubRelease,
  platform: NodeJS.Platform,
  architecture: string,
): ReleaseInfo | undefined {
  if (release.draft === true) {
    return undefined
  }
  if (typeof release.id !== 'number' || typeof release.tag_name !== 'string' || !release.tag_name) {
    throw new Error(`GitHub returned an incomplete release in ${source.repository}.`)
  }
  const sourceInfo: ReleaseSourceInfo = {
    label: source.label,
    repository: source.repository,
    url: source.url,
  }
  const base = {
    id: `github:${source.repository}:${release.id}`,
    product,
    tag: release.tag_name,
    version: normalizeReleaseVersion(release.tag_name),
    title:
      typeof release.name === 'string' && release.name.trim() ? release.name : release.tag_name,
    notes: typeof release.body === 'string' && release.body ? release.body : undefined,
    channel: (release.prerelease === true ? 'prerelease' : 'stable') as ReleaseChannel,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
    releaseUrl:
      typeof release.html_url === 'string'
        ? release.html_url
        : `${source.url}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    source: sourceInfo,
  }
  const normalizedArchitecture = normalizeArchitecture(platform, architecture)
  const supportedProductPlatform =
    product === 'hyperion' ? platform === 'linux' || platform === 'win32' : platform === 'linux'
  if (!normalizedArchitecture || !supportedProductPlatform) {
    let reason = `Release installation is not available on the ${architecture} processor architecture.`
    if (product === 'hypershield' && platform === 'win32') {
      reason =
        'HyperShield AppImage staging is available only on Linux. Windows client updates continue to use NSIS.'
    } else if (normalizedArchitecture && !supportedProductPlatform) {
      reason = `${product === 'hyperion' ? 'Hyperion' : 'HyperShield'} release installation is not available on this platform.`
    }
    return unavailable(base, reason)
  }
  if (
    /\bzero\b/i.test(`${release.tag_name} ${typeof release.name === 'string' ? release.name : ''}`)
  ) {
    return unavailable(
      base,
      'Hyperion Zero packages are not supported by the Shield release center.',
    )
  }
  if (!Array.isArray(release.assets)) {
    return unavailable(base, 'This release has no downloadable assets.')
  }
  const selection =
    product === 'hyperion'
      ? selectHyperionPackage(
          release.assets as GitHubReleaseAsset[],
          platform,
          normalizedArchitecture,
        )
      : selectHyperShieldPackage(release.assets as GitHubReleaseAsset[], normalizedArchitecture)
  return { ...base, ...selection }
}

export async function fetchReleaseCatalog(
  product: ReleaseProduct,
  clientVersion: string,
  platform: NodeJS.Platform,
  architecture: string,
  fetchImpl: ReleaseFetch = globalThis.fetch,
  sources: readonly ReleaseSource[] = RELEASE_SOURCES[product],
): Promise<ReleaseInfo[]> {
  const sourceReleases = await Promise.all(
    sources.map(async source => {
      const pages = await fetchGitHubReleasePages(source, clientVersion, fetchImpl)
      return pages.map(release => toReleaseInfo(product, source, release, platform, architecture))
    }),
  )
  const deduplicated = new Map<string, ReleaseInfo>()
  for (const release of sourceReleases.flat()) {
    if (release && !deduplicated.has(release.id)) {
      deduplicated.set(release.id, release)
    }
  }
  return [...deduplicated.values()].sort((a, b) => {
    const timeDifference = Date.parse(b.publishedAt ?? '') - Date.parse(a.publishedAt ?? '')
    if (Number.isFinite(timeDifference) && timeDifference !== 0) {
      return timeDifference
    }
    return b.id.localeCompare(a.id)
  })
}
