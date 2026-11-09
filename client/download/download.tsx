import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { FilledButton } from '../material/button'
import { bodyLarge, titleLarge } from '../styles/typography'
import { navigateToDownload } from './download-navigate'

const Root = styled.div`
  display: flex;
  flex-direction: column;
  gap: 32px;
`

const IntroSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const Blurb = styled.div`
  ${titleLarge};
`

const FeatureList = styled.ul`
  ${titleLarge};
  margin: 0;
  padding: 0;

  color: var(--theme-on-surface-variant);
  font-weight: 300;

  & > li {
    margin-top: 4px;
    margin-left: 24px;
  }
`

const DownloadSection = styled.div`
  display: flex;
  justify-content: center;
`

const InstallerButtonLabel = styled.span`
  ${bodyLarge};
  height: 48px;
  display: flex;
  align-items: center;
`

export function Download() {
  const { t } = useTranslation()

  return (
    <Root>
      <IntroSection>
        <Blurb>{t('clientDownload.blurb', 'Download the HyperShield client to:')}</Blurb>
        <FeatureList>
          <li>{t('clientDownload.playGames', 'Play games')}</li>
          <li>{t('clientDownload.watchReplays', 'Watch replays')}</li>
          <li>{t('clientDownload.andMore', 'And more!')}</li>
        </FeatureList>
      </IntroSection>

      <DownloadSection>
        <FilledButton
          onClick={navigateToDownload}
          iconStart='download'
          label={
            <InstallerButtonLabel>
              {t('clientDownload.downloadClient', 'Download client')}
            </InstallerButtonLabel>
          }
        />
      </DownloadSection>
    </Root>
  )
}

export default Download
