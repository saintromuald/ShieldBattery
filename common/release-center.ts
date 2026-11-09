export const RELEASE_PRODUCTS = ['hyperion', 'hypershield'] as const
export type ReleaseProduct = (typeof RELEASE_PRODUCTS)[number]

export type ReleaseChannel = 'stable' | 'prerelease'
export type ReleasePackageKind = 'archive' | 'raw' | 'appImage' | 'none'

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  sha256?: string
}

export interface ReleaseSourceInfo {
  label: string
  repository: string
  url: string
}

export interface ReleaseInfo {
  /** Stable across refreshes and unique across sources. */
  id: string
  product: ReleaseProduct
  tag: string
  /** A display-ready version without repository-specific tag prefixes. */
  version: string
  title: string
  notes?: string
  channel: ReleaseChannel
  publishedAt?: string
  releaseUrl: string
  source: ReleaseSourceInfo
  /** Every file required by this release's installer. */
  assets: ReleaseAsset[]
  packageKind: ReleasePackageKind
  unavailableReason?: string
}

export interface InstalledReleaseInfo {
  releaseId: string
  version: string
  tag: string
  channel: ReleaseChannel
  installedAt: string
}

export interface ReleaseProgress {
  bytesTransferred: number
  totalBytes: number
  bytesPerSecond?: number
}

export type ReleaseOperation =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'readyToRestart'
  | 'error'

export interface ProductReleaseState {
  product: ReleaseProduct
  displayName: string
  currentVersion?: string
  currentReleaseId?: string
  /** True when Hyperion is using the recovery copy shipped inside the client package. */
  usingBundledVersion?: boolean
  /** Latest tracks the selected channel; pinned keeps the chosen release until the user changes it. */
  selection: 'latest' | 'pinned'
  channel: ReleaseChannel
  automaticUpdates: boolean
  supportsInstallation: boolean
  releases: ReleaseInfo[]
  installedReleases: InstalledReleaseInfo[]
  latestReleaseId?: string
  updateAvailable: boolean
  operation: ReleaseOperation
  statusMessage?: string
  progress?: ReleaseProgress
  lastCheckedAt?: string
  sources: ReleaseSourceInfo[]
}

export interface ReleaseCenterState {
  products: Record<ReleaseProduct, ProductReleaseState>
}

export function formatReleaseVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}
