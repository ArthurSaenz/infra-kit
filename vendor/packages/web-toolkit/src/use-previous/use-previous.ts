import { useEffect, useRef } from 'react'

/**
 * Returns the previous value of a given variable.
 * @param value The current value you want to track.
 * @returns The value from the previous render, or undefined on the initial render.
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined)

  // Update ref with the latest value after each render
  useEffect(() => {
    ref.current = value
  }, [value])

  return ref.current
}
