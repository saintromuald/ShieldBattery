import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { useSelfUser } from '../../auth/auth-utils'
import { openDialog } from '../../dialogs/action-creators'
import { DialogType } from '../../dialogs/dialog-type'
import { useAppDispatch } from '../../redux-hooks'
import { gameDefaultsChoicePendingAtom } from '../settings-atoms'

/**
 * Opens the game defaults first-run dialog once the app's local settings have loaded without a
 * chosen preset. Renders nothing itself.
 *
 * Waits for a logged-in session before opening the dialog: a fresh install lands on the login
 * screen first, and the choice belongs on the main app, not layered over the login form.
 */
export function GameDefaultsFirstRunPrompt() {
  const pending = useAtomValue(gameDefaultsChoicePendingAtom)
  const setPending = useSetAtom(gameDefaultsChoicePendingAtom)
  const selfUser = useSelfUser()
  const dispatch = useAppDispatch()

  useEffect(() => {
    if (!pending) {
      return
    }

    // These presets configure the SC:R DLL backend, which is only available on Windows. The
    // native Linux engine does not consume these options and must not show an unrelated choice.
    if (!navigator.userAgent.includes('Windows')) {
      setPending(false)
    } else if (selfUser) {
      dispatch(openDialog({ type: DialogType.GameDefaultsFirstRun }))
      setPending(false)
    }
  }, [pending, selfUser, dispatch, setPending])

  return null
}
