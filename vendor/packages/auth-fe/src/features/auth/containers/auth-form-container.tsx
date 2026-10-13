import { useEffect } from 'react'

import { useAuth, useAuthStore } from '../services/auth-context.js'
import { safeRedirect } from '../services/safe-redirect.js'
import { useLatest } from '../services/use-latest.js'
import type { AuthFormContainerProps, AuthState } from '../types.js'

export const AuthFormContainer = (props: AuthFormContainerProps) => {
  const { redirect, onAuthenticated, render } = props

  const store = useAuthStore<unknown>()
  const state = useAuth((current: AuthState<unknown>) => {
    return current
  })

  const onAuthenticatedRef = useLatest(onAuthenticated)

  // Resolve an undetermined session, and hand an already-authenticated visitor back to the host.
  useEffect(() => {
    if (state.status === 'unknown') {
      void store.fetchMe()
    } else if (state.status === 'authenticated') {
      onAuthenticatedRef.current(safeRedirect(redirect))
    }
  }, [state.status, store, redirect, onAuthenticatedRef])

  return render({
    status: state.status,
    loading: state.requestLoading,
    sentToEmail: state.sentToEmail,
    error: state.requestError,
    onSubmit: (values) => {
      return store.submitEmail({ email: values.email, redirectUrl: safeRedirect(redirect) })
    },
    onUseDifferentEmail: store.resetSentEmail,
  })
}
