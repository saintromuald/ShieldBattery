import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { DEV_INDICATOR } from '../../common/flags'
import { useIsAdmin } from '../admin/admin-permissions'
import { AdminReportCounts } from '../admin/admin-report-counts'
import { ReleaseCenter } from '../download/release-center'
import { MaterialIcon } from '../icons/material/material-icon'
import Lockup from '../logos/lockup-system-bar-24px.svg?react'
import { IconButton } from '../material/button'
import { buttonReset } from '../material/button-reset'
import { Tooltip } from '../material/tooltip'
import { push } from '../navigation/routing'
import { labelLarge, labelMedium } from '../styles/typography'
import { SupportButton } from './support-button'
import { SystemBarRoot, useSystemBarHeight } from './system-bar-placeholder'
import { SizeLeft, SizeRight, SizeTop, windowControlsWidth } from './window-controls'

const LeftSide = styled.div`
  height: 100%;
  padding: 0 2px;

  display: flex;
  align-items: center;
  gap: 8px;
`

const RightSide = styled.div`
  height: 100%;
  margin-left: auto;
  padding-right: calc(${windowControlsWidth} + 8px);

  display: flex;
  align-items: center;
`

const StyledIconButton = styled(IconButton)`
  width: 48px;
  min-height: 24px;
  padding: 0;
  -webkit-app-region: no-drag;
`

const DevIndicator = styled.div`
  ${labelLarge};

  width: 72px;
  height: 20px;
  margin-left: 8px;
  padding-block: 2px;

  background-color: var(--theme-amber);
  color: var(--theme-on-amber);
  font-weight: 600;

  border-radius: 4px;
  cursor: pointer;
  line-height: 16px;
  text-align: center;
  text-transform: uppercase;
  -webkit-app-region: no-drag;
`

const StyledLockup = styled(Lockup)`
  width: auto;
  height: 24px;
  flex-grow: 0;
  flex-shrink: 0;
`

const VersionButton = styled.button`
  ${buttonReset};
  ${labelMedium};

  height: 26px;
  padding: 0 7px 0 9px;

  display: inline-flex;
  align-items: center;
  gap: 3px;

  border: 1px solid var(--theme-outline-variant);
  border-radius: 6px;
  background: var(--theme-container-low);
  color: var(--theme-on-surface-variant);
  -webkit-app-region: no-drag;

  &:hover {
    border-color: var(--theme-primary);
    color: var(--theme-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--theme-focus);
    outline-offset: 1px;
  }
`

const CUR_VERSION = import.meta.env.SB_VERSION

export function VersionText() {
  const { t } = useTranslation()
  const [releaseCenterOpen, setReleaseCenterOpen] = useState(false)
  const versionButtonRef = useRef<HTMLButtonElement>(null)
  const version = `v${CUR_VERSION}`

  function closeReleaseCenter() {
    setReleaseCenterOpen(false)
    versionButtonRef.current?.focus()
  }

  return (
    <>
      <Tooltip
        text={t('systemBar.releaseCenter.tooltip', 'Updates & versions')}
        position='bottom'
        tabIndex={-1}>
        <VersionButton
          ref={versionButtonRef}
          type='button'
          aria-label={t(
            'systemBar.releaseCenter.open',
            'Open updates & versions, current client version {{version}}',
            { version },
          )}
          aria-haspopup='dialog'
          aria-expanded={releaseCenterOpen}
          onClick={() => setReleaseCenterOpen(true)}>
          {version}
          <MaterialIcon icon='expand_more' size={17} />
        </VersionButton>
      </Tooltip>
      <ReleaseCenter open={releaseCenterOpen} onCancel={closeReleaseCenter} />
    </>
  )
}

export function SystemBar() {
  useSystemBarHeight()
  const isAdmin = useIsAdmin()
  const onAdminClick = useCallback(() => {
    push('/admin')
  }, [])

  return (
    <SystemBarRoot>
      <SizeTop />
      <SizeLeft />
      <SizeRight />
      <LeftSide>
        <StyledLockup />
        <VersionText />
        {DEV_INDICATOR ? (
          // TODO(tec27): Find a place for this + admin that will show up on the web version too
          <Tooltip text='Go to dev pages' position='bottom' tabIndex={-1}>
            <DevIndicator onClick={() => push('/dev')}>Dev</DevIndicator>
          </Tooltip>
        ) : null}
        {isAdmin ? (
          <Tooltip text='Admin' position='bottom' tabIndex={-1}>
            <StyledIconButton
              ariaLabel='Admin'
              icon={<MaterialIcon icon='admin_panel_settings' size={20} filled={false} />}
              onClick={onAdminClick}
            />
          </Tooltip>
        ) : null}
        {isAdmin ? <AdminReportCounts /> : null}
      </LeftSide>
      <RightSide>
        <SupportButton />
      </RightSide>
    </SystemBarRoot>
  )
}
