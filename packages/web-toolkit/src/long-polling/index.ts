export interface PollArgs<T> {
  fn: () => Promise<T>
  condition: (result: T) => boolean
  intervalMs: number
  maxAttempts?: number
  firstDelayMs?: number
}

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
