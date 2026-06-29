export interface PollArgs<T> {
  fn: () => Promise<T>
  condition: (result: T) => boolean
  intervalMs: number
  maxAttempts?: number
  firstDelayMs?: number
}

/**
 * Polls an async function at a fixed interval until a condition is no longer met or the attempt limit is reached.
 *
 * @example
 *     const result = await poll({
 *         fn: () => fetchStatus(jobId),
 *         condition: (res) => res.status === 'pending',
 *         intervalMs: 2000,
 *         maxAttempts: 10,
 *     })
 *
 */
export const poll = async <T>(args: PollArgs<T>): Promise<T> => {
  const { fn, condition, intervalMs, maxAttempts = 10, firstDelayMs = 0 } = args

  if (firstDelayMs > 0) {
    await new Promise((r) => {
      return setTimeout(r, firstDelayMs)
    })
  }

  let result = await fn()
  let attempts = 0

  while (condition(result) && attempts < maxAttempts) {
    await wait(intervalMs)
    attempts++
    result = await fn()
  }

  return result
}

const wait = async (ms: number): Promise<void> => {
  await new Promise((r) => {
    return setTimeout(r, ms)
  })
}
