import { AnimatePresence } from 'motion/react'
import prettyBytes from 'pretty-bytes'
import { ReactNode, useEffect, useEffectEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { css } from 'styled-components'
import { TypedIpcRenderer } from '../../common/ipc'
import {
  formatReleaseVersion,
  ProductReleaseState,
  ReleaseCenterState,
  ReleaseChannel,
  ReleaseInfo,
  ReleaseProduct,
} from '../../common/release-center'
import { FocusTrap } from '../dom/focus-trap'
import { MaterialIcon } from '../icons/material/material-icon'
import { KeyListenerBoundary } from '../keyboard/key-listener'
import { FilledButton, FilledTonalButton, OutlinedButton, TextButton } from '../material/button'
import { buttonReset } from '../material/button-reset'
import { Card } from '../material/card'
import { Dialog } from '../material/dialog'
import { Portal } from '../material/portal'
import { OnOffSegmentedButtons, SegmentedButtonGroup } from '../material/segmented-button'
import { TabItem, Tabs } from '../material/tabs'
import { TextField } from '../material/text-field'
import { zIndexDialogScrim } from '../material/zindex'
import { ExternalLink } from '../navigation/external-link'
import {
  bodyLarge,
  bodyMedium,
  bodySmall,
  labelLarge,
  labelMedium,
  labelSmall,
  singleLine,
  titleMedium,
  titleSmall,
} from '../styles/typography'

const defaultIpcRenderer = new TypedIpcRenderer()

export type ReleaseCenterIpc = Pick<TypedIpcRenderer, 'invoke'> &
  Partial<Pick<TypedIpcRenderer, 'on' | 'removeListener'>>

type CatalogFilter = 'all' | ReleaseChannel

interface PendingAction {
  product: ReleaseProduct
  message: string
}

const Scrim = styled.div`
  position: fixed;
  left: 0;
  top: var(--sb-system-bar-height, 0px);
  right: 0;
  bottom: 0;

  background: var(--theme-dialog-scrim);
  opacity: var(--theme-dialog-scrim-opacity);
  z-index: ${zIndexDialogScrim};

  -webkit-app-region: no-drag;
`

const StyledDialog = styled(Dialog)`
  width: calc(100% - 96px);
  max-width: 920px;
  max-height: calc(100% - 48px);
`

const Content = styled.div`
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
`

const SummaryCard = styled(Card)`
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  border: 1px solid var(--theme-outline-variant);
  border-radius: 8px;
`

const SummaryHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;

  @media (max-width: 640px) {
    flex-direction: column;
  }
`

const VersionIdentity = styled.div`
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
`

const ProductIcon = styled.span`
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--theme-primary-container);
  color: var(--theme-on-primary-container);
`

const VersionTextGroup = styled.div`
  min-width: 0;
`

const Overline = styled.div`
  ${labelMedium};
  color: var(--theme-on-surface-variant);
`

const CurrentVersion = styled.div`
  ${titleMedium};
  ${singleLine};
  color: var(--theme-on-surface);
`

const BadgeList = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
`

const badgeStyles = css`
  ${labelSmall};
  width: fit-content;
  min-height: 22px;
  padding: 3px 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--theme-outline-variant);
  border-radius: 999px;
  color: var(--theme-on-surface-variant);
  white-space: nowrap;
`

const Badge = styled.span`
  ${badgeStyles};
`

const AccentBadge = styled(Badge)`
  border-color: var(--theme-primary);
  background: var(--theme-primary-container);
  color: var(--theme-on-primary-container);
`

const PrereleaseBadge = styled(Badge)`
  border-color: var(--theme-amber);
  color: var(--theme-amber);
`

const ErrorBadge = styled(Badge)`
  border-color: var(--theme-error);
  color: var(--theme-error);
`

const SettingsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;

  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
`

const Setting = styled.div`
  min-width: 0;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: 6px;
  background: var(--theme-container-highest);
`

const SettingHeader = styled.div`
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
`

const SettingLabel = styled.div`
  ${labelLarge};
  color: var(--theme-on-surface);
`

const SettingExplanation = styled.div`
  ${bodySmall};
  color: var(--theme-on-surface-variant);
`

const ActionRow = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
`

const RestartBanner = styled.div`
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--theme-amber);
  border-radius: 8px;
  background: var(--theme-container-high);

  @media (max-width: 640px) {
    align-items: stretch;
    flex-direction: column;
  }
`

const RestartCopy = styled.div`
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  color: var(--theme-amber);
`

const RestartText = styled.div`
  ${bodyMedium};
  color: var(--theme-on-surface);
`

const RestartTitle = styled.div`
  ${titleSmall};
  margin-bottom: 4px;
  color: var(--theme-amber);
`

const ErrorBanner = styled.div`
  padding: 12px 16px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid var(--theme-error);
  border-radius: 6px;
  background: var(--theme-container-high);
  color: var(--theme-error);
`

