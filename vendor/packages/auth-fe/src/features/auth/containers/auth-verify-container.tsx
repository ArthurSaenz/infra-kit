import { useEffect, useState } from 'react'

import { useAuthStore } from '../services/auth-context.js'
import { safeRedirect } from '../services/safe-redirect.js'
import { useLatest } from '../services/use-latest.js'
import type { AuthVerifyContainerProps, AuthVerifyState } from '../types.js'

export const AuthVerifyContainer = (props: AuthVerifyContainerProps) => {
  const { token, redirect, onVerified, render } = props

  const store = useAuthStore<unknown>()

  const [state, setState] = useState<AuthVerifyState>('idle')

  const onVerifiedRef = useLatest(onVerified)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (!token) {
        setState('error')

        return
      }

      setState('loading')

      const result = await store.verify(token)

      if (cancelled) return

      if (!result.ok) {
        setState('error')

        return
      }

      const me = await store.fetchMe()

      if (cancelled) return

      if (!me) {
        setState('error')

        return
      }

      onVerifiedRef.current(safeRedirect(result.redirect ?? redirect))
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [token, redirect, store, onVerifiedRef])

  return render(state)
}
