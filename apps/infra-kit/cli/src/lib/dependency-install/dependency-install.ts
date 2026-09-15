/**
 * The only module in the package that spawns an installer.
 *
 * Everything it may run has already been narrowed by {@link assessRecipe}; what is added here is the
 * execution environment those recipes get, and the two refusals that are about WHO is asking rather
 * than about the recipe itself.
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import process from 'node:process'

import { isAgentMode } from 'src/lib/agent-mode'
import { assessRecipe, formatRecipe } from 'src/lib/dependency-install/risk-predicate'
import type { RiskContext } from 'src/lib/dependency-install/risk-predicate'
import type { Recipe } from 'src/lib/dependency-registry'
import { logger } from 'src/lib/logger'
import { packageManagerInstallEnv } from 'src/lib/pm-env'

export type InstallOutcome =
  | { ran: true; ok: boolean; commands: string[]; failedStep?: string; detail?: string }
  | { ran: false; commands: string[]; refusedBecause: string[] }

export interface InstallDeps {
  spawnSync?: typeof spawnSync
  env?: NodeJS.ProcessEnv
  /** Reads whether an agent is driving this process. Injected so the guard can be exercised without a server. */
  agentMode?: () => boolean
  /** Where a step announces itself before it runs. Injected so a test reads narration without stderr. */
  notify?: (line: string) => void
}

/**
 * Environment variables that make Homebrew's installer behave differently from the one a human runs.
 *
 * `install.sh` sets `NONINTERACTIVE=1` itself when stdin is not a TTY and then probes for sudo with
 * `sudo -n`, which never prompts — so off a TTY it aborts or proceeds depending on whether some
 * unrelated earlier command left a sudo timestamp cached. We never set any of these; scrubbing them
 * means an inherited value cannot silently choose that branch for us either.
 */
const BREW_ENV_SCRUB = ['NONINTERACTIVE', 'CI', 'INTERACTIVE', 'HAVE_SUDO_ACCESS', 'SUDO_ASKPASS']

const scrubbed = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...packageManagerInstallEnv(env) }

  for (const key of BREW_ENV_SCRUB) delete copy[key]

  return copy
}

/**
 * Run one recipe, or refuse and hand back the argv.
 *
 * Two refusals, and they are about different things. {@link assessRecipe} answers "is this recipe safe
 * to run unattended at all"; the agent guard answers "may THIS caller run it" — an agent has no
 * human watching and is the wrong authority regardless of how safe the recipe is.
 */
export const runRecipe = (recipe: Recipe, context: RiskContext, deps: InstallDeps = {}): InstallOutcome => {
  const spawn = deps.spawnSync ?? spawnSync
  const env = deps.env ?? process.env
  const inAgentMode = (deps.agentMode ?? isAgentMode)()
  const commands = formatRecipe(recipe)
  const verdict = assessRecipe(recipe, context)

  if (!verdict.executable) return { ran: false, commands, refusedBecause: verdict.reasons }

  // Deliberately AFTER the recipe verdict and independent of it: a caller that is allowed to ask is
  // still refused an unsafe recipe, and a safe recipe is still refused to a caller with no human.
  if (inAgentMode) return { ran: false, commands, refusedBecause: ['agent-mode'] }

  return execute({ recipe, spawn, env, commands, notify: deps.notify ?? announce })
}

/** The default narrator: the same two-column shape `setup`'s summary uses, so the run reads as one list. */
const announce = (line: string): void => {
  logger.info(line)
}

/**
 * How much of one step's output is held in memory.
 *
 * Node's default is 1 MiB, and at the limit `spawnSync` does not truncate — it SIGTERMs the child and
 * returns `ENOBUFS`. A `brew install` building from source clears 1 MiB routinely, so the default would
 * kill installs halfway through, something `stdio: 'inherit'` could never do. 64 MiB is chosen to sit
 * above any real installer's output; the ceiling still exists, so {@link describeFailure} names it
 * rather than reporting the kill as something else.
 */
const MAX_CAPTURED_MIB = 64
const MAX_CAPTURED_BYTES = MAX_CAPTURED_MIB * 1024 * 1024

interface ExecuteOptions {
  recipe: Recipe
  spawn: typeof spawnSync
  env: NodeJS.ProcessEnv
  commands: string[]
  notify: (line: string) => void
}

/**
 * `cwd` is pinned to the home directory as a security control, not for tidiness: npm resolves
 * `registry=` from an `.npmrc` relative to the cwd, so inheriting the caller's would let any repo you
 * happen to be standing in redirect an `install -g` to a registry of its choosing and run that
 * package's lifecycle scripts. Stripping env vars cannot close that — the redirect lives in a file.
 */
