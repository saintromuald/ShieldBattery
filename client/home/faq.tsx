import * as React from 'react'
import { useLayoutEffect, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { MaterialIcon } from '../icons/material/material-icon'
import { CenteredContentContainer } from '../styles/centered-container'
import { styledWithAttrs } from '../styles/styled-with-attrs'
import { bodyLarge, headlineMedium, titleMedium } from '../styles/typography'
import { BottomLinks } from './bottom-links'

const makeQuestionId = (question: string) => {
  return encodeURIComponent(question.replace(/\s/g, '-').replace('?', ''))
}

const QuestionSectionRoot = styled.div`
  padding-block: 24px;
  padding-right: 16px;
  border-bottom: 1px solid var(--theme-outline);

  @media screen and (max-width: 980px) {
    padding: 16px;
  }
`

const QuestionContainer = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
`

const StyledQuestionIcon = styledWithAttrs(MaterialIcon, {
  icon: 'help',
  size: 32,
  filled: false,
})`
  flex-shrink: 0;
  margin-left: 16px;
  margin-right: 16px;

  display: inline-block;
  color: var(--theme-on-surface-variant);

  @media screen and (max-width: 980px) {
    margin-left: 0px;
  }
`

const QuestionText = styled.div`
  ${titleMedium};
  margin: 0;
  display: inline-block;

  color: var(--theme-on-surface-variant);
  vertical-align: middle;

  @media screen and (max-width: 980px) {
    line-height: 32px;
  }
`

const AnswerText = styled.div`
  ${bodyLarge};
  margin: 8px 0 0 64px;

  color: var(--theme-on-surface);
  font-weight: 300;

  & > p {
    line-height: inherit;
  }

  & > p:first-child {
    margin-top: 0;
  }

  & ul {
    margin: 0;
    padding: 0;
  }

  & li {
    margin-left: 1em;
  }

  @media screen and (max-width: 980px) {
    margin-left: 64px;
  }
`

function QuestionSection({ question, answer }: { question: string; answer: React.ReactNode }) {
  return (
    <QuestionSectionRoot id={makeQuestionId(question)}>
      <QuestionContainer>
        <StyledQuestionIcon />
        <QuestionText>{question}</QuestionText>
      </QuestionContainer>
      <AnswerText>{answer}</AnswerText>
    </QuestionSectionRoot>
  )
}

function FragmentLink({
  to,
  fragment,
  children,
}: {
  to: string
  fragment: string
  children: React.ReactNode
}) {
  return <a href={`${to}#${fragment}`}>{children}</a>
}

const Root = styled(CenteredContentContainer).attrs({ $targetWidth: 860 })`
  & * {
    user-select: text;
  }
`

const FaqToc = styled.div`
  ${bodyLarge};
  padding: 48px 0;

  display: flex;
  flex-direction: column;
  align-items: center;

  line-height: 1.5;
  border-bottom: 1px solid var(--theme-outline);

  @media screen and (max-width: 980px) {
    padding: 32px 16px;
  }
`

const FaqTitle = styled.div`
  ${headlineMedium}
`

