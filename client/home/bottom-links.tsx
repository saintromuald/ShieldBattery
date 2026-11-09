import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { Link } from 'wouter'
import Logo from '../logos/hypershield-logo.svg?react'
import { titleSmall } from '../styles/typography'

const Root = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
`

const StyledLogo = styled(Logo)`
  width: 112px;
  height: auto;
  margin-block: 8px;
`

const BottomLinksList = styled.ul`
  ${titleSmall};

  width: 100%;
  margin: 0;
  padding: 0;

  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  position: relative;
  pointer-events: all;
  list-style: none;
  column-gap: 32px;

  @media screen and (max-width: 720px) {
    column-gap: 16px;
  }

  & > li {
    min-width: 40px;
    height: 40px;
    display: flex;
    align-items: stretch;
    justify-content: center;
  }
`

const BottomLink = styled(Link)`
  min-width: 40px;
  height: 100%;
  padding-inline: 4px;
  white-space: nowrap;

  display: flex;
  align-items: center;
  justify-content: center;
`

export function BottomLinks() {
  const { t } = useTranslation()
  return (
    <Root>
      <StyledLogo aria-hidden='true' />
      <BottomLinksList>
        <li>
          <BottomLink href='/faq'>{t('landing.bottomLinks.faq', 'FAQ')}</BottomLink>
        </li>
      </BottomLinksList>
      <BottomLinksList>
        <li>
          <BottomLink href='/privacy'>
            {t('landing.bottomLinks.privacyPolicy', 'Privacy Policy')}
          </BottomLink>
        </li>
        <li>
          <BottomLink href='/terms-of-service'>
            {t('landing.bottomLinks.termsOfService', 'Terms of Service')}
          </BottomLink>
        </li>
        <li>
          <BottomLink href='/acceptable-use'>
            {t('landing.bottomLinks.acceptableUsePolicy', 'Acceptable Use Policy')}
          </BottomLink>
        </li>
        <li>
          <BottomLink href='/licenses'>{t('landing.bottomLinks.licenses', 'Licenses')}</BottomLink>
        </li>
      </BottomLinksList>
    </Root>
  )
}
