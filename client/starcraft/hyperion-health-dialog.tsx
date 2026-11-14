import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { CommonDialogProps } from '../dialogs/common-dialog-props'
import { FilledButton, OutlinedButton } from '../material/button'
import { Dialog } from '../material/dialog'
import { useAppDispatch } from '../redux-hooks'
import { openSettings } from '../settings/action-creators'
import { GameSettingsPage } from '../settings/settings-page'
import { useSnackbarController } from '../snackbars/snackbar-overlay'
import { bodyLarge, bodyMedium } from '../styles/typography'
import {
  gameplayCapabilityHealth,
  hyperionHealthy,
  refreshGameplayCapabilities,
} from './hyperion-health'

const Text = styled.div`
  ${bodyLarge};

  & + & {
    margin-top: 20px;
  }
`

const Detail = styled.div`
  ${bodyMedium};
  margin-top: 20px;
  color: var(--theme-on-surface-variant);
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
`

export function HyperionHealthDialog({ onCancel, close }: CommonDialogProps) {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const snackbarController = useSnackbarController()
  const [healthy] = useAtom(hyperionHealthy)
  const [health] = useAtom(gameplayCapabilityHealth)

  useEffect(() => {
    if (healthy) {
      snackbarController.showSnackbar(
        t('starcraft.hyperionHealth.ready', 'Hyperion is ready for supported games.'),
      )
      close()
    }
  }, [healthy, close, snackbarController, t])

  return (
    <Dialog
      title={t('starcraft.hyperionHealth.title', 'Hyperion setup needed')}
      onCancel={onCancel}
      showCloseButton={true}>
      <Text>
        {t(
          'starcraft.hyperionHealth.contents',
          'Hyperion needs a compatible public Hyperion Shield Zero release and readable StarCraft: Remastered CASC or classic Brood War MPQ data. Repair the pinned release in Release Center or choose the game-data folder in Settings.',
        )}
      </Text>
      <Text>
        {health.capabilities?.scrAvailable
          ? t(
              'starcraft.hyperionHealth.scrAvailable',
              'SC:R compatibility is available for configurations that support it, but it cannot reproduce Hyperion-only rules.',
            )
          : t(
              'starcraft.hyperionHealth.noScrFallback',
              'SC:R compatibility is not currently available as an alternative backend.',
            )}
      </Text>
      {health.status === 'checking' ? (
        <Detail>
          {t('starcraft.hyperionHealth.checking', 'Checking the selected Hyperion installation…')}
        </Detail>
      ) : null}
      {health.error ? <Detail>{health.error}</Detail> : null}
      <Actions>
        <FilledButton
          label={t('starcraft.hyperionHealth.rescan', 'Check Hyperion again')}
          disabled={health.status === 'checking'}
          onClick={() => {
            refreshGameplayCapabilities().catch(() => undefined)
          }}
        />
        <OutlinedButton
          label={t('starcraft.hyperionHealth.gameSettings', 'Game-data settings')}
          onClick={() => {
            onCancel()
            dispatch(openSettings(GameSettingsPage.StarCraft))
          }}
        />
      </Actions>
    </Dialog>
  )
}