export function Faq() {
  const { t } = useTranslation()
  const lastHash = useRef<string>(undefined)

  useLayoutEffect(() => {
    const onHashChange = () => {
      if (lastHash.current !== location.hash) {
        if (location.hash !== '' || lastHash.current !== undefined) {
          let id = location.hash.slice(1)
          id = id === '' ? 'faqToc' : id
          const element = document.getElementById(id)

          if (element) {
            element.scrollIntoView()
          }
        }
        lastHash.current = location.hash
      }
    }
    onHashChange()

    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const questions = [
    {
      question: t(
        'landing.faq.supportedStarcraftVersionQuestion',
        'What does HyperShield use to play StarCraft: Brood War?',
      ),
      answer: (
        <p key='p1'>
          <Trans t={t} i18nKey='landing.faq.supportedStarcraftVersionAnswer'>
            HyperShield's native Linux client uses the bundled Hyperion engine for StarCraft: Brood
            War matchmaking. It reads game data from an existing Classic or Remastered installation,
            but does not need to launch StarCraft: Remastered for native matches.
          </Trans>
        </p>
      ),
    },
    {
      question: t(
        'landing.faq.officialSupportQuestion',
        'Is HyperShield developed with the support of Blizzard?',
      ),
      answer: (
        <p key='p1'>
          <Trans t={t} i18nKey='landing.faq.officialSupportAnswer'>
            No, HyperShield is a community-run test project and has no official support or
            acknowledgement from Blizzard.
          </Trans>
        </p>
      ),
    },
    {
      question: t('landing.faq.isShieldBatteryFreeQuestion', 'Does HyperShield cost anything?'),
      answer: (
        <Trans t={t} i18nKey='landing.faq.isShieldBatteryFreeAnswer'>
          <p key='p1'>HyperShield is free to use while operating as a test service.</p>
          <p key='p2'>
            Test features, stored data, and availability may change as the service develops.
          </p>
        </Trans>
      ),
    },
    {
      question: t('landing.faq.reportIssuesQuestion', 'How can I report bugs or issues?'),
      answer: (
        <p key='p1'>
          <Trans t={t} i18nKey='landing.faq.reportIssuesAnswer'>
            Use the app's Report a bug action for technical problems. For account or moderation
            issues, contact a HyperShield administrator in the official HyperShield chat channel.
          </Trans>
        </p>
      ),
    },
    {
      question: t('landing.faq.openSourceQuestion', 'Is the project open source?'),
      answer: (
        <Trans t={t} i18nKey='landing.faq.openSourceAnswer'>
          <p key='p1'>
            HyperShield is built from open-source software. See our{' '}
            <a href='/licenses'>open source licenses page</a> for upstream attribution, source code,
            and the projects included in the client.
          </p>
        </Trans>
      ),
    },
    {
      question: t(
        'landing.faq.systemRequirementsQuestion',
        'What are the system requirements for HyperShield on Linux?',
      ),
      answer: (
        <Trans t={t} i18nKey='landing.faq.systemRequirementsAnswer'>
          <p key='p1'>The native HyperShield client currently requires:</p>
          <ul key='u1'>
            <li>64-bit Linux on x86-64, with glibc 2.35 or newer</li>
            <li>A graphics driver with Vulkan support</li>
            <li>An internet connection for accounts, chat, and online matchmaking</li>
            <li>
              StarCraft: Brood War game data from a Classic or Remastered installation that you are
              entitled to use
            </li>
          </ul>
        </Trans>
      ),
    },
    {
      question: t('landing.faq.hotkeyCustomizationQuestion', 'Does HyperShield require Wine?'),
      answer: (
        <span>
          <Trans t={t} i18nKey='landing.faq.hotkeyCustomizationAnswer'>
            No. The HyperShield client and Hyperion engine run natively on Linux. Wine is only one
            optional way to provide an existing StarCraft installation's game data; it is not used
            to run HyperShield itself.
          </Trans>
        </span>
      ),
    },
    {
      question: t('landing.faq.linuxSupportQuestion', 'Does HyperShield work on Linux or macOS?'),
      answer: (
        <Trans t={t} i18nKey='landing.faq.linuxSupportAnswer'>
          <p key='p1'>
            HyperShield provides a native Linux x86-64 AppImage; it does not require Wine.
          </p>
          <p key='p2'>This custom client does not currently provide a macOS package.</p>
        </Trans>
      ),
    },
  ]

  return (
    <Root>
      <FaqToc id={'faqToc'}>
        <FaqTitle>{t('landing.faq.title', 'Frequently Asked Questions')}</FaqTitle>
        <ul>
          {questions.map((q, i) => (
            <li key={`link-${i}`}>
              <FragmentLink to='/faq' fragment={makeQuestionId(q.question)}>
                {q.question}
              </FragmentLink>
            </li>
          ))}
        </ul>
      </FaqToc>
      {questions.map((q, i) => (
        <QuestionSection question={q.question} answer={q.answer} key={`question-${i}`} />
      ))}
      <BottomLinks />
    </Root>
  )
}
