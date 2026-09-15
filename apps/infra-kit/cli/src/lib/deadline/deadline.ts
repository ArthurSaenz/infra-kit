/**
 * @fileoverview
 *
 * "Resolve, or `null` after `ms`" — the deadline the MCP argument-form path runs on, shared by the
 * chokepoint (`lib/tool-handler/argument-form.ts`) and any provider that bounds its own slow work
 * inside that chokepoint's budget.
 *
 * NOT the same contract as the `withDeadline` in `lib/mcp-proxy/upstream.ts`, and deliberately not
 * unified with it: that one REJECTS on timeout, because a proxy that never got `initialize` back
 * must fail loudly. This one collapses timeout AND rejection into `null`, because every caller here
 * treats "too slow" and "failed" alike — from the human's side both mean "nothing was offered".
 *
 * It abandons, it does not cancel: `work` keeps running after the deadline fires.
 */

/** Resolve `work`, or `null` if it rejects or outruns `ms`. */
export const withDeadline = async <T>(work: Promise<T>, ms: number): Promise<T | null> => {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      resolve(null)
    }, ms)

    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}
