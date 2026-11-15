import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PLUTO_RUNTIME_DOWNLOAD_BYTES, type PlutoRuntimeState } from '../../common/pluto-runtime'
import { PlutoRuntimeInstaller, type PlutoRuntimeIpc } from './pluto-runtime'

function makeState(overrides: Partial<PlutoRuntimeState> = {}): PlutoRuntimeState {
  return {
    version: '2.0',
    supported: true,
    installed: false,
    installPath: '/home/test/.config/hypershield/hyperion/pluto',
    operation: 'idle',
    statusMessage: 'Pluto AI is not installed. Download it to enable Pluto opponents.',
    ...overrides,
  }
}

function makeIpc(state = makeState()) {
  const invoke = vi.fn().mockResolvedValue(state)
  return { invoke, ipcRenderer: { invoke } as unknown as PlutoRuntimeIpc }
}

beforeAll(async () => {
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: {}, interpolation: { escapeValue: false } })
})

describe('PlutoRuntimeInstaller', () => {
  it('invokes the install IPC only after an explicit Download Pluto AI click', async () => {
    const initial = makeState()
    const { invoke, ipcRenderer } = makeIpc(
      makeState({ installed: true, statusMessage: 'Pluto AI 2.0 is installed and verified.' }),
    )
    render(
      <PlutoRuntimeInstaller
        initialState={initial}
        loadInitialState={false}
        ipcRenderer={ipcRenderer}
      />,
    )

    expect(invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Download Pluto AI' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plutoRuntimeInstall'))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Repair Pluto AI' })).toBeDefined()
  })

  it('shows accessible byte progress and disables duplicate actions while downloading', () => {
    const { ipcRenderer } = makeIpc()
    render(
      <PlutoRuntimeInstaller
        initialState={makeState({
          operation: 'downloading',
          statusMessage: 'Downloading Pluto AI 2.0 from the official GitHub release…',
          progress: {
            bytesTransferred: PLUTO_RUNTIME_DOWNLOAD_BYTES / 2,
            totalBytes: PLUTO_RUNTIME_DOWNLOAD_BYTES,
            bytesPerSecond: 1024,
          },
        })}
        loadInitialState={false}
        ipcRenderer={ipcRenderer}
      />,
    )

    const progress = screen.getByRole('progressbar', { name: 'Pluto AI download progress' })
    expect(progress.getAttribute('aria-valuenow')).toBe('50')
    expect(
      screen.getByText('Downloading Pluto AI 2.0 from the official GitHub release…'),
    ).toBeDefined()
    expect(
      (screen.getByRole('button', { name: 'Download Pluto AI' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('surfaces IPC failures and allows a deliberate retry', async () => {
    const { invoke, ipcRenderer } = makeIpc()
    invoke.mockRejectedValue(new Error('SHA-256 verification failed'))
    render(
      <PlutoRuntimeInstaller
        initialState={makeState()}
        loadInitialState={false}
        ipcRenderer={ipcRenderer}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Download Pluto AI' }))
    expect((await screen.findByRole('alert')).textContent).toContain('SHA-256 verification failed')
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Download Pluto AI' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
  })

  it('explains unsupported systems and disables installation', () => {
    render(
      <PlutoRuntimeInstaller
        initialState={makeState({
          supported: false,
          installPath: undefined,
          unsupportedReason:
            'Pluto AI installation is available on Linux x64 and Windows x64 only. This system is darwin arm64.',
          statusMessage:
            'Pluto AI installation is available on Linux x64 and Windows x64 only. This system is darwin arm64.',
        })}
        loadInitialState={false}
      />,
    )

    expect(
      (screen.getByRole('button', { name: 'Download Pluto AI' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getAllByText(/Linux x64 and Windows x64 only/)).not.toHaveLength(0)
  })
})
