import { openDialog } from '../dialogs/action-creators'
import { DialogType } from '../dialogs/dialog-type'
import { dispatch } from '../dispatch-registry'
import { jotaiStore } from '../jotai-store'
import { shieldBatteryHealthy, starcraftHealthy } from './health-state'
import { hyperionHealthy } from './hyperion-health'
import { isScrBackendSupported } from './scr-backend'

export interface HealthCheckOptions {
  /** Whether this action can launch the SC:R/DLL backend. */
  requiresScrBackend?: () => boolean
  /** Whether this action includes semantics that only Hyperion can provide. */
  requiresHyperionBackend?: () => boolean
  /** Whether this action needs at least one usable backend, without preferring either one. */
  requiresAnyBackend?: () => boolean
}

/**
 * Returns a function that will call the provided callback if all the health checks pass,
 * and display the relevant dialog to correct problems if they don't.
 */
export function healthChecked<T extends unknown[]>(
  cb: (...args: T) => void,
  options: HealthCheckOptions = {},
): (...args: T) => void {
  return (...args: T) => {
    const requiresScrBackend = options.requiresScrBackend?.() ?? true
    const scrHealthy =
      isScrBackendSupported() &&
      jotaiStore.get(starcraftHealthy) &&
      jotaiStore.get(shieldBatteryHealthy)
    if (options.requiresHyperionBackend?.() && !jotaiStore.get(hyperionHealthy)) {
      dispatch(openDialog({ type: DialogType.HyperionHealth }))
    } else if (options.requiresAnyBackend?.() && !jotaiStore.get(hyperionHealthy) && !scrHealthy) {
      dispatch(openDialog({ type: DialogType.HyperionHealth }))
    } else if (requiresScrBackend && !isScrBackendSupported()) {
      dispatch(openDialog({ type: DialogType.ShieldBatteryHealth }))
    } else if (requiresScrBackend && !jotaiStore.get(starcraftHealthy)) {
      dispatch(openDialog({ type: DialogType.StarcraftHealth }))
    } else if (requiresScrBackend && !jotaiStore.get(shieldBatteryHealthy)) {
      dispatch(openDialog({ type: DialogType.ShieldBatteryHealth }))
    } else {
      cb(...args)
    }
  }
}
