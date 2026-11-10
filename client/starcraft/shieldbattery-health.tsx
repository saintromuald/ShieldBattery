import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { DEV_ERROR } from '../../common/flags'
import { CommonDialogProps } from '../dialogs/common-dialog-props'
import { FilledButton } from '../material/button'
import { Dialog } from '../material/dialog'
import { useSnackbarController } from '../snackbars/snackbar-overlay'
import { bodyLarge, bodyMedium } from '../styles/typography'
import { checkShieldBatteryFiles } from './check-shieldbattery-files-ipc'
import { shieldBatteryFilesState, shieldBatteryHealthy } from './health-state'
import { isScrBackendSupported } from './scr-backend'

const Text = styled.div`
  ${bodyLarge};

  & + & {
    margin-top: 24px;
  }
`

const FileList = styled.ul`
  ${bodyMedium};
  margin-bottom: 40px;
`

const RescanButton = styled(FilledButton)`
  margin-top: 40px;
`

const DevContent = styled.div`
  margin-bottom: 24px;
  color: var(--theme-error);
`

export function ShieldBatteryHealthDialog({ onCancel, close }: CommonDialogProps) {
  const { t } = useTranslation()
  const [files] = useAtom(shieldBatteryFilesState)
  const [healthy] = useAtom(shieldBatteryHealthy)
  const snackbarController = useSnackbarController()
  const scrBackendSupported = isScrBackendSupported()

  useEffect(() => {
    if (healthy) {
      snackbarController.showSnackbar(
        t(
          'starcraft.shieldbatteryHealth.noProblems',
          'Your local installation is now free of problems.',
        ),
      )
      close()
    }
  }, [healthy, close, snackbarController, t])

  if (!scrBackendSupported) {
    return (
      <Dialog
        title={t('starcraft.shieldbatteryHealth.unsupportedTitle', 'SC:R is unavailable on Linux')}
        onCancel={onCancel}
        showCloseButton={true}>
        <Text>
          {t(
            'starcraft.shieldbatteryHealth.unsupportedContents',
            'This HyperShield package runs Hyperion games natively and does not include the Windows SC:R backend. Choose a HyperShield matchmaking mode, or use the Windows client for SC:R matchmaking and lobbies. The Windows DLLs are not required for Hyperion games.',
          )}
        </Text>
      </Dialog>
    )
  }

  const initDescription = files.init ? null : <li>sb_init.dll</li>
  const mainDescription = files.main ? null : <li>shieldbattery.dll</li>
  const init64Description = files.init64 ? null : <li>sb_init_64.dll</li>
  const main64Description = files.main64 ? null : <li>shieldbattery_64.dll</li>

  return (
    <Dialog
      title={t('starcraft.shieldbatteryHealth.title', 'Installation problems detected')}
      onCancel={onCancel}
      showCloseButton={true}>
      {DEV_ERROR ? (
        <DevContent>
          <Text>
            Couldn't find necessary HyperShield SC:R files; run game/build.bat and game/build.bat
            x86 to build both architectures
          </Text>
        </DevContent>
      ) : null}

      <div>
        <Text>
          <Trans t={t} i18nKey='starcraft.shieldbatteryHealth.topContents'>
            We've detected that the following HyperShield SC:R files are missing or inaccessible:
          </Trans>
        </Text>
        <FileList>
          {initDescription}
          {mainDescription}
          {init64Description}
          {main64Description}
        </FileList>

        <Text>
          <Trans t={t} i18nKey='starcraft.shieldbatteryHealth.middleContents'>
            This can happen when anti-virus software quarantines these files or when the
            installation is incomplete. You may need to add exceptions for these files, restore them
            from quarantine, or reinstall HyperShield.
          </Trans>
        </Text>

        <Text>
          <Trans t={t} i18nKey='starcraft.shieldbatteryHealth.bottomContents'>
            If you are able to, reporting these as false positives to your anti-virus vendor will
            help this stop happening for other users as well!
          </Trans>
        </Text>
      </div>

      <RescanButton
        label={t('starcraft.shieldbatteryHealth.rescanFiles', 'Rescan files')}
        onClick={() => checkShieldBatteryFiles()}
      />
    </Dialog>
  )
}
