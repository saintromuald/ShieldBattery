import { render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SelfUser } from '../../../common/users/sb-user'
import { makeSbUserId } from '../../../common/users/sb-user-id'
import { UserAccountSettings } from './account-settings'

const mocks = vi.hoisted(() => ({
  currentUser: {
    id: 4,
    name: 'saintaquinas',
    loginName: 'saintaquinas',
    email: 'saintaquinas@example.com',
    emailVerified: false,
    lastLoginNameChange: null,
    lastNameChange: null,
    nameChangeTokens: 1,
    canChangeDisplayName: true,
    nextDisplayNameChangeAllowedAt: null,
  },
  selfUser: {
    id: 4,
    name: 'saintaquinas',
    created: 0,
    loginName: 'saintaquinas',
    email: 'saintaquinas@example.com',
    emailVerified: true,
    acceptedPrivacyVersion: 1,
    acceptedTermsVersion: 1,
    acceptedUsePolicyVersion: 1,
    nameChangeTokens: 1,
  } as SelfUser | undefined,
  refreshQuery: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('urql', () => ({
  useQuery: () => [{ data: { currentUser: mocks.currentUser } }, mocks.refreshQuery],
  useMutation: () => [{ fetching: false }, vi.fn()],
}))

vi.mock('../../gql', () => ({
  graphql: (query: string) => query,
  useFragment: (_fragment: unknown, data: unknown) => data,
}))

vi.mock('../../auth/auth-utils', () => ({
  useSelfUser: () => mocks.selfUser,
}))

vi.mock('../../redux-hooks', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: () => undefined,
}))

vi.mock('../../snackbars/snackbar-overlay', () => ({
  useSnackbarController: () => ({ showSnackbar: vi.fn() }),
}))

vi.mock('../../avatars/avatar', () => ({
  Avatar: () => null,
}))

beforeAll(async () => {
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: {}, interpolation: { escapeValue: false } })
})

beforeEach(() => {
  mocks.currentUser.emailVerified = false
  mocks.selfUser = {
    id: makeSbUserId(4),
    name: 'saintaquinas',
    created: 0,
    loginName: 'saintaquinas',
    email: 'saintaquinas@example.com',
    emailVerified: true,
    acceptedPrivacyVersion: 1,
    acceptedTermsVersion: 1,
    acceptedUsePolicyVersion: 1,
    nameChangeTokens: 1,
  }
  mocks.refreshQuery.mockReset()
  mocks.dispatch.mockReset()
})

describe('client/settings/user/account-settings', () => {
  test('shows session verification immediately while the GraphQL result is stale', async () => {
    render(<UserAccountSettings />)

    expect(screen.getByText('check_circle')).toBeDefined()
    expect(screen.queryByText('error')).toBeNull()
    expect(screen.queryByTestId('verify-email-button')).toBeNull()
    await waitFor(() =>
      expect(mocks.refreshQuery).toHaveBeenCalledWith({ requestPolicy: 'network-only' }),
    )
  })

  test('does not override an unverified session with a stale verified GraphQL result', () => {
    mocks.currentUser.emailVerified = true
    mocks.selfUser = { ...mocks.selfUser!, emailVerified: false }

    render(<UserAccountSettings />)

    expect(screen.getByText('error')).toBeDefined()
    expect(screen.queryByText('check_circle')).toBeNull()
    expect(screen.getByTestId('verify-email-button')).toBeDefined()
    expect(mocks.refreshQuery).not.toHaveBeenCalled()
  })
})
