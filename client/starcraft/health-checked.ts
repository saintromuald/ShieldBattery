import { openDialog } from '../dialogs/action-creators'
import { DialogType } from '../dialogs/dialog-type'
import { dispatch } from '../dispatch-registry'
import { jotaiStore } from '../jotai-store'
import { shieldBatteryHealthy, starcraftHealthy } from './health-state'
import { isScrBackendSupported } from './scr-backend'

export interface HealthCheckOptions {
  /** Whether this action can launch the SC:R/DLL backend. */
  requiresScrBackend?: () => boolean
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
    if (requiresScrBackend && !isScrBackendSupported()) {
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
