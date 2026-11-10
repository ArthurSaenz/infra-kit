import type { DependencyState } from 'src/lib/dependency-probe'

/**
 * What the probe knows about one external tool, riding along on the row that already answers "is it
 * installed" — so an agent asking that question reads ONE list, never a sibling array with its own
 * semantics. Deliberately probe facts ONLY: no `action`, no `commands`. Widening it to the install
 * report is how `doctor --fix` would arrive by another door, and `probe-argv-single-source.test.ts`
 * asserts the absence of those two keys at the type level for that reason.
 *
 * `present` and `onPath` are separate because they genuinely disagree: the AWS-documented installer
 * writes `$HOME/.local/bin`, so `aws` can be `status: 'fail'` (the row means "resolves on PATH") while
 * `detail.present` is `true`.
 */
export interface DependencyDetail {
  manager: DependencyState['manager']
  version: string | null
  present: boolean
  onPath: boolean
}

/**
 * One diagnosis. `name` is a stable public identifier — it is returned under `--json`, keyed by the
 * report's section map (`report.ts`), and pasted into bug reports — so renaming one is a breaking change.
 *
 * `detail` is OPTIONAL and carried by the five dependency rows alone, which is what keeps the ~23 other
 * check functions untouched. `portless installed` deliberately has none: it resolves out of
 * `node_modules` rather than off `PATH`, so a probe payload would describe a different question than
 * the row asks (`probe-argv-single-source.test.ts`).
 */
export interface CheckResult {
  name: string
  /**
   * `warn` is a third verdict, not a soft fail: the report counts it apart, `--fix` never claims it,
   * and `allPassed` ignores it. It is for a state that works today but should not be left — a setting
   * that defeats a guard the CLI relies on (`Agent allowlist`), a service pointed at a path that will
   * go away (`portless service target`) — where red would be a lie and green would hide it.
   *
   * `skip` is a check that could not be evaluated, which is neither a pass nor a failure: counting it
   * as a pass claims a look that never happened, and omitting the row reads as "nothing to report"
   * when it means "never looked". `allPassed` ignores it, like `warn`; the message says why.
   */
  status: 'pass' | 'fail' | 'warn' | 'skip'
  message: string
  detail?: DependencyDetail
}

/**
 * The `allPassed` verdict: no row failed. A warning is advisory and a skip is not a verdict at all (see
 * {@link CheckResult}), so neither unsets it.
 *
 * @example
 * allChecksPassed([{ name: 'portless routes', status: 'skip', message: 'portless not resolvable' }]) // => true
 */
export const allChecksPassed = (checks: readonly CheckResult[]): boolean => {
  return checks.every((check) => {
    return check.status !== 'fail'
  })
}
