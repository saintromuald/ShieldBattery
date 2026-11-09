import styled from 'styled-components'
import LogoImage from '../logos/hypershield-logo.svg'
import { headlineLarge } from '../styles/typography'
import Download from './download'

const Wrapper = styled.div`
  /* TODO(tec27): Stop using IDs for styling in the root so this doesn't need a specificity hack */
  #app & {
    width: ${640 + 16 * 2}px;
    margin: 0 auto;
    padding-left: var(--pixel-shove-x, 0);
  }
`

const Logo = styled.img`
  width: 192px;
  height: 192px;
  margin: 0 auto;
  display: block;
`

const ProductName = styled.div`
  ${headlineLarge};
  margin: 0 auto 32px;
  font-size: 56px;
  text-align: center;
`

export function DownloadPage() {
  return (
    <div>
      <Wrapper>
        <Logo src={LogoImage} alt='' />
        <ProductName>HyperShield</ProductName>
        <div>
          <Download />
        </div>
      </Wrapper>
    </div>
  )
}
