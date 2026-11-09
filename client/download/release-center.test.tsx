import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import i18next from 'i18next'
import { ReactNode } from 'react'
import { initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import {
  ProductReleaseState,
  ReleaseCenterState,
  ReleaseInfo,
  ReleaseSourceInfo,
} from '../../common/release-center'
import { KeyListenerBoundary } from '../keyboard/key-listener'
import { VersionText } from '../system-bar/system-bar'
import { ReleaseCenterDialog, ReleaseCenterIpc } from './release-center'

vi.mock('../navigation/external-link', () => ({
  ExternalLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href} target='_blank' rel='noreferrer'>
      {children}
    </a>
  ),
}))

const source: ReleaseSourceInfo = {
  label: 'Hyperion releases',
  repository: 'saintromuald/hyperion-public',
  url: 'https://github.com/saintromuald/hyperion-public/releases',
}

function release(
  id: string,
  version: string,
  title: string,
  channel: 'stable' | 'prerelease',
  unavailableReason?: string,
): ReleaseInfo {
  return {
    id,
    product: 'hyperion',
    tag: `hyperion-${version}`,
    version,
    title,
    channel,
    publishedAt: '2026-11-01T12:00:00Z',
    releaseUrl: `https://github.com/saintromuald/hyperion-public/releases/tag/${version}`,
    source,
    assets: unavailableReason
      ? []
      : [{ name: 'Hyperion.x86_64', url: 'https://example.invalid/package', size: 42_000_000 }],
    packageKind: unavailableReason ? 'none' : 'raw',
    unavailableReason,
  }
}

function emptyProduct(product: 'hyperion' | 'hypershield'): ProductReleaseState {
  return {
    product,
    displayName: product === 'hyperion' ? 'Hyperion' : 'HyperShield',
    currentVersion: product === 'hyperion' ? '1.0.0' : '12.3.6',
    selection: 'latest',
    channel: 'stable',
    automaticUpdates: true,
    supportsInstallation: true,
    releases: [],
    installedReleases: [],
    updateAvailable: false,
    operation: 'idle',
    sources: [source],
  }
}

function makeState(): ReleaseCenterState {
  return {
    products: {
      hyperion: {
        ...emptyProduct('hyperion'),
        releases: [
          release('stable-2', '2.0.0', 'Stable release', 'stable'),
          release('beta-2', '2.1.0-beta.1', 'Beta release', 'prerelease'),
          release('old-unavailable', '0.9.0', 'Legacy package', 'stable', 'No compatible package.'),
        ],
        latestReleaseId: 'stable-2',
      },
      hypershield: emptyProduct('hypershield'),
    },
  }
}

function makeIpc(state = makeState()) {
  const invoke = vi.fn().mockResolvedValue(state)
  return {
    invoke,
    ipcRenderer: { invoke } as unknown as ReleaseCenterIpc,
  }
}

function renderWithBoundary(children: ReactNode) {
  return render(<KeyListenerBoundary>{children}</KeyListenerBoundary>)
}

function renderReleaseCenter(state = makeState(), ipcRenderer = makeIpc(state).ipcRenderer) {
  renderWithBoundary(
    <ReleaseCenterDialog
      onCancel={() => {}}
      initialState={state}
      loadInitialState={false}
      ipcRenderer={ipcRenderer}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Browse releases' }))
}

beforeAll(async () => {
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: {}, interpolation: { escapeValue: false } })
})

