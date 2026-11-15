import prettyBytes from 'pretty-bytes'
import { useEffect, useEffectEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { TypedIpcRenderer } from '../../common/ipc'
import {
  PLUTO_RUNTIME_DOWNLOAD_BYTES,
  PLUTO_RUNTIME_VERSION,
  type PlutoRuntimeState,
} from '../../common/pluto-runtime'
import { MaterialIcon } from '../icons/material/material-icon'
import { FilledButton, OutlinedButton } from '../material/button'
import { bodyMedium, bodySmall, titleMedium } from '../styles/typography'

const defaultIpcRenderer = new TypedIpcRenderer()

export type PlutoRuntimeIpc = Pick<TypedIpcRenderer, 'invoke'> &
  Partial<Pick<TypedIpcRenderer, 'on' | 'removeListener'>>

const RuntimeCard = styled.section`
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--theme-outline-variant);
  border-radius: 8px;
  background: var(--theme-container-low);
`

const RuntimeHeader = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
`

const RuntimeIcon = styled.span`
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--theme-primary-container);
  color: var(--theme-on-primary-container);
`

const RuntimeCopy = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const RuntimeTitle = styled.div`
  ${titleMedium};
  color: var(--theme-on-surface);
`

const RuntimeDescription = styled.div`
  ${bodyMedium};
  color: var(--theme-on-surface-variant);
  text-wrap: pretty;
`

const RuntimeStatus = styled.div`
  ${bodyMedium};
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--theme-on-surface-variant);
`

const RuntimeError = styled.div`
  ${bodyMedium};
  padding: 12px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid var(--theme-error);
  border-radius: 6px;
  color: var(--theme-error);
`

const Unsupported = styled.div`
  ${bodySmall};
  color: var(--theme-on-surface-variant);
`

const InstallPath = styled.div`
  ${bodySmall};
  color: var(--theme-on-surface-variant);
  overflow-wrap: anywhere;
`

const ProgressContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const ProgressTrack = styled.div`
  width: 100%;
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--theme-container-highest);
`

const ProgressFill = styled.div<{ $progress: number }>`
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--theme-primary);
  transform: scaleX(${props => props.$progress});
  transform-origin: left center;
