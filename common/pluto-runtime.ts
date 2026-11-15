import type { ReleaseProgress } from './release-center'

export const PLUTO_RUNTIME_VERSION = '2.0'
export const PLUTO_RUNTIME_DOWNLOAD_BYTES = 309_686_477
export const METALSHARP_WINE_VERSION = '6.0'
export const METALSHARP_WINE_DOWNLOAD_BYTES = 1_356_725_682
export const PLUTO_MACOS_DOWNLOAD_BYTES =
  PLUTO_RUNTIME_DOWNLOAD_BYTES + METALSHARP_WINE_DOWNLOAD_BYTES

export type PlutoRuntimeOperation = 'idle' | 'checking' | 'downloading' | 'installing' | 'error'

/** A complete snapshot of the separately managed, user-requested Pluto runtime installation. */
export interface PlutoRuntimeState {
  version: string
  supported: boolean
  installed: boolean
  /** Hyperion's per-user data directory plus `pluto`, never its packaged working directory. */
  installPath?: string
  operation: PlutoRuntimeOperation
  statusMessage?: string
  progress?: ReleaseProgress
  /** Exact bytes required by the next download, including a missing Apple Silicon runtime. */
  downloadBytes?: number
  /** Whether this installation uses Hyperion's app-managed MetalSharp Wine dependency. */
  usesMetalSharpWine?: boolean
  unsupportedReason?: string
}