describe('client/download/release-center', () => {
  test('shows stable and prerelease releases together under All versions', () => {
    renderReleaseCenter()
    const catalog = within(screen.getByTestId('release-catalog'))

    expect(catalog.getByText('v2.0.0')).toBeDefined()
    expect(catalog.getByText('v2.1.0-beta.1')).toBeDefined()
    expect(screen.getByRole('button', { name: 'All versions' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  test('filters by channel and searches version, title, and tag fields', () => {
    renderReleaseCenter()

    fireEvent.click(screen.getByTestId('release-filter-prerelease'))
    let catalog = within(screen.getByTestId('release-catalog'))
    expect(catalog.getByText('v2.1.0-beta.1')).toBeDefined()
    expect(catalog.queryByText('v2.0.0')).toBeNull()

    fireEvent.click(screen.getByTestId('release-filter-all'))
    fireEvent.change(screen.getByLabelText('Search versions, titles, or tags'), {
      target: { value: 'legacy' },
    })
    catalog = within(screen.getByTestId('release-catalog'))
    expect(catalog.getByText('v0.9.0')).toBeDefined()
    expect(catalog.queryByText('v2.0.0')).toBeNull()
    expect(catalog.queryByText('v2.1.0-beta.1')).toBeNull()
  })

  test('keeps unavailable releases visible with their reason and a disabled action', () => {
    renderReleaseCenter()
    const catalog = within(screen.getByTestId('release-catalog'))

    expect(catalog.getByText('v0.9.0')).toBeDefined()
    expect(catalog.getByText('No compatible package.')).toBeDefined()
    expect(
      (catalog.getByRole('button', { name: 'Unavailable' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  test('switches to an installed release even when its online package is unavailable', async () => {
    const state = makeState()
    state.products.hyperion.installedReleases = [
      {
        releaseId: 'old-unavailable',
        version: '0.9.0',
        tag: 'hyperion-0.9.0',
        channel: 'stable',
        installedAt: '2026-11-02T12:00:00Z',
      },
    ]
    const { invoke, ipcRenderer } = makeIpc(state)
    renderReleaseCenter(state, ipcRenderer)

    const switchButton = screen.getByRole('button', {
      name: 'Switch to v0.9.0',
    }) as HTMLButtonElement
    expect(switchButton.disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Unavailable' })).toBeNull()
    expect(screen.queryByText('No compatible package.')).toBeNull()

    fireEvent.click(switchButton)

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('releaseCenterActivate', 'hyperion', 'old-unavailable'),
    )
  })

  test('distinguishes the running HyperShield release from the release selected for restart', () => {
    const state = makeState()
    const stagedRelease = {
      ...release('hypershield-staged', '12.4.0', 'Staged client release', 'stable'),
      product: 'hypershield' as const,
    }
    const runningRelease = {
      ...release('hypershield-running', '12.3.6', 'Running client release', 'stable'),
      product: 'hypershield' as const,
    }
    state.products.hypershield = {
      ...state.products.hypershield,
      currentVersion: 'v12.3.6',
      currentReleaseId: stagedRelease.id,
      releases: [stagedRelease, runningRelease],
      installedReleases: [
        {
          releaseId: stagedRelease.id,
          version: stagedRelease.version,
          tag: stagedRelease.tag,
          channel: stagedRelease.channel,
          installedAt: '2026-11-02T12:00:00Z',
        },
      ],
      operation: 'readyToRestart',
    }
    renderReleaseCenter(state)

    fireEvent.click(screen.getByRole('button', { name: 'HyperShield client' }))

    const catalog = within(screen.getByTestId('release-catalog'))
    const stagedRow = catalog.getByText('v12.4.0').closest('li') as HTMLElement
    const runningRow = catalog.getByText('v12.3.6').closest('li') as HTMLElement
    expect(within(stagedRow).getAllByText('Selected for restart')).toHaveLength(2)
    expect(within(stagedRow).queryByText('In use')).toBeNull()
    expect(
      (
        within(stagedRow).getByRole('button', {
          name: 'Selected for restart',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(within(runningRow).getAllByText('In use')).toHaveLength(2)
    expect(within(runningRow).queryByText('Selected for restart')).toBeNull()
  })

  test('installs a release through the typed IPC method with product and release ID', async () => {
    const state = makeState()
    const { invoke, ipcRenderer } = makeIpc(state)
    renderReleaseCenter(state, ipcRenderer)

    fireEvent.click(screen.getByRole('button', { name: 'Install v2.0.0' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('releaseCenterInstall', 'hyperion', 'stable-2'),
    )
  })

  test('opens an accessible release center and restores focus to the system-bar trigger', async () => {
    renderWithBoundary(<VersionText />)

    const trigger = screen.getByRole('button', {
      name: /Open updates & versions, current client version v/,
    })
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Updates & versions' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('Updates & versions')).toBeDefined()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