const MessageText = styled.div`
  ${bodyMedium};
  color: var(--theme-on-surface);
`

const SecondaryMessageText = styled.div`
  ${bodySmall};
  margin-top: 4px;
  color: var(--theme-on-surface-variant);
`

const LiveStatus = styled.div`
  ${bodyMedium};
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--theme-on-surface-variant);
`

const ProgressContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const ProgressTrack = styled.div`
  position: relative;
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
  transition: transform 100ms linear;
`

const ProgressText = styled.div`
  ${bodySmall};
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--theme-on-surface-variant);
`

const Catalog = styled.section`
  overflow: hidden;
  border: 1px solid var(--theme-outline-variant);
  border-radius: 8px;
  background: var(--theme-container-low);
`

const CatalogButton = styled.button`
  ${buttonReset};
  width: 100%;
  min-height: 72px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--theme-on-surface);
  text-align: left;

  &:hover,
  &:focus-visible {
    background: var(--theme-container-high);
  }

  &:focus-visible {
    outline: 3px solid var(--theme-focus);
    outline-offset: -3px;
  }
`

const CatalogButtonCopy = styled.span`
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const CatalogTitle = styled.span`
  ${titleSmall};
`

const CatalogSubtitle = styled.span`
  ${bodySmall};
  color: var(--theme-on-surface-variant);
`

const CatalogChevron = styled(MaterialIcon)<{ $open: boolean }>`
  flex-shrink: 0;
  color: var(--theme-primary);
  transform: rotate(${props => (props.$open ? '180deg' : '0deg')});
  transition: transform 160ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`

const CatalogContent = styled.div`
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--theme-outline-variant);
`

const CatalogTools = styled.div`
  display: grid;
  grid-template-columns: auto minmax(200px, 1fr);
  align-items: center;
  gap: 12px;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
`

const SearchField = styled(TextField)`
  min-width: 0;
`

const CatalogMeta = styled.div`
  ${bodySmall};
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--theme-on-surface-variant);
`

const ReleaseList = styled.ul`
  max-height: min(360px, 38vh);
  margin: 0;
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  scrollbar-gutter: stable;
`

const ReleaseRow = styled.li<{ $unavailable: boolean }>`
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--theme-outline-variant);
  border-radius: 6px;
  background: var(--theme-container);
  opacity: ${props => (props.$unavailable ? '0.72' : '1')};
`

const ReleaseMain = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;

  @media (max-width: 640px) {
    flex-direction: column;
  }
`

const ReleaseIdentity = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const ReleaseVersionLine = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
`

const ReleaseVersion = styled.span`
  ${titleSmall};
  color: var(--theme-on-surface);
`

const ReleaseTitle = styled.div`
  ${bodyLarge};
  color: var(--theme-on-surface);
  overflow-wrap: anywhere;
`

const ReleaseMetadata = styled.div`
  ${bodySmall};
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--theme-on-surface-variant);
`

const MetadataItem = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
`

const ReleaseActions = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
`

const ReleaseLink = styled(ExternalLink)`
  ${labelLarge};
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--theme-primary);
  text-decoration: none;

  &:hover,
  &:focus-visible {
    text-decoration: underline;
  }
`

const UnavailableReason = styled.div`
  ${bodySmall};
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--theme-amber);
`

const EmptyState = styled.div`
  padding: 32px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--theme-on-surface-variant);
  text-align: center;
`

const EmptyTitle = styled.div`
  ${titleSmall};
  color: var(--theme-on-surface);
`

const EmptyBody = styled.div`
  ${bodyMedium};
  max-width: 480px;
`

const UnsupportedText = styled.div`
  ${bodySmall};
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

function releaseTime(release: ReleaseInfo): number {
  const timestamp = release.publishedAt ? Date.parse(release.publishedAt) : 0
  return Number.isFinite(timestamp) ? timestamp : 0
}

function newestReleaseInChannel(
  releases: ReadonlyArray<ReleaseInfo>,
  channel: ReleaseChannel,
): ReleaseInfo | undefined {
  let newest: ReleaseInfo | undefined
  for (const release of releases) {
    if (release.channel === channel && (!newest || releaseTime(release) > releaseTime(newest))) {
      newest = release
    }
  }
  return newest
}

