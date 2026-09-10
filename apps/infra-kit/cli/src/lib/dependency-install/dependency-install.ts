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

import { assessRecipe, formatRecipe } from 'src/lib/dependency-install/risk-predicate'
import type { RiskContext } from 'src/lib/dependency-install/risk-predicate'
import type { Recipe } from 'src/lib/dependency-registry'
import { isMcpMode } from 'src/lib/mcp-mode'
import { packageManagerInstallEnv } from 'src/lib/pm-env'

export type InstallOutcome =
  | { ran: true; ok: boolean; commands: string[]; failedStep?: string; detail?: string }
  | { ran: false; commands: string[]; refusedBecause: string[] }

export interface InstallDeps {
  spawnSync?: typeof spawnSync
  env?: NodeJS.ProcessEnv
  /** Reads whether this process is serving MCP. Injected so the guard can be exercised without a server. */
  mcpMode?: () => boolean
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
 * to run unattended at all"; the MCP guard answers "may THIS caller run it" — an MCP server has no
 * human watching and is the wrong authority regardless of how safe the recipe is.
 */
export const runRecipe = (recipe: Recipe, context: RiskContext, deps: InstallDeps = {}): InstallOutcome => {
  const spawn = deps.spawnSync ?? spawnSync
  const env = deps.env ?? process.env
  const inMcpMode = (deps.mcpMode ?? isMcpMode)()
  const commands = formatRecipe(recipe)
  const verdict = assessRecipe(recipe, context)

  if (!verdict.executable) return { ran: false, commands, refusedBecause: verdict.reasons }

  // Deliberately AFTER the recipe verdict and independent of it: a caller that is allowed to ask is
  // still refused an unsafe recipe, and a safe recipe is still refused to a caller with no human.
  if (inMcpMode) return { ran: false, commands, refusedBecause: ['mcp-mode'] }

  return execute(recipe, spawn, env, commands)
}

/**
 * `cwd` is pinned to the home directory as a security control, not for tidiness: npm resolves
 * `registry=` from an `.npmrc` relative to the cwd, so inheriting the caller's would let any repo you
 * happen to be standing in redirect an `install -g` to a registry of its choosing and run that
 * package's lifecycle scripts. Stripping env vars cannot close that — the redirect lives in a file.
 */
const execute = (
  recipe: Recipe,
  spawn: typeof spawnSync,
  env: NodeJS.ProcessEnv,
  commands: string[],
): InstallOutcome => {
  const childEnv = scrubbed(env)

  for (const [index, step] of recipe.steps.entries()) {
    const result = spawn(step[0] as string, step.slice(1), {
      stdio: 'inherit',
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
 * Name the failure mode rather than collapsing it into an exit code.
 *
 * An `EACCES` from a global install is reported with the command, never retried under `sudo`: silently
 * escalating privileges to write a global directory is not something an installer may decide to do.
 */
const describeFailure = (result: ReturnType<typeof spawnSync>): string | null => {
  if (result.error) return `could not start: ${result.error.message}`
  if (result.signal) return `terminated by signal ${result.signal}`
  if (result.status !== 0) return `exited ${result.status ?? 'unknown'}`

  return null
}
