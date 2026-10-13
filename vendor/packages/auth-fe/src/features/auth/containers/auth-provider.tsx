import { AuthContext } from '../services/auth-context.js'
import type { AuthProviderProps } from '../types.js'

export const AuthProvider = <TUser,>(props: AuthProviderProps<TUser>) => {
  const { store, children } = props

  return <AuthContext value={store as AuthProviderProps<unknown>['store']}>{children}</AuthContext>
}