function formatPublishedDate(publishedAt: string | undefined, unavailable: string): string {
  if (!publishedAt) {
    return unavailable
  }
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) {
    return unavailable
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function formatLastChecked(lastCheckedAt: string | undefined, unavailable: string): string {
  if (!lastCheckedAt) {
    return unavailable
  }
  const date = new Date(lastCheckedAt)
  if (Number.isNaN(date.getTime())) {
    return unavailable
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function releaseSize(release: ReleaseInfo, unavailable: string): string {
  const bytes = release.assets.reduce((total, asset) => total + asset.size, 0)
  return bytes > 0 ? prettyBytes(bytes) : unavailable
}

function operationIsBusy(product: ProductReleaseState): boolean {
  return ['checking', 'downloading', 'installing'].includes(product.operation)
}

export interface ReleaseCenterDialogProps {
  onCancel: () => void
  initialState?: ReleaseCenterState
  ipcRenderer?: ReleaseCenterIpc
  /** Disable the initial invoke for view tests and static previews. */
  loadInitialState?: boolean
}

/** The release-center surface, exported separately to support dev previews and interaction tests. */
export function ReleaseCenterDialog({
  onCancel,
  initialState,
  ipcRenderer = defaultIpcRenderer,
  loadInitialState = !initialState,
}: ReleaseCenterDialogProps) {
  const { t } = useTranslation()
  const catalogId = useId()
  const channelLabelId = useId()
  const automaticUpdatesLabelId = useId()
  const [centerState, setCenterState] = useState<ReleaseCenterState | undefined>(initialState)
  const [activeProduct, setActiveProduct] = useState<ReleaseProduct>('hyperion')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>('all')
  const [search, setSearch] = useState('')
  const [loadingInitial, setLoadingInitial] = useState(loadInitialState && !initialState)
  const [pending, setPending] = useState<PendingAction | undefined>()
  const [localError, setLocalError] = useState<string | undefined>()

  async function loadState() {
    // Keep effect-driven loads from synchronously cascading into another render.
    await Promise.resolve()
    setLocalError(undefined)
    try {
      const nextState = await ipcRenderer.invoke('releaseCenterGetState')
      if (nextState) {
        setCenterState(nextState)
      } else {
        setLocalError(
          t(
            'releaseCenter.errors.unavailable',
            'Release information is unavailable in this environment.',
          ),
        )
      }
    } catch (error) {
      setLocalError(
        errorMessage(
          error,
          t('releaseCenter.errors.load', 'Could not load release information. Try again.'),
        ),
      )
    } finally {
      setLoadingInitial(false)
    }
  }

  const loadStateInEffect = useEffectEvent(async () => loadState())

  useEffect(() => {
    const onChanged = (_event: unknown, nextState: ReleaseCenterState) => {
      if (nextState) {
        setCenterState(nextState)
        setLocalError(undefined)
      }
    }

    ipcRenderer.on?.('releaseCenterChanged', onChanged)
    if (loadInitialState) {
      Promise.resolve()
        .then(loadStateInEffect)
        .catch(() => {})
    }

    return () => {
      ipcRenderer.removeListener?.('releaseCenterChanged', onChanged)
    }
  }, [ipcRenderer, loadInitialState])

  async function runAction(
    product: ReleaseProduct,
    message: string,
    action: () => Promise<ReleaseCenterState | void> | undefined,
  ) {
    setPending({ product, message })
    setLocalError(undefined)
    try {
      const nextState = await action()
      if (nextState) {
        setCenterState(nextState)
      }
    } catch (error) {
      setLocalError(
        errorMessage(
          error,
          t('releaseCenter.errors.action', 'The release action could not be completed. Try again.'),
        ),
      )
    } finally {
      setPending(current =>
        current?.product === product && current.message === message ? undefined : current,
      )
    }
  }

  function startAction(
    product: ReleaseProduct,
    message: string,
    action: () => Promise<ReleaseCenterState | void> | undefined,
  ) {
    runAction(product, message, action).catch(() => {})
  }

  const product = centerState?.products[activeProduct]
  const pendingForProduct = pending?.product === activeProduct ? pending : undefined
  const busy = !!pendingForProduct || (!!product && operationIsBusy(product))
  const stableLatest = product ? newestReleaseInChannel(product.releases, 'stable') : undefined
  const prereleaseLatest = product
    ? newestReleaseInChannel(product.releases, 'prerelease')
    : undefined
  const newestIds = new Set([stableLatest?.id, prereleaseLatest?.id].filter(id => id !== undefined))
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredReleases = (product?.releases ?? []).filter(release => {
    if (catalogFilter !== 'all' && release.channel !== catalogFilter) {
      return false
    }
    if (!normalizedSearch) {
      return true
    }
    return [release.version, release.title, release.tag].some(value =>
      value.toLocaleLowerCase().includes(normalizedSearch),
    )
  })
  const hasCachedReleases = !!product?.releases.length
  const stagedRelease =
    activeProduct === 'hypershield' && product?.operation === 'readyToRestart'
      ? product.releases.find(release => release.id === product.currentReleaseId)
      : undefined
  let catalogFilterLabel = t('releaseCenter.filter.all', 'All versions')
  if (catalogFilter === 'stable') {
    catalogFilterLabel = t('releaseCenter.channel.stable', 'Stable')
  } else if (catalogFilter === 'prerelease') {
    catalogFilterLabel = t('releaseCenter.channel.prerelease', 'Prerelease')
  }

  function changeProduct(nextProduct: ReleaseProduct) {
    setActiveProduct(nextProduct)
    setCatalogFilter('all')
    setSearch('')
    setLocalError(undefined)
  }

  function installOrActivate(release: ReleaseInfo) {
    if (!product) {
      return
    }
    const installed = product.installedReleases.some(record => record.releaseId === release.id)
    if (busy || (!installed && release.packageKind === 'none') || !product.supportsInstallation) {
      return
    }
    if (installed) {
      startAction(
        activeProduct,
        t('releaseCenter.actions.switching', 'Switching the selected version…'),
        () => ipcRenderer.invoke('releaseCenterActivate', activeProduct, release.id),
      )
    } else {
      startAction(
        activeProduct,
        t('releaseCenter.actions.installing', 'Installing the selected version…'),
        () => ipcRenderer.invoke('releaseCenterInstall', activeProduct, release.id),
      )
    }
  }

  function renderRelease(release: ReleaseInfo): ReactNode {
    if (!product) {
      return null
    }
    const installed = product.installedReleases.some(record => record.releaseId === release.id)
    const selectedForRestart = activeProduct === 'hypershield' && stagedRelease?.id === release.id
    const running =
      activeProduct === 'hypershield'
        ? !!product.currentVersion &&
          formatReleaseVersion(product.currentVersion) === formatReleaseVersion(release.version)
        : product.currentReleaseId === release.id
    const unavailable = !installed && release.packageKind === 'none'
    const version = formatReleaseVersion(release.version)
    let newestMarker: string | undefined
    if (newestIds.has(release.id)) {
      newestMarker =
        release.channel === 'stable'
          ? t('releaseCenter.release.newestStable', 'Newest stable')
          : t('releaseCenter.release.newestPrerelease', 'Newest prerelease')
    }

    let action: ReactNode
    if (unavailable) {
      action = (
        <OutlinedButton
          label={t('releaseCenter.release.unavailable', 'Unavailable')}
          disabled={true}
          title={t('releaseCenter.release.unavailableFor', 'Unavailable: {{version}}', { version })}
        />
      )
    } else if (selectedForRestart) {
      action = (
        <FilledTonalButton
          label={t('releaseCenter.release.selectedForRestart', 'Selected for restart')}
          disabled={true}
        />
      )
    } else if (running) {
      action = (
        <FilledTonalButton label={t('releaseCenter.release.inUse', 'In use')} disabled={true} />
      )
    } else if (installed) {
      action = (
        <FilledTonalButton
          label={t('releaseCenter.release.switchTo', 'Switch to {{version}}', { version })}
          iconStart='swap_horiz'
          disabled={busy || !product.supportsInstallation}
          onClick={() => installOrActivate(release)}
        />
      )
    } else {
      action = (
        <FilledTonalButton
          label={t('releaseCenter.release.install', 'Install {{version}}', { version })}
          iconStart='download'
          disabled={busy || !product.supportsInstallation}
          onClick={() => installOrActivate(release)}
        />
      )
    }

    let usageBadge: ReactNode
    if (selectedForRestart) {
      usageBadge = (
        <PrereleaseBadge>
          {t('releaseCenter.release.selectedForRestart', 'Selected for restart')}
        </PrereleaseBadge>
      )
    } else if (running) {
      usageBadge = <AccentBadge>{t('releaseCenter.release.inUse', 'In use')}</AccentBadge>
    }

    return (
      <ReleaseRow key={release.id} $unavailable={unavailable} data-release-id={release.id}>
        <ReleaseMain>
          <ReleaseIdentity>
            <ReleaseVersionLine>
              <ReleaseVersion>{version}</ReleaseVersion>
              {release.channel === 'stable' ? (
                <AccentBadge>{t('releaseCenter.channel.stable', 'Stable')}</AccentBadge>
              ) : (
                <PrereleaseBadge>
                  {t('releaseCenter.channel.prerelease', 'Prerelease')}
                </PrereleaseBadge>
              )}
              {newestMarker ? <Badge>{newestMarker}</Badge> : null}
              {installed ? (
                <Badge>
                  <MaterialIcon icon='check_circle' size={14} />
                  {t('releaseCenter.release.installed', 'Installed')}
                </Badge>
              ) : null}
              {usageBadge}
            </ReleaseVersionLine>
            <ReleaseTitle>{release.title}</ReleaseTitle>
            <ReleaseMetadata>
              <MetadataItem>
                <MaterialIcon icon='calendar_today' size={14} />
                {formatPublishedDate(
                  release.publishedAt,
                  t('releaseCenter.release.dateUnavailable', 'Publish date unavailable'),
                )}
              </MetadataItem>
              <MetadataItem>
                <MaterialIcon icon='source' size={14} />
                {release.source.label} · {release.source.repository}
              </MetadataItem>
              <MetadataItem>
                <MaterialIcon icon='hard_drive' size={14} />
                {releaseSize(
                  release,
                  t('releaseCenter.release.sizeUnavailable', 'Download size unavailable'),
                )}
              </MetadataItem>
            </ReleaseMetadata>
          </ReleaseIdentity>
          <ReleaseActions>
            {action}
            <ReleaseLink href={release.releaseUrl} forceNewWindow={true}>
              {t('releaseCenter.release.releasePage', 'Release page')}
              <MaterialIcon icon='open_in_new' size={16} />
            </ReleaseLink>
          </ReleaseActions>
        </ReleaseMain>
        {unavailable && release.unavailableReason ? (
          <UnavailableReason>
            <MaterialIcon icon='info' size={16} />
            {release.unavailableReason}
          </UnavailableReason>
        ) : null}
      </ReleaseRow>
    )
  }

  const productTabs = (
    <Tabs activeTab={activeProduct} onChange={changeProduct}>
      <TabItem text={t('releaseCenter.products.hyperion', 'Hyperion engine')} value='hyperion' />
      <TabItem
        text={t('releaseCenter.products.hypershield', 'HyperShield client')}
        value='hypershield'
      />
    </Tabs>
  )

  let statusBadge: ReactNode
  if (product?.operation === 'readyToRestart') {
    statusBadge = (
      <PrereleaseBadge>
        {t('releaseCenter.status.restartRequired', 'Restart required')}
      </PrereleaseBadge>
    )
  } else if (product?.operation === 'error' || localError) {
    statusBadge = (
      <ErrorBadge>{t('releaseCenter.status.needsAttention', 'Needs attention')}</ErrorBadge>
    )
  } else if (product?.updateAvailable) {
    statusBadge = (
      <AccentBadge>{t('releaseCenter.status.updateAvailable', 'Update available')}</AccentBadge>
    )
  } else {
    statusBadge = <Badge>{t('releaseCenter.status.upToDate', 'Up to date')}</Badge>
  }

  return (
    <StyledDialog
      title={t('releaseCenter.title', 'Updates & versions')}
      tabs={productTabs}
      showCloseButton={true}
      onCancel={onCancel}
      testName='release-center'>
      <Content>
        {localError ? (
          <ErrorBanner role='alert'>
            <MaterialIcon icon='cloud_off' />
            <div>
              <MessageText>{localError}</MessageText>
              <SecondaryMessageText>
                {hasCachedReleases
                  ? t(
                      'releaseCenter.errors.cached',
                      'Showing the saved release catalog. You can retry when you are back online.',
                    )
                  : t(
                      'releaseCenter.errors.noCache',
                      'No saved releases are available. Check your connection and try again.',
                    )}
              </SecondaryMessageText>
            </div>
          </ErrorBanner>
        ) : null}

        {loadingInitial || !product ? (
          <EmptyState role='status' aria-live='polite'>
            <MaterialIcon icon={loadingInitial ? 'sync' : 'cloud_off'} size={36} />
            <EmptyTitle>
              {loadingInitial
                ? t('releaseCenter.loading.title', 'Loading release information…')
                : t('releaseCenter.unavailable.title', 'Release information is unavailable')}
            </EmptyTitle>
            <EmptyBody>
              {loadingInitial
                ? t(
                    'releaseCenter.loading.body',
                    'Getting your installed versions and saved release catalogs.',
                  )
                : t(
                    'releaseCenter.unavailable.body',
                    'Open the desktop app or retry to load updates and versions.',
                  )}
            </EmptyBody>
            {!loadingInitial ? (
              <OutlinedButton
                label={t('releaseCenter.actions.tryAgain', 'Try again')}
                iconStart='refresh'
                onClick={() => {
                  setLoadingInitial(true)
                  loadState().catch(() => {})
                }}
              />
            ) : null}
          </EmptyState>
        ) : (
          <>
            <SummaryCard>
              <SummaryHeader>
                <VersionIdentity>
                  <ProductIcon>
                    <MaterialIcon
                      icon={activeProduct === 'hyperion' ? 'memory' : 'shield'}
                      size={26}
                    />
                  </ProductIcon>
                  <VersionTextGroup>
                    <Overline>
                      {t('releaseCenter.summary.current', 'Current {{product}} version', {
                        product: product.displayName,
                      })}
                    </Overline>
                    <CurrentVersion>
                      {product.currentVersion
                        ? formatReleaseVersion(product.currentVersion)
                        : t('releaseCenter.summary.notInstalled', 'Not installed')}
                    </CurrentVersion>
                  </VersionTextGroup>
                </VersionIdentity>
                <BadgeList>
                  {statusBadge}
                  <Badge>
                    {product.selection === 'pinned'
                      ? t('releaseCenter.selection.pinned', 'Pinned version')
                      : t('releaseCenter.selection.latest', 'Tracks latest')}
                  </Badge>
                  {product.usingBundledVersion ? (
                    <Badge>{t('releaseCenter.selection.bundled', 'Bundled recovery copy')}</Badge>
                  ) : null}
                </BadgeList>
              </SummaryHeader>

              <SettingsGrid>
                <Setting>
                  <SettingHeader>
                    <SettingLabel id={channelLabelId}>
                      {t('releaseCenter.settings.channel', 'Release channel')}
                    </SettingLabel>
                    <SegmentedButtonGroup<ReleaseChannel>
                      segments={[
                        { value: 'stable', label: t('releaseCenter.channel.stable', 'Stable') },
                        {
                          value: 'prerelease',
                          label: t('releaseCenter.channel.prerelease', 'Prerelease'),
                        },
                      ]}
                      value={product.channel}
                      ariaLabelledBy={channelLabelId}
                      disabled={busy}
                      onChange={channel => {
                        if (channel === product.channel) {
                          return
                        }
                        startAction(
                          activeProduct,
                          t('releaseCenter.actions.changingChannel', 'Changing release channel…'),
                          () =>
                            ipcRenderer.invoke('releaseCenterSetChannel', activeProduct, channel),
                        )
                      }}
                    />
                  </SettingHeader>
                  <SettingExplanation>
                    {product.channel === 'stable'
                      ? t(
                          'releaseCenter.settings.stableExplanation',
                          'Stable releases are recommended for playing. You can still browse every prerelease below.',
                        )
                      : t(
                          'releaseCenter.settings.prereleaseExplanation',
                          'Prereleases include newer changes that may still need testing. Switch channels at any time.',
                        )}
                  </SettingExplanation>
                </Setting>

                <Setting>
                  <SettingHeader>
                    <SettingLabel id={automaticUpdatesLabelId}>
                      {t('releaseCenter.settings.automaticUpdates', 'Automatic updates')}
                    </SettingLabel>
                    <OnOffSegmentedButtons
                      value={product.automaticUpdates}
                      ariaLabelledBy={automaticUpdatesLabelId}
                      disabled={busy}
                      onChange={enabled => {
                        if (enabled === product.automaticUpdates) {
                          return
                        }
                        startAction(
                          activeProduct,
                          t(
                            'releaseCenter.actions.changingAutomaticUpdates',
                            'Updating automatic update settings…',
                          ),
                          () =>
                            ipcRenderer.invoke(
                              'releaseCenterSetAutomaticUpdates',
                              activeProduct,
                              enabled,
                            ),
                        )
                      }}
                    />
                  </SettingHeader>
                  <SettingExplanation>
                    {product.selection === 'pinned'
                      ? t(
                          'releaseCenter.settings.pinnedExplanation',
                          'Pinned versions pause automatic updates. Track latest to resume updates from your channel.',
                        )
                      : t(
                          'releaseCenter.settings.latestExplanation',
                          'While tracking latest, compatible updates from your selected channel can install automatically.',
                        )}
                  </SettingExplanation>
                </Setting>
              </SettingsGrid>

              <ActionRow>
                <OutlinedButton
                  label={t('releaseCenter.actions.refresh', 'Refresh')}
                  iconStart='refresh'
                  disabled={busy}
                  onClick={() =>
                    startAction(
                      activeProduct,
                      t('releaseCenter.actions.refreshing', 'Checking for new releases…'),
                      () => ipcRenderer.invoke('releaseCenterRefresh', activeProduct),
                    )
                  }
                />
                {activeProduct === 'hyperion' && !product.usingBundledVersion ? (
                  <TextButton
                    label={t('releaseCenter.actions.useBundled', 'Use bundled version')}
                    iconStart='settings_backup_restore'
                    disabled={busy}
                    onClick={() =>
                      startAction(
                        activeProduct,
                        t('releaseCenter.actions.usingBundled', 'Selecting the bundled version…'),
                        () => ipcRenderer.invoke('releaseCenterUseBundledHyperion'),
                      )
                    }
                  />
                ) : null}
                {product.selection === 'pinned' ? (
                  <TextButton
                    label={t('releaseCenter.actions.trackLatest', 'Track latest')}
                    iconStart='timeline'
                    disabled={busy}
                    onClick={() =>
                      startAction(
                        activeProduct,
                        t('releaseCenter.actions.trackingLatest', 'Tracking the latest release…'),
                        () => ipcRenderer.invoke('releaseCenterTrackLatest', activeProduct),
                      )
                    }
                  />
                ) : null}
                <FilledButton
                  label={t('releaseCenter.actions.updateLatest', 'Update to latest')}
                  iconStart='system_update_alt'
                  disabled={busy || !product.supportsInstallation}
                  onClick={() =>
                    startAction(
                      activeProduct,
                      t('releaseCenter.actions.updatingLatest', 'Updating to the latest release…'),
                      () => ipcRenderer.invoke('releaseCenterUpdateLatest', activeProduct),
                    )
                  }
                />
              </ActionRow>
              {!product.supportsInstallation ? (
                <UnsupportedText>
                  {t(
                    'releaseCenter.unsupported',
                    'Installation is not supported on this system. All releases remain available to browse.',
                  )}
                </UnsupportedText>
              ) : null}
            </SummaryCard>

            {product.operation === 'readyToRestart' && activeProduct === 'hypershield' ? (
              <RestartBanner>
                <RestartCopy>
                  <MaterialIcon icon='restart_alt' size={28} />
                  <RestartText>
                    <RestartTitle>
                      {t('releaseCenter.restart.title', 'Your staged HyperShield update is ready')}
                    </RestartTitle>
                    {stagedRelease
                      ? t(
                          'releaseCenter.restart.versionBody',
                          '{{version}} is selected. Restart to finish switching; HyperShield will never restart automatically.',
                          { version: formatReleaseVersion(stagedRelease.version) },
                        )
                      : t(
                          'releaseCenter.restart.body',
                          'Restart to finish switching versions. HyperShield will never restart automatically.',
                        )}
                  </RestartText>
                </RestartCopy>
                <FilledButton
                  label={t('releaseCenter.actions.restartAndSwitch', 'Restart & switch')}
                  iconStart='restart_alt'
                  disabled={busy}
                  onClick={() =>
                    startAction(
                      'hypershield',
                      t('releaseCenter.actions.restarting', 'Restarting HyperShield…'),
                      () => ipcRenderer.invoke('releaseCenterRestartClient'),
                    )
                  }
                />
              </RestartBanner>
            ) : null}

            {product.operation === 'error' ? (
              <ErrorBanner role='alert'>
                <MaterialIcon icon='error_outline' />
                <div>
                  <MessageText>
                    {product.statusMessage ??
                      t(
                        'releaseCenter.errors.catalog',
                        'The release catalog could not be refreshed.',
                      )}
                  </MessageText>
                  <SecondaryMessageText>
                    {hasCachedReleases
                      ? t(
                          'releaseCenter.errors.cached',
                          'Showing the saved release catalog. You can retry when you are back online.',
                        )
                      : t(
                          'releaseCenter.errors.noCache',
                          'No saved releases are available. Check your connection and try again.',
                        )}
                  </SecondaryMessageText>
                </div>
              </ErrorBanner>
            ) : null}

            {pendingForProduct || product.statusMessage || product.progress ? (
              <LiveStatus role='status' aria-live='polite' aria-atomic='true'>
                {pendingForProduct ? <MaterialIcon icon='sync' size={18} /> : null}
                {pendingForProduct?.message ??
                  (product.operation !== 'error' ? product.statusMessage : undefined) ??
                  t('releaseCenter.status.working', 'Working on the selected release…')}
              </LiveStatus>
            ) : null}

            {product.progress ? (
              <ProgressContainer>
                <ProgressTrack
                  role='progressbar'
                  aria-label={t('releaseCenter.progress.label', 'Release download progress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    product.progress.totalBytes > 0
                      ? Math.round(
                          Math.min(
                            1,
                            Math.max(
                              0,
                              product.progress.bytesTransferred / product.progress.totalBytes,
                            ),
                          ) * 100,
                        )
                      : undefined
                  }>
                  <ProgressFill
                    $progress={
                      product.progress.totalBytes > 0
                        ? Math.min(
                            1,
                            Math.max(
                              0,
                              product.progress.bytesTransferred / product.progress.totalBytes,
                            ),
                          )
                        : 0
                    }
                  />
                </ProgressTrack>
                <ProgressText>
                  <span>
                    {prettyBytes(product.progress.bytesTransferred)} /{' '}
                    {prettyBytes(product.progress.totalBytes)}
                  </span>
                  {product.progress.bytesPerSecond !== undefined ? (
                    <span>
                      {t('releaseCenter.progress.speed', '{{speed}}/s', {
                        speed: prettyBytes(product.progress.bytesPerSecond),
                      })}
                    </span>
                  ) : null}
                </ProgressText>
              </ProgressContainer>
            ) : null}

            <Catalog>
              <CatalogButton
                type='button'
                aria-expanded={catalogOpen}
                aria-controls={catalogId}
                aria-label={
                  catalogOpen
                    ? t('releaseCenter.catalog.hide', 'Hide release browser')
                    : t('releaseCenter.catalog.browse', 'Browse releases')
                }
                onClick={() => setCatalogOpen(open => !open)}>
                <MaterialIcon icon='inventory_2' size={28} />
                <CatalogButtonCopy>
                  <CatalogTitle>{t('releaseCenter.catalog.title', 'Release browser')}</CatalogTitle>
                  <CatalogSubtitle>
                    {t(
                      'releaseCenter.catalog.subtitle',
                      '{{count}} versions · Install, pin, or switch releases',
                      { count: product.releases.length },
                    )}
                  </CatalogSubtitle>
                </CatalogButtonCopy>
                <Badge>{catalogFilterLabel}</Badge>
                <CatalogChevron icon='expand_more' size={26} $open={catalogOpen} />
              </CatalogButton>

              {catalogOpen ? (
                <CatalogContent id={catalogId}>
                  <CatalogTools>
                    <SegmentedButtonGroup<CatalogFilter>
                      segments={[
                        {
                          value: 'all',
                          label: t('releaseCenter.filter.all', 'All versions'),
                          testName: 'release-filter-all',
                        },
                        {
                          value: 'stable',
                          label: t('releaseCenter.channel.stable', 'Stable'),
                          testName: 'release-filter-stable',
                        },
                        {
                          value: 'prerelease',
                          label: t('releaseCenter.channel.prerelease', 'Prerelease'),
                          testName: 'release-filter-prerelease',
                        },
                      ]}
                      value={catalogFilter}
                      ariaLabel={t('releaseCenter.filter.label', 'Filter release catalog')}
                      onChange={setCatalogFilter}
                    />
                    <SearchField
                      dense={true}
                      floatingLabel={true}
                      label={t('releaseCenter.search.label', 'Search versions, titles, or tags')}
                      type='search'
                      value={search}
                      leadingIcons={[<MaterialIcon key='search' icon='search' size={20} />]}
                      hasClearButton={!!search}
                      onChange={event => setSearch(event.target.value)}
                    />
                  </CatalogTools>
                  <CatalogMeta>
                    <span>
                      {t(
                        'releaseCenter.catalog.showing',
                        'Showing {{shown}} of {{total}} releases',
                        {
                          shown: filteredReleases.length,
                          total: product.releases.length,
                        },
                      )}
                    </span>
                    <span>
                      {t('releaseCenter.catalog.lastChecked', 'Last checked: {{date}}', {
                        date: formatLastChecked(
                          product.lastCheckedAt,
                          t('releaseCenter.catalog.notChecked', 'Not checked yet'),
                        ),
                      })}
                    </span>
                  </CatalogMeta>
                  {activeProduct === 'hyperion' ? (
                    <UnsupportedText>
                      {t(
                        'releaseCenter.catalog.compatibility',
                        'Engine compatibility is checked before a match. Some older releases may not support current matchmaking; the bundled version remains available above.',
                      )}
                    </UnsupportedText>
                  ) : null}
                  {filteredReleases.length ? (
                    <ReleaseList data-testid='release-catalog'>
                      {filteredReleases.map(renderRelease)}
                    </ReleaseList>
                  ) : (
                    <EmptyState>
                      <MaterialIcon icon='search_off' size={32} />
                      <EmptyTitle>
                        {product.releases.length
                          ? t('releaseCenter.empty.filteredTitle', 'No matching releases')
                          : t('releaseCenter.empty.catalogTitle', 'No releases in the catalog')}
                      </EmptyTitle>
                      <EmptyBody>
                        {product.releases.length
                          ? t(
                              'releaseCenter.empty.filteredBody',
                              'Try another channel or search by a different version, title, or tag.',
                            )
                          : t(
                              'releaseCenter.empty.catalogBody',
                              'Refresh to check online. If you are offline, any saved releases will appear here.',
                            )}
                      </EmptyBody>
                      {product.releases.length ? (
                        <TextButton
                          label={t('releaseCenter.filter.clear', 'Clear filters')}
                          onClick={() => {
                            setCatalogFilter('all')
                            setSearch('')
                          }}
                        />
                      ) : (
                        <OutlinedButton
                          label={t('releaseCenter.actions.refresh', 'Refresh')}
                          iconStart='refresh'
                          disabled={busy}
                          onClick={() =>
                            startAction(
                              activeProduct,
                              t('releaseCenter.actions.refreshing', 'Checking for new releases…'),
                              () => ipcRenderer.invoke('releaseCenterRefresh', activeProduct),
                            )
                          }
                        />
                      )}
                    </EmptyState>
                  )}
                </CatalogContent>
              ) : null}
            </Catalog>
          </>
        )}
      </Content>
    </StyledDialog>
  )
}

export interface ReleaseCenterProps extends ReleaseCenterDialogProps {
  open: boolean
}

/** A modal release center suitable for opening directly from the system bar. */
export function ReleaseCenter({ open, onCancel, ...dialogProps }: ReleaseCenterProps) {
  const [focusableElem, setFocusableElem] = useState<HTMLSpanElement | null>(null)

  return (
    <AnimatePresence>
      {open ? (
        <Portal open={true} onDismiss={onCancel}>
          <KeyListenerBoundary>
            <Scrim aria-hidden={true} onClick={onCancel} />
            <FocusTrap focusableElem={focusableElem}>
              <span ref={setFocusableElem} tabIndex={-1}>
                <ReleaseCenterDialog onCancel={onCancel} {...dialogProps} />
              </span>
            </FocusTrap>
          </KeyListenerBoundary>
        </Portal>
      ) : null}
    </AnimatePresence>
  )
}