// Output is CAPTURED, not inherited. Inherited, brew's and npm's chatter interleaved with the summary
// this command exists to print — an "already installed" warning and a `changed 1 package in 224ms` read
// as findings when they are noise. Capturing costs nothing in diagnosis, because the one thing that
// output was good for, a failing step's own error message, is what `describeFailure` now reports; and
// nothing in progress, because each step announces itself before it runs.
//
// It does cost a CEILING, which inheriting did not have, and that is what `maxBuffer` is for.
const execute = ({ recipe, spawn, env, commands, notify }: ExecuteOptions): InstallOutcome => {
  const childEnv = scrubbed(env)

  for (const [index, step] of recipe.steps.entries()) {
    notify(`  ${'running'.padEnd(9)} ${commands[index]}`)

    const result = spawn(step[0] as string, step.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURED_BYTES,
      cwd: homedir(),
      env: childEnv,
    })

    const failure = describeFailure(result)

    // Stop at the first failure rather than pressing on: doppler's second step is meaningless without
    // gnupg, and a "successful" install that skipped signature verification is the worst outcome here.
    if (failure !== null) return { ran: true, ok: false, commands, failedStep: commands[index], detail: failure }
  }

  return { ran: true, ok: true, commands }
}

/**
 * How many trailing lines of the child's own output a failure detail carries.
 *
 * Five rather than one or two because npm ends with a log-file path and a blank, brew with a hint after
 * its `Error:` line, and the diagnosis sits above them.
 */
const FAILURE_CONTEXT_LINES = 5

/**
 * Lines that name themselves as the failure. Every installer here writes one, and it is rarely the last.
 *
 * The keyword must open the line or sit right before a separator, because an unanchored `\berror\b`
 * also matches inside a package name: brew's `==> Downloading error-prone-2.x.bottle.tar.gz` is a
 * progress line, not a diagnosis, and promoting it would bury the real one.
 */
const ERROR_SHAPED = /^(?:error|fatal|warning: failed|[a-z-]{0,20} ERR!)[:\s]/i

/**
 * The non-blank lines of one captured stream, trimmed.
 *
 * Typed loosely and guarded because `spawnSync`'s return type says `string | Buffer` and says nothing
 * about the streams being absent — which they are whenever `stdio` did not pipe them, and in the test
 * fixtures that stub a result by hand.
 */
const outputLines = (stream: unknown): string[] => {
  if (stream == null) return []

  return String(stream)
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })
}

/**
 * The child's own last words: the error-shaped lines if it wrote any, otherwise the tail of one stream.
 *
 * Ranking by CONTENT before stream is what stops brew's `==> Downloading` progress — which brew writes
 * to stderr on a run that then fails — from burying a diagnosis it wrote to stdout.
 *
 * When nothing names itself the fallback is ONE stream, not the concatenation: the last lines of
 * `[...stderr, ...stdout]` are always stdout's, which would silently drop an unlabelled stderr
 * diagnosis whenever the child also wrote a few lines of stdout. stderr wins that tie-break, being
 * where a failing process is expected to have said something.
 */
const lastWords = (result: ReturnType<typeof spawnSync>): string => {
  const stderr = outputLines(result.stderr)
  const stdout = outputLines(result.stdout)
  const named = [...stderr, ...stdout].filter((line) => {
    return ERROR_SHAPED.test(line)
  })
  const fallback = stderr.length > 0 ? stderr : stdout

  return (named.length > 0 ? named : fallback).slice(-FAILURE_CONTEXT_LINES).join(' / ')
}

/** `spawnSync`'s code when the child outran {@link MAX_CAPTURED_BYTES}. It is a kill, not a start failure. */
const OUTPUT_LIMIT_CODE = 'ENOBUFS'

/** Did this result come from the buffer ceiling rather than from the child's own behaviour? */
const hitOutputLimit = (result: ReturnType<typeof spawnSync>): boolean => {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === OUTPUT_LIMIT_CODE
}

/**
 * Name the failure mode rather than collapsing it into an exit code.
 *
 * An `EACCES` from a global install is reported with the command, never retried under `sudo`: silently
 * escalating privileges to write a global directory is not something an installer may decide to do.
 */
// Since output is captured, this is the ONLY route by which a failing installer's own sentence reaches
// the report. Without it `aws update` read as `exited 252` and the line that says why — `argument
// command: Found invalid choice 'update'` — was discarded into a pipe nobody drained.
//
// The output-limit case is tested BEFORE `result.error`, and that order is the whole point. At the
// ceiling `spawnSync` reports an `error` AND a `SIGTERM` for a child that started fine and was killed
// mid-install; letting the generic `error` branch answer first would have called that "could not start",
// which is the one description guaranteed to be false.
const describeFailure = (result: ReturnType<typeof spawnSync>): string | null => {
  if (hitOutputLimit(result)) {
    return `terminated after exceeding the ${MAX_CAPTURED_MIB} MiB output limit — it may be part-installed`
  }
  if (result.error) return `could not start: ${result.error.message}`
  if (result.signal) return `terminated by signal ${result.signal}`
  if (result.status === 0) return null

  const said = lastWords(result)
  const because = said === '' ? '' : `: ${said}`

  return `exited ${result.status ?? 'unknown'}${because}`
}
