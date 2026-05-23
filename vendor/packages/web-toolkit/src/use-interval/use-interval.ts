import { useEffect, useRef } from 'react'

/**
 * Executes a callback function at a specified interval.
 * @param callback The function to be executed.
 * @param delay The delay in milliseconds between each execution of the callback function.
 * @param isImmediateExecuting Optional. Specifies whether the callback function should be executed immediately upon setting up the interval. Default is false.
 */
export function useInterval(callback: () => void, delay: number | null, isImmediateExecuting?: boolean) {
  const savedCallback = useRef(callback)

  // Remember the latest callback if it changes.
  useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  // Set up the interval.
  useEffect(() => {
    // Don't schedule if no delay is specified.
    // Note: 0 is a valid value for delay.
    if (!delay && delay !== 0) {
      return
    }
    if (isImmediateExecuting) savedCallback.current()

    const id = setInterval(() => {
      return savedCallback.current()
    }, delay)

    return () => {
      return clearInterval(id)
    }
  }, [delay])
}
