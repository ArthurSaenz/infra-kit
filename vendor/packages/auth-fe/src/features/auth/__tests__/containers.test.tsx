import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { AuthFormContainer } from '../containers/auth-form-container.js'
import { AuthProvider } from '../containers/auth-provider.js'
import { AuthVerifyContainer } from '../containers/auth-verify-container.js'
import { RequireAuthContainer } from '../containers/require-auth-container.js'
import { UserMenuContainer } from '../containers/user-menu-container.js'
import { createAuthStore } from '../services/auth-store.js'
import type { AuthClient, AuthState } from '../types.js'
import { USER } from './fixtures.js'
import type { TestUser } from './fixtures.js'

const fakeClient = (overrides: Partial<AuthClient<TestUser>> = {}): AuthClient<TestUser> => {
  return {
    requestMagicLink: vi.fn(async () => {}),
    verifyMagicLink: vi.fn(async () => {
      return { ok: true, redirect: '/chat' }
    }),
    me: vi.fn(async () => {
      return USER
    }),
    refresh: vi.fn(async () => {
      return false
    }),
    logout: vi.fn(async () => {}),
    ...overrides,
  }
}

const storeWith = (initialState: Partial<AuthState<TestUser>>, client = fakeClient()) => {
  return createAuthStore(client, { initialState })
}

describe('authFormContainer', () => {
  it('resolves an unknown session through fetchMe', async () => {
    const client = fakeClient({
      me: vi.fn(() => {
        return new Promise<TestUser>(() => {})
      }),
    })

    const screen = await render(
      <AuthProvider store={storeWith({}, client)}>
        <AuthFormContainer
          onAuthenticated={vi.fn()}
          render={(props) => {
            return <div data-testid="form">{props.status}</div>
          }}
        />
      </AuthProvider>,
    )

    await expect.element(screen.getByTestId('form')).toHaveTextContent('unknown')
    expect(client.me).toHaveBeenCalledOnce()
  })

  it('hands an authenticated visitor the safe redirect target once', async () => {
    const onAuthenticated = vi.fn()
    const store = storeWith({ status: 'authenticated', user: USER })

    // A fresh inline callback per render is what hosts write; it must not re-fire the hand-off.
    const tree = () => {
      return (
        <AuthProvider store={store}>
          <AuthFormContainer
            redirect="//evil.com"
            onAuthenticated={(target) => {
              onAuthenticated(target)
            }}
            render={() => {
              return <div data-testid="form" />
            }}
          />
        </AuthProvider>
      )
    }

    const screen = await render(tree())

    await screen.rerender(tree())

    expect(onAuthenticated).toHaveBeenCalledOnce()
    expect(onAuthenticated).toHaveBeenCalledWith('/')
  })

  it('submits with the safe redirect and exposes the sent state', async () => {
    const client = fakeClient()

    const screen = await render(
      <AuthProvider store={storeWith({ status: 'unauthenticated' }, client)}>
        <AuthFormContainer
          redirect="/chat/1"
          onAuthenticated={vi.fn()}
          render={(props) => {
            return (
              <div>
                <button
                  type="button"
                  onClick={() => {
                    void props.onSubmit({ email: 'A@B.com' })
                  }}
                >
                  send
                </button>
                <button type="button" onClick={props.onUseDifferentEmail}>
                  reset
                </button>
                <span data-testid="sent">{props.sentToEmail ?? 'none'}</span>
              </div>
            )
          }}
        />
      </AuthProvider>,
    )

    await screen.getByRole('button', { name: 'send' }).click()
    await expect.element(screen.getByTestId('sent')).toHaveTextContent('a@b.com')
    expect(client.requestMagicLink).toHaveBeenCalledWith({ email: 'a@b.com', redirectUrl: '/chat/1' })

    await screen.getByRole('button', { name: 'reset' }).click()
    await expect.element(screen.getByTestId('sent')).toHaveTextContent('none')
  })
})

