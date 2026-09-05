import { vi } from 'vitest'

import { logger } from 'src/lib/logger'

/**
 * Every line a run writes through `logger.info`, captured for the duration of that run.
 *
 * Shared by the `audit` and `audit --fix` suites because printed output is the only place
 * several of their behaviours are observable at all: the summary line, the adoption-flip
 * warning and the per-file write lines never reach `structuredContent`.
 *
 * @example
 * const lines = await captureLog(() => {
 *   return audit({ all: true })
 * })
 * // => ['✅ audit passed — 8 checks, 4 targets']
 */
export const captureLog = async (run: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = []
  const spy = vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]))
  })

  try {
    await run()
  } finally {
    spy.mockRestore()
  }

  return lines
}
