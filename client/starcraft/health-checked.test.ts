import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DialogType } from '../dialogs/dialog-type'
import { dispatch } from '../dispatch-registry'
import { jotaiStore } from '../jotai-store'
import { healthChecked } from './health-checked'
import { shieldBatteryFilesState, starcraftPathValid, starcraftVersionValid } from './health-state'

vi.mock('../dispatch-registry', () => ({ dispatch: vi.fn() }))

describe('healthChecked', () => {
  beforeEach(() => {
    vi.mocked(dispatch).mockClear()
    jotaiStore.set(starcraftPathValid, false)
    jotaiStore.set(starcraftVersionValid, false)
    jotaiStore.set(shieldBatteryFilesState, {
      init: false,
      main: false,
      init64: false,
      main64: false,
    })
  })

  it('keeps the existing SC:R health gate by default', () => {
    const callback = vi.fn()
    healthChecked(callback)()
    expect(callback).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: '@dialogs/open',
        payload: { type: DialogType.StarcraftHealth },
      }),
    )
  })

  it('allows native-only actions without requiring SC:R or its DLL', () => {
    const callback = vi.fn()
    healthChecked(callback, { requiresScrBackend: () => false })()
    expect(callback).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('retains the SC:R gate for actions that can select either backend', () => {
    const callback = vi.fn()
    healthChecked(callback, { requiresScrBackend: () => true })()
    expect(callback).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: '@dialogs/open',
        payload: { type: DialogType.StarcraftHealth },
      }),
    )
  })
})
