import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { PlutoRuntimeState } from '../../../common/pluto-runtime'
import type { PlutoRuntimeIpc } from '../../download/pluto-runtime'
import { KeyListenerBoundary } from '../../keyboard/key-listener'
import { GameDefaultsFirstRunDialog } from './game-defaults-first-run-dialog'

vi.mock('../../redux-hooks', () => ({
  useAppDispatch: () => vi.fn(),
}))

vi.mock('./game-defaults-preview', () => ({
  GameDefaultsPreview: () => null,
}))

const PLUTO_STATE: PlutoRuntimeState = {
  version: '2.0',
  supported: true,
  installed: false,
  installPath: 'C:\\Users\\test\\HyperShield\\hyperion\\pluto',
  operation: 'idle',
  statusMessage: 'Pluto AI is not installed. Download it to enable Pluto opponents.',
}

beforeAll(async () => {
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: {}, interpolation: { escapeValue: false } })
})

describe('GameDefaultsFirstRunDialog Pluto installation', () => {
  it('shows a prominent Download Pluto AI action in the first-run dialog and wires it to IPC', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ...PLUTO_STATE,
      installed: true,
      statusMessage: 'Pluto AI 2.0 is installed and verified.',
    })
    const ipcRenderer = { invoke } as unknown as PlutoRuntimeIpc
    render(
      <KeyListenerBoundary>
        <GameDefaultsFirstRunDialog
          close={() => {}}
          onCancel={() => {}}
          plutoIpcRenderer={ipcRenderer}
          initialPlutoState={PLUTO_STATE}
        />
      </KeyListenerBoundary>,
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Same game. Your call on the details.',
    })
    expect(dialog).toBeDefined()
    expect(screen.getByTestId('pluto-runtime-installer')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Download Pluto AI' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plutoRuntimeInstall'))
    expect(await screen.findByRole('button', { name: 'Repair Pluto AI' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()
  })
})
