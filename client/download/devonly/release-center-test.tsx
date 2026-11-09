import { useState } from 'react'
import styled from 'styled-components'
import {
  ProductReleaseState,
  ReleaseCenterState,
  ReleaseInfo,
  ReleaseProduct,
  ReleaseSourceInfo,
} from '../../../common/release-center'
import { FilledButton } from '../../material/button'
import { BodyLarge } from '../../styles/typography'
import { ReleaseCenter, ReleaseCenterIpc } from '../release-center'

const hyperionSource: ReleaseSourceInfo = {
  label: 'Hyperion releases',
  repository: 'saintromuald/hyperion-public',
  url: 'https://github.com/saintromuald/hyperion-public/releases',
}

const clientSource: ReleaseSourceInfo = {
  label: 'HyperShield releases on GitHub',
  repository: 'saintromuald/ShieldBattery',
  url: 'https://github.com/saintromuald/ShieldBattery/releases',
}

function release(
  product: ReleaseProduct,
  id: string,
  version: string,
  title: string,
  channel: 'stable' | 'prerelease',
  publishedAt: string,
  unavailableReason?: string,
): ReleaseInfo {
  const source = product === 'hyperion' ? hyperionSource : clientSource
  let packageKind: ReleaseInfo['packageKind'] = 'none'
  if (!unavailableReason) {
    packageKind = product === 'hyperion' ? 'raw' : 'appImage'
  }
  return {
    id,
    product,
    tag: product === 'hyperion' ? version : `v${version}`,
    version,
    title,
    channel,
    publishedAt,
    releaseUrl: `${source.url}/tag/${version}`,
    source,
    assets: unavailableReason
      ? []
      : [
          {
            name: product === 'hyperion' ? 'Hyperion.x86_64' : 'HyperShield.AppImage',
            url: 'https://example.invalid/release-package',
            size: product === 'hyperion' ? 48_600_000 : 118_400_000,
          },
        ],
    packageKind,
    unavailableReason,
  }
}

function productState(product: ProductReleaseState): ProductReleaseState {
  return product
}

const PREVIEW_STATE: ReleaseCenterState = {
  products: {
    hyperion: productState({
      product: 'hyperion',
      displayName: 'Hyperion',
      currentVersion: '1.4.0',
      currentReleaseId: 'hyperion-stable',
      selection: 'latest',
      channel: 'stable',
      automaticUpdates: true,
      supportsInstallation: true,
      releases: [
        release(
          'hyperion',
          'hyperion-beta',
          '1.5.0-beta.2',
          'Pathfinding preview',
          'prerelease',
          '2026-11-06T12:00:00Z',
        ),
        release(
          'hyperion',
          'hyperion-stable',
          '1.4.0',
          'Ranked queue improvements',
          'stable',
          '2026-10-28T12:00:00Z',
        ),
        release(
          'hyperion',
          'hyperion-previous',
          '1.3.2',
          'Replay compatibility fixes',
          'stable',
          '2026-10-08T12:00:00Z',
        ),
        release(
          'hyperion',
          'hyperion-unavailable',
          '1.2.0',
          'Legacy engine snapshot',
          'prerelease',
          '2026-09-12T12:00:00Z',
          'No Linux x64 package was published for this release.',
        ),
      ],
      installedReleases: [
        {
          releaseId: 'hyperion-stable',
          version: '1.4.0',
          tag: '1.4.0',
          channel: 'stable',
          installedAt: '2026-10-28T13:00:00Z',
        },
        {
          releaseId: 'hyperion-beta',
          version: '1.5.0-beta.2',
          tag: '1.5.0-beta.2',
          channel: 'prerelease',
          installedAt: '2026-11-06T13:00:00Z',
        },
      ],
      latestReleaseId: 'hyperion-stable',
      updateAvailable: false,
      operation: 'idle',
      lastCheckedAt: '2026-11-08T09:30:00Z',
      sources: [hyperionSource],
    }),
    hypershield: productState({
      product: 'hypershield',
      displayName: 'HyperShield',
      currentVersion: '12.3.6',
      currentReleaseId: 'client-beta',
      selection: 'pinned',
      channel: 'prerelease',
      automaticUpdates: false,
      supportsInstallation: true,
      releases: [
        release(
          'hypershield',
          'client-beta',
          '12.4.0-beta.1',
          'Release center preview',
          'prerelease',
          '2026-11-07T12:00:00Z',
        ),
        release(
          'hypershield',
          'client-stable',
          '12.3.6',
          'Stability and chat improvements',
          'stable',
          '2026-10-30T12:00:00Z',
        ),
        release(
          'hypershield',
          'client-unavailable',
          '12.2.0',
          'Archived client build',
          'stable',
          '2026-09-22T12:00:00Z',
          'This release does not include an AppImage for your architecture.',
        ),
      ],
      installedReleases: [
        {
          releaseId: 'client-beta',
          version: '12.4.0-beta.1',
          tag: 'v12.4.0-beta.1',
          channel: 'prerelease',
          installedAt: '2026-11-07T13:00:00Z',
        },
        {
          releaseId: 'client-stable',
          version: '12.3.6',
          tag: 'v12.3.6',
          channel: 'stable',
          installedAt: '2026-10-30T13:00:00Z',
        },
      ],
      latestReleaseId: 'client-beta',
      updateAvailable: false,
      operation: 'readyToRestart',
      statusMessage: 'HyperShield 12.4.0-beta.1 is ready. Restart to use it.',
      lastCheckedAt: '2026-11-08T09:30:00Z',
      sources: [clientSource],
    }),
  },
}

const previewIpc = {
  invoke: () => Promise.resolve(PREVIEW_STATE),
} as unknown as ReleaseCenterIpc

const PreviewPage = styled.div`
  min-height: 100vh;
  padding: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  background: var(--theme-surface);
`

export function ReleaseCenterTest() {
  const [open, setOpen] = useState(true)

  return (
    <PreviewPage>
      <BodyLarge>
        Preview the release catalog, version switching, and staged restart states.
      </BodyLarge>
      <FilledButton label='Open release center' onClick={() => setOpen(true)} />
      <ReleaseCenter
        open={open}
        onCancel={() => setOpen(false)}
        initialState={PREVIEW_STATE}
        loadInitialState={false}
        ipcRenderer={previewIpc}
      />
    </PreviewPage>
  )
}
