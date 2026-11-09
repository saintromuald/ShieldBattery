import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { bodyMedium } from '../styles/typography'

const Notice = styled.div`
  ${bodyMedium};
  margin-bottom: 16px;
  color: var(--theme-on-surface-variant);
  text-align: center;
`

export function AccountIndependenceNotice() {
  const { t } = useTranslation()

  return (
    <Notice role='note'>
      {t(
        'auth.accountIndependence',
        'HyperShield accounts are independent of other Brood War services. Credentials from other ' +
          'services are not shared; use a separate HyperShield account.',
      )}
    </Notice>
  )
}
