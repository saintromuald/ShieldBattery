import type { ReleaseProgress } from './release-center'

export const PLUTO_RUNTIME_VERSION = '2.0'
export const PLUTO_RUNTIME_DOWNLOAD_BYTES = 309_686_477

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
  unsupportedReason?: string
}