`

const ProgressText = styled.div`
  ${bodySmall};
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--theme-on-surface-variant);
`

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'string' && error) {
    return error
  }
  return fallback
}

export interface PlutoRuntimeInstallerProps {
  ipcRenderer?: PlutoRuntimeIpc
  initialState?: PlutoRuntimeState
  /** Disable the initial invoke for view tests and static previews. */
  loadInitialState?: boolean
  showInstallPath?: boolean
}

/** Shared first-run and Release Center control; only its button can initiate the download. */
export function PlutoRuntimeInstaller({
  ipcRenderer = defaultIpcRenderer,
  initialState,
  loadInitialState = !initialState,
  showInstallPath = false,
}: PlutoRuntimeInstallerProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const [runtimeState, setRuntimeState] = useState<PlutoRuntimeState | undefined>(initialState)
  const [pending, setPending] = useState(false)
  const [localError, setLocalError] = useState<string | undefined>()

  async function loadState() {
    await Promise.resolve()
    setLocalError(undefined)
    try {
      const nextState = await ipcRenderer.invoke('plutoRuntimeGetState')
      if (nextState) {
        setRuntimeState(nextState)
      } else {
        setLocalError(
          t(
            'plutoRuntime.errors.unavailable',
            'Pluto AI installation is available only in the HyperShield desktop app.',
          ),
        )
      }
    } catch (error) {
      setLocalError(
        errorMessage(
          error,
          t('plutoRuntime.errors.load', 'Could not check the Pluto AI installation. Try again.'),
        ),
      )
    }
  }

  const loadStateInEffect = useEffectEvent(async () => loadState())

  useEffect(() => {
    const onChanged = (_event: unknown, nextState: PlutoRuntimeState) => {
      if (nextState) {
        setRuntimeState(nextState)
        setLocalError(undefined)
      }
    }
    ipcRenderer.on?.('plutoRuntimeChanged', onChanged)
    if (loadInitialState) {
      Promise.resolve()
        .then(loadStateInEffect)
        .catch(() => {})
    }
    return () => {
      ipcRenderer.removeListener?.('plutoRuntimeChanged', onChanged)
    }
  }, [ipcRenderer, loadInitialState])

  async function install() {
    if (pending || runtimeState?.supported === false) {
      return
    }
    setPending(true)
    setLocalError(undefined)
    try {
      const nextState = await ipcRenderer.invoke('plutoRuntimeInstall')
      if (nextState) {
        setRuntimeState(nextState)
      } else {
        throw new Error(
          t(
            'plutoRuntime.errors.unavailable',
            'Pluto AI installation is available only in the HyperShield desktop app.',
          ),
        )
      }
    } catch (error) {
      setLocalError(
        errorMessage(
          error,
          t('plutoRuntime.errors.install', 'Pluto AI could not be installed. Try again.'),
        ),
      )
    } finally {
      setPending(false)
    }
  }

  const operation = runtimeState?.operation
  const busy =
    pending || operation === 'checking' || operation === 'downloading' || operation === 'installing'
  const errorText = localError ?? (operation === 'error' ? runtimeState?.statusMessage : undefined)
  const statusMessage = pending
    ? t('plutoRuntime.status.starting', 'Starting the Pluto AI download…')
    : runtimeState?.statusMessage
  const progress = runtimeState?.progress
  const progressFraction = progress?.totalBytes
    ? Math.min(1, Math.max(0, progress.bytesTransferred / progress.totalBytes))
    : 0

  return (
    <RuntimeCard aria-labelledby={titleId} data-testid='pluto-runtime-installer'>
      <RuntimeHeader>
        <RuntimeIcon>
          <MaterialIcon icon='smart_toy' size={24} />
        </RuntimeIcon>
        <RuntimeCopy>
          <RuntimeTitle id={titleId}>
            {t('plutoRuntime.title', 'Pluto AI {{version}}', {
              version: PLUTO_RUNTIME_VERSION,
            })}
          </RuntimeTitle>
          <RuntimeDescription>
            {t(
              'plutoRuntime.description',
              'Enable Pluto-controlled opponents with the separate closed-source runtime. The {{size}} download comes only from the author’s official GitHub release; HyperShield does not bundle or mirror it.',
              { size: prettyBytes(PLUTO_RUNTIME_DOWNLOAD_BYTES) },
            )}
          </RuntimeDescription>
        </RuntimeCopy>
      </RuntimeHeader>

      <div>
        <FilledButton
          label={
            runtimeState?.installed
              ? t('plutoRuntime.actions.repair', 'Repair Pluto AI')
              : t('plutoRuntime.actions.download', 'Download Pluto AI')
          }
          iconStart={runtimeState?.installed ? 'build' : 'download'}
          disabled={busy || runtimeState?.supported === false}
          onClick={() => {
            install().catch(() => {})
          }}
          testName='pluto-runtime-install'
        />
      </div>

      {runtimeState?.unsupportedReason ? (
        <Unsupported role='status'>{runtimeState.unsupportedReason}</Unsupported>
      ) : null}

      {showInstallPath && runtimeState?.installPath ? (
        <InstallPath>
          {t('plutoRuntime.installPath', 'Installation folder: {{path}}', {
            path: runtimeState.installPath,
          })}
        </InstallPath>
      ) : null}

      {errorText ? (
        <RuntimeError role='alert'>
          <MaterialIcon icon='error_outline' size={20} />
          <span>{errorText}</span>
        </RuntimeError>
      ) : null}

      {statusMessage && !errorText && !runtimeState?.unsupportedReason ? (
        <RuntimeStatus role='status' aria-live='polite' aria-atomic='true'>
          <MaterialIcon
            icon={runtimeState?.installed && operation === 'idle' ? 'check_circle' : 'info'}
            size={18}
          />
          <span>{statusMessage}</span>
        </RuntimeStatus>
      ) : null}

      {!runtimeState && !errorText ? (
        <RuntimeStatus role='status' aria-live='polite'>
          <MaterialIcon icon='sync' size={18} />
          <span>{t('plutoRuntime.status.loading', 'Checking the Pluto AI installation…')}</span>
        </RuntimeStatus>
      ) : null}

      {progress ? (
        <ProgressContainer>
          <ProgressTrack
            role='progressbar'
            aria-label={t('plutoRuntime.progress.label', 'Pluto AI download progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              progress.totalBytes > 0 ? Math.round(progressFraction * 100) : undefined
            }>
            <ProgressFill $progress={progressFraction} />
          </ProgressTrack>
          <ProgressText>
            <span>
              {prettyBytes(progress.bytesTransferred)} / {prettyBytes(progress.totalBytes)}
            </span>
            {progress.bytesPerSecond !== undefined ? (
              <span>
                {t('plutoRuntime.progress.speed', '{{speed}}/s', {
                  speed: prettyBytes(progress.bytesPerSecond),
                })}
              </span>
            ) : null}
          </ProgressText>
        </ProgressContainer>
      ) : null}

      {!runtimeState && errorText ? (
        <div>
          <OutlinedButton
            label={t('plutoRuntime.actions.tryAgain', 'Try again')}
            iconStart='refresh'
            onClick={() => {
              loadState().catch(() => {})
            }}
          />
        </div>
      ) : null}
    </RuntimeCard>
  )
}
