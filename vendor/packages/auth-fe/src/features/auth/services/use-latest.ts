import { useLayoutEffect, useRef } from 'react'

/**
 * A ref that always holds the latest `value`. The containers keep host callbacks in one so an
 * inline `onAuthenticated={(to) => navigate(to)}` does not re-run their session effects (and
 * re-navigate) on every render.
 *
 * @example
 *     const onVerifiedRef = useLatest(onVerified)
 */
export const useLatest = <T>(value: T) => {
  const ref = useRef(value)

  useLayoutEffect(() => {
    ref.current = value
  })

  return ref
}
