import { useTranslation } from 'react-i18next'
import { TitleLarge } from '../styles/typography'

export function ComingSoon() {
  const { t } = useTranslation()
  return <TitleLarge>{t('comingSoon.headline', 'This feature is coming soon!')}</TitleLarge>
}