describe('authVerifyContainer', () => {
  const renderVerify = (token: string | undefined, client: AuthClient<TestUser>, onVerified = vi.fn()) => {
    return render(
      <AuthProvider store={storeWith({}, client)}>
        <AuthVerifyContainer
          token={token}
          redirect="/fallback"
          onVerified={onVerified}
          render={(state) => {
            return <div data-testid="verify">{state}</div>
          }}
        />
      </AuthProvider>,
    )
  }

  it('errors without a token', async () => {
    const screen = await renderVerify(undefined, fakeClient())

    await expect.element(screen.getByTestId('verify')).toHaveTextContent('error')
  })

  it('errors when verification fails', async () => {
    const screen = await renderVerify(
      'bad',
      fakeClient({
        verifyMagicLink: vi.fn(async () => {
          return { ok: false, errorCode: 'INVALID_OR_EXPIRED_TOKEN' }
        }),
      }),
    )

    await expect.element(screen.getByTestId('verify')).toHaveTextContent('error')
  })

  it('errors when the user cannot be loaded after a verified token', async () => {
    const screen = await renderVerify(
      'good',
      fakeClient({
        me: vi.fn(async () => {
          throw Object.assign(new Error('401'), { status: 401 })
        }),
      }),
    )

    await expect.element(screen.getByTestId('verify')).toHaveTextContent('error')
  })

  it('hands the verified redirect over once the user is loaded', async () => {
    const onVerified = vi.fn()

    await renderVerify('good', fakeClient(), onVerified)

    await vi.waitFor(() => {
      expect(onVerified).toHaveBeenCalledWith('/chat')
    })
  })

  it('falls back to the redirect prop when the response has none', async () => {
    const onVerified = vi.fn()

    await renderVerify(
      'good',
      fakeClient({
        verifyMagicLink: vi.fn(async () => {
          return { ok: true }
        }),
      }),
      onVerified,
    )

    await vi.waitFor(() => {
      expect(onVerified).toHaveBeenCalledWith('/fallback')
    })
  })
})

describe('userMenuContainer', () => {
  const renderMenu = (state: Partial<AuthState<TestUser>>, onLoggedOut = vi.fn()) => {
    const store = storeWith(state)

    return {
      store,
      screen: render(
        <AuthProvider store={store}>
          <UserMenuContainer<TestUser>
            onLoggedOut={onLoggedOut}
            render={(props) => {
              return (
                <button
                  type="button"
                  onClick={() => {
                    return void props.onLogout()
                  }}
                >
                  {props.user.email}
                </button>
              )
            }}
          />
        </AuthProvider>,
      ),
    }
  }

  it('renders nothing when not authenticated', async () => {
    const { screen } = renderMenu({ status: 'unauthenticated' })

    expect((await screen).container.querySelector('button')).toBeNull()
  })

  it('logs out, clears the session, then calls onLoggedOut', async () => {
    const onLoggedOut = vi.fn()
    const { store, screen } = renderMenu({ status: 'authenticated', user: USER }, onLoggedOut)

    await (await screen).getByRole('button', { name: USER.email }).click()

    await vi.waitFor(() => {
      expect(onLoggedOut).toHaveBeenCalledOnce()
    })
    expect(store.getState()).toMatchObject({ status: 'unauthenticated', user: null })
  })
})

describe('requireAuthContainer', () => {
  const renderGuard = (
    state: Partial<AuthState<TestUser>>,
    options: { onUnauthenticated?: () => void; isAllowed?: (user: TestUser) => boolean } = {},
  ) => {
    return render(
      <AuthProvider store={storeWith(state)}>
        <RequireAuthContainer<TestUser>
          onUnauthenticated={options.onUnauthenticated ?? vi.fn()}
          onLoggedOut={vi.fn()}
          fallback={<div data-testid="fallback" />}
          isAllowed={options.isAllowed}
          renderDenied={(props) => {
            return <div data-testid="denied">{props.user.email}</div>
          }}
        >
          <div data-testid="protected" />
        </RequireAuthContainer>
      </AuthProvider>,
    )
  }

  it('mounts the children for an allowed user', async () => {
    const screen = await renderGuard(
      { status: 'authenticated', user: USER },
      {
        isAllowed: () => {
          return true
        },
      },
    )

    await expect.element(screen.getByTestId('protected')).toBeInTheDocument()
  })

  it('renders the denied slot, never the children, for a user isAllowed rejects', async () => {
    const screen = await renderGuard(
      { status: 'authenticated', user: USER },
      {
        isAllowed: () => {
          return false
        },
      },
    )

    await expect.element(screen.getByTestId('denied')).toHaveTextContent(USER.email)
    expect(screen.container.querySelector('[data-testid="protected"]')).toBeNull()
  })

  it('shows the fallback and calls onUnauthenticated for a signed-out visitor', async () => {
    const onUnauthenticated = vi.fn()
    const screen = await renderGuard({ status: 'unauthenticated' }, { onUnauthenticated })

    await expect.element(screen.getByTestId('fallback')).toBeInTheDocument()
    expect(onUnauthenticated).toHaveBeenCalledOnce()
    expect(screen.container.querySelector('[data-testid="protected"]')).toBeNull()
  })

  it('resolves an unknown session into the children', async () => {
    const screen = await renderGuard({})

    await expect.element(screen.getByTestId('protected')).toBeInTheDocument()
  })
})

describe('authProvider', () => {
  it('fails loudly when a container is rendered without it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      render(
        <UserMenuContainer
          onLoggedOut={vi.fn()}
          render={() => {
            return null
          }}
        />,
      ),
    ).rejects.toThrow('useAuthStore must be used inside <AuthProvider>')

    consoleError.mockRestore()
  })
})
