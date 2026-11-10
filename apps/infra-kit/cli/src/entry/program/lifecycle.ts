import type { Command } from 'commander'
import { resolve } from 'node:path'
import process from 'node:process'
import { cd } from 'zx'

import { isLongRunningCommand } from 'src/entry/command-catalog'
import { agentMode, resolveAgentModeSource } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { addJsonOption, jsonOutput } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'
import { equivalentLine } from 'src/lib/session/equivalent'
import { writeSessionReport } from 'src/lib/session/report'

import { addAgentOption } from './agent-option'
import { commandPath } from './command-path'
import { addDebugOption } from './debug-option'

// Commands excluded from the layer-3 config auto-seed: `version` touches config ZERO times today, so
// seeding is pure new cost on the fastest path. Everything else DOES seed — `doctor`, `config path`,
// `dev` and the whole `env-*` family included.
//
// `setup` is deliberately absent from this set rather than overlooked: it is the command that
// establishes this project's layer-3 override file, so excluding it would mean the setup command is the
// one command that does not set up the config. That holds for `setup --skip-tools` too — the seed is a
// local write, not a tool install, so the additive form has exactly the same business here.
const SEED_EXCLUDED = new Set(['version'])

/** `--json`, `--agent` and `--debug` on every command registered so far — call after the last one. */
export const registerGlobalOptions = (program: Command): void => {
  // Register `--json` on every command, then resolve the flag before each action
  // runs. In JSON mode we lower the logger to `warn` so the human-oriented info
  // lines stop cluttering stderr while errors still surface; the structured
  // payload is written to stdout by `emit`. No handler logic is affected.
  for (const command of program.commands) {
    addJsonOption(command)
  }

  // `--agent` rides the same recursion as `--json`, on the root too, so a skill can put it anywhere in
  // the line. Read in the hook below, never off `process.argv`.
  addAgentOption(program)

  // Register `--debug` on the root AND every subcommand. The logger already reads the flag off
  // `process.argv` at module load; this only stops Commander rejecting it as unknown first, which
  // is what made the log level unreachable from the command line.
  addDebugOption(program)
}

/** The `preAction` / `postAction` hooks every command runs through. */
export const registerLifecycleHooks = (program: Command): void => {
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    // `-C` FIRST — before the echo, before `--json`, before the seed — so nothing in
    // this hook or the action ever sees the launch cwd. Relative to where the user typed it, which is
    // what `process.cwd()` still is at this line. A bad dir throws here, before `--json` is resolved,
    // so it reaches `entry/cli.ts` as a plain stderr line and exit 1 — stated, not structured.
    //
    // zx's `cd`, NOT `process.chdir`: zx snapshots its own cwd at import and every `$\`git …\`` in the
    // tree would keep running in the launch dir (measured: after `process.chdir('/tmp')`, `$\`pwd\``
    // still printed the launch dir — `-C <repo> version --json` reported `repoRoot: null`). `cd` sets
    // both the zx cwd and `process.cwd()`.
    const { C: changeDir } = program.opts<{ C?: string }>()

    if (changeDir !== undefined) cd(resolve(process.cwd(), changeDir))

    // Bind the "📟 Equivalent command" line to the argv Commander just parsed. This is the only place
    // that knows it, so it is the only place that says it: when the commands named themselves, they
    // printed the flat `release-create`, which the grouped-only surface no longer parses — a replay line
    // that errors out. `commandPath()` is the same string the menu spawns, so what we print is runnable
    // by construction, and stays runnable through any future regrouping.
    commandEcho.start(commandPath(actionCommand))

    // `optsWithGlobals` (not `opts`) so `--json` is seen on grouped subcommands:
    // for `release list --json` Commander binds the post-subcommand flag to the
    // parent `release` group, so the leaf's own `opts()` would not carry it.
    jsonOutput.enabled = Boolean(actionCommand.optsWithGlobals().json)
    jsonOutput.command = commandPath(actionCommand)

    if (jsonOutput.enabled) {
      logger.level = 'warn'
    }

    // Resolved once, here, from the same `optsWithGlobals()` read `--json` needs.
    agentMode.source = resolveAgentModeSource({
      env: process.env,
      stdinIsTTY: process.stdin.isTTY === true,
      flag: Boolean(actionCommand.optsWithGlobals().agent),
    })

    // Layer-3 config auto-seed: ensure ~/.infra-kit/projects/<main-repo>/infra-kit.json exists (plus
    // its annotated .example.jsonc sibling) so a user always has a per-project override file to edit.
    // Self-gating: no-ops outside a git repo, and when the repo has no committed `infra-kit.json`.
    // Never throws, never changes the exit code, and performs zero writes in the steady state.
    //
    // Gated on `commandPath()`, NOT `actionCommand.name()`: a leaf's `name()` is only its last
    // segment (`config path`'s name() is just 'path'), so a name-keyed set cannot distinguish grouped
    // leaves and would collide. Nothing in SEED_EXCLUDED is a grouped leaf today, but the set must be
    // able to express one without a silent trap.
    //
    // Placed after the `--json` warn downgrade purely so a first-run `logger.info` stays out of a
    // machine consumer's stderr. That is COSMETIC, not stdout safety: `logger` is pino with
    // `destination: 2` (stderr) and `emit()` is the sole stdout writer, so the seed's log line could
    // never corrupt `--json` stdout.
    if (!SEED_EXCLUDED.has(commandPath(actionCommand))) {
      await ensureUserProjectConfig()
    }
  })

  // Session-shell side channel: after a leaf action RESOLVES (Commander runs postAction only on
  // success — never when the action throws or calls process.exit), write the report file the parent
  // reads. Its presence is what lets the parent tell a completed run from a cancel. A no-op outside a
  // session (no captured report path).
  program.hook('postAction', (_thisCommand, actionCommand) => {
    const path = commandPath(actionCommand)

    // A long-running command (`dev`) resolves its action SECONDS AFTER BOOT and then keeps running on
    // its open handles. Writing a report here would tell the parent "this produced a verdict" while the
    // server is merely starting — and report-presence is exactly how the parent tells a completed run
    // from a cancel. It would stamp a Ctrl-C out of dev `⚠ completed with findings`, and an Esc out of
    // the dev wizard `✓ ok` (claiming a server ran when none did). No report: the exit code decides.
    if (isLongRunningCommand(path)) {
      return
    }

    const snapshot = commandEcho.snapshot()
    const flags = snapshot?.formattedOptions ?? ''
    const suffix = flags ? ` ${flags}` : ''
    const line = `infra-kit ${path}${suffix}`

    writeSessionReport({ equivalent: equivalentLine(line, true) })
  })
}
