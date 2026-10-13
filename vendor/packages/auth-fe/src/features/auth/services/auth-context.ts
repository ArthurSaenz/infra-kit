import { createContext, useContext, useSyncExternalStore } from 'react'

import type { AuthState, AuthStore } from '../types.js'

export const AuthContext = createContext<AuthStore<unknown> | null>(null)

/**
 * The store `AuthProvider` was given — for its actions (`fetchMe`, `logout`, `refresh`, …).
 *
 * @example
 *     const { fetchMe } = useAuthStore<User>()
 */
export const useAuthStore = <TUser>(): AuthStore<TUser> => {
  const store = useContext(AuthContext)

  if (!store) throw new Error('useAuthStore must be used inside <AuthProvider>')

  return store as AuthStore<TUser>
}

const identity = <T>(value: T): T => {
  return value
}

/**
 * Subscribes to the auth state, or to the slice `selector` picks. Return a primitive or a stored
 * reference from `selector` — a fresh object each call re-renders forever.
 *
 * @example
 *     const status = useAuth((state: AuthState<User>) => state.status)
 */
export const useAuth = <TUser, TSelected = AuthState<TUser>>(
  selector: (state: AuthState<TUser>) => TSelected = identity as (state: AuthState<TUser>) => TSelected,
): TSelected => {
  const store = useAuthStore<TUser>()

  const getSnapshot = () => {
    return selector(store.getState())
  }

  // The server snapshot is the same store read: during SSR / prerender it is the initial state.
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
