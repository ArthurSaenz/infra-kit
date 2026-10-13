import { useAuth, useAuthStore } from '../services/auth-context.js'
import type { AuthState, UserMenuContainerProps } from '../types.js'

export const UserMenuContainer = <TUser,>(props: UserMenuContainerProps<TUser>) => {
  const { onLoggedOut, render } = props

  const store = useAuthStore<TUser>()
  const status = useAuth((state: AuthState<TUser>) => {
    return state.status
  })
  const user = useAuth((state: AuthState<TUser>) => {
    return state.user
  })

  if (status !== 'authenticated' || !user) return null

  return render({
    user,
    onLogout: async () => {
      await store.logout()
      await onLoggedOut()
    },
  })
}
