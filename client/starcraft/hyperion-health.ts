import { atom } from 'jotai'
import { ClientGameplayCapabilities } from '../../common/games/backend'
import { TypedIpcRenderer } from '../../common/ipc'
import { jotaiStore } from '../jotai-store'

export interface GameplayCapabilityHealth {
  status: 'unknown' | 'checking' | 'ready' | 'error'
  capabilities?: ClientGameplayCapabilities
  error?: string
}

export const gameplayCapabilityHealth = atom<GameplayCapabilityHealth>({ status: 'unknown' })
export const hyperionHealthy = atom(
  get => get(gameplayCapabilityHealth).capabilities?.hyperion !== undefined,
)
export const advertisedScrCompatibility = atom(
  get => get(gameplayCapabilityHealth).capabilities?.scrAvailable ?? false,
)

const ipcRenderer = new TypedIpcRenderer()
let pending: Promise<ClientGameplayCapabilities | undefined> | undefined

/** Refreshes the selected-install snapshot used by health UI and queue/lobby advertisements. */
export function refreshGameplayCapabilities(): Promise<ClientGameplayCapabilities | undefined> {
  pending ??= Promise.resolve(ipcRenderer.invoke('activeGameGetGameplayCapabilities'))
    .then(capabilities => {
      jotaiStore.set(gameplayCapabilityHealth, { status: 'ready', capabilities })
      return capabilities
    })
    .catch(error => {
      jotaiStore.set(gameplayCapabilityHealth, {
        status: 'error',
        error: String(error?.message ?? error).slice(0, 512),
      })
      return undefined
    })
    .finally(() => {
      pending = undefined
    })
  jotaiStore.set(gameplayCapabilityHealth, {
    status: 'checking',
    capabilities: jotaiStore.get(gameplayCapabilityHealth).capabilities,
  })
  return pending
}
