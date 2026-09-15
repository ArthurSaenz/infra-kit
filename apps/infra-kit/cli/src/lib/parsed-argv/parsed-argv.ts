import { isAbsolute, resolve } from 'node:path'
import process from 'node:process'

/**
 * The argv Commander actually parsed for this run — captured by `entry/cli.ts` at the one place it
 * hands an argv to `parseAsync`, the interactive-menu re-entry included. Commands that need to name
 * their own invocation (a `confirmation_required` refusal's `rerun`) read it here instead of
 * `process.argv`, which the menu path never rewrites.
 */

let parsedArgv: readonly string[] | null = null
let launchCwd: string | null = null

/**
 * Record the full node-style argv (`[node, script, ...args]`) handed to `parseAsync`, and the cwd it
 * was typed in — read NOW because the `-C` chdir in `preAction` runs later, and a relative `-C` only
 * means anything against this directory.
 */
export const setParsedArgv = (argv: readonly string[]): void => {
  parsedArgv = [...argv]
  launchCwd = process.cwd()
}

const YES_FLAGS = new Set(['--yes', '-y'])

/**
 * Make every `-C <dir>` in `args` absolute against `cwd`, in place. Commander accepts both
 * `-C dir` and `-Cdir`; both are handled so the re-run is cwd-independent whichever way it was typed.
 */
const absolutizeChangeDir = (args: string[], cwd: string): string[] => {
  const out = [...args]

  for (const [index, token] of out.entries()) {
    if (token === '-C' && out[index + 1] !== undefined && !isAbsolute(out[index + 1] as string)) {
      out[index + 1] = resolve(cwd, out[index + 1] as string)
    } else if (token.startsWith('-C') && token.length > 2 && !token.startsWith('--') && !isAbsolute(token.slice(2))) {
      out[index] = `-C${resolve(cwd, token.slice(2))}`
    }
  }

  return out
}

/**
 * The argv an agent re-runs to confirm what this run refused: the captured user args with `--yes`
 * appended and any relative `-C` made absolute, so the next Bash call may run from any cwd.
 *
 * Appending is safe: no leaf uses `passThroughOptions` or `--`, and the only variadic option
 * (`--project <names...>`) stops at `--yes`. An argv that already carries `--yes`/`-y` is returned
 * as-is — a second copy would be noise, and a confirm that fired despite it is not this function's
 * problem to hide.
 *
 * @example
 * // captured: ['node', 'infra-kit', '-C', 'app', 'release', 'remove', '1.2.3', '--json'], cwd /w
 * rerunArgv() // ['-C', '/w/app', 'release', 'remove', '1.2.3', '--json', '--yes']
 */
export const rerunArgv = (): string[] => {
  if (parsedArgv === null || launchCwd === null) return ['--yes']

  const args = absolutizeChangeDir(parsedArgv.slice(2), launchCwd)

  const alreadyConfirmed = args.some((token) => {
    return YES_FLAGS.has(token)
  })

  return alreadyConfirmed ? args : [...args, '--yes']
}
