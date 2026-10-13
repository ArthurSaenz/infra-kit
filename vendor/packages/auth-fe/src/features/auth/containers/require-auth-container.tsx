import { useEffect } from 'react'

import { useAuth, useAuthStore } from '../services/auth-context.js'
import { useLatest } from '../services/use-latest.js'
import type { AuthState, RequireAuthContainerProps } from '../types.js'

export const RequireAuthContainer = <TUser,>(props: RequireAuthContainerProps<TUser>) => {
  const { onUnauthenticated, onLoggedOut, fallback, isAllowed, renderDenied, children } = props

  const store = useAuthStore<TUser>()
  const status = useAuth((state: AuthState<TUser>) => {
    return state.status
  })
  const user = useAuth((state: AuthState<TUser>) => {
    return state.user
  })

  const onUnauthenticatedRef = useLatest(onUnauthenticated)

  useEffect(() => {
    if (status === 'unknown') {
      void store.fetchMe()
    } else if (status === 'unauthenticated') {
      onUnauthenticatedRef.current()
    }
  }, [status, store, onUnauthenticatedRef])

  if (status === 'authenticated' && user) {
    // A signed-in user the host does not allow never mounts the protected tree.
    if (isAllowed && !isAllowed(user)) {
      return (
        <>
          {renderDenied?.({
            user,
            onLogout: async () => {
              await store.logout()
              await onLoggedOut()
            },
          }) ?? null}
        </>
      )
    }

    return <>{children}</>
  }

  return <>{fallback}</>
}
