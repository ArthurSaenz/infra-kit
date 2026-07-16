#!/usr/bin/env node
// The hashbang must stay on line 1: `npm i -g` symlinks the bin and execs it
// directly, unlike pnpm's `.bin` shim which invokes `node <path>` explicitly.
// esbuild preserves it on this entry only — never on the library entries.
import select, { Separator } from '@inquirer/select'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { commandCatalog } from 'src/lib/command-catalog'
import { buildPaletteItems as buildPaletteItemsFromCommands } from 'src/lib/command-catalog/palette'
import type { PaletteItem } from 'src/lib/command-catalog/palette'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { isLocalNodeModulesInstall, safeRealpath } from 'src/lib/install-manager'
import { logger } from 'src/lib/logger'
import { suppressTypelessPackageJsonWarning } from 'src/lib/node-warnings'
import { buildProgram } from 'src/lib/program'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { formatAlignedRows } from 'src/lib/render'
import { captureSessionReportPath } from 'src/lib/session/report'
import { runSession, sessionGateEnabled } from 'src/lib/session/run-session'
import { maybeAutoUpdate } from 'src/lib/update-check'

import packageJson from '../../package.json' with { type: 'json' }

// Install BEFORE any command imports a consumer's `infra-kit.config.ts` (dev, audit, vendor-config
// all do), otherwise Node prints a MODULE_TYPELESS_PACKAGE_JSON banner naming an app package.json
// the user cannot safely add `"type": "module"` to.
suppressTypelessPackageJsonWarning()

// Capture (and delete from the env) the session-shell report path BEFORE any command runs, so the
// running command can write its report while no descendant (gh / git / a hook / $EDITOR) inherits the
// var and clobbers the file. A no-op for a normal top-level invocation (the var is unset).
captureSessionReportPath()

const program = buildProgram()

const runProgram = async (argv?: string[]): Promise<void> => {
  try {
    if (argv) {
      await program.parseAsync(argv)
    } else {
      await program.parseAsync()
    }
  } catch (error) {
    // Ctrl-C / Esc out of any prompt is a deliberate back-out, not a failure:
    // exit quietly with success so it matches the explicit "Operation cancelled."
    // decline path and never trips scripts/CI into treating a cancel as an error.
    if (isPromptCancellation(error)) {
      logger.info('Operation cancelled.')
      process.exit(0)
    }

    const message = error instanceof Error ? error.message : String(error)

    logger.error(message)
    process.exit(1)
  }
}

/**
 * Best-effort nudge when the CLI runs out of a project-local `node_modules`. Advisory only: it must never
 * throw and never change the exit code.
 *
 * The cwd clause inside `isLocalNodeModulesInstall` is what distinguishes a project-local install from a
 * global root — BOTH contain a `node_modules` segment (`pnpm root -g` is
 * `/Users/<me>/Library/pnpm/global/5/node_modules`). Without it we would nag every global pnpm user.
 *
 * `logger` is pino-pretty with `destination: 2`, i.e. stderr — never stdout, so `--json` payloads and the
 * MCP child's stdio framing stay clean. It is still suppressed for `--json` (machine consumers want no
 * chatter) and for `mcp` (that child's stdio should carry nothing but the transport).
 */
const warnIfLocalInstall = (): void => {
  try {
    if (process.env.INFRA_KIT_NO_LOCATION_WARN) return
    if (process.argv.includes('--json') || process.argv[2] === 'mcp') return

    if (isLocalNodeModulesInstall(realpathSync(fileURLToPath(import.meta.url)), process.cwd(), safeRealpath)) {
      logger.info('Running from a project-local node_modules. Install globally for faster startup: npm i -g infra-kit')
    }
  } catch {
    // Advisory only — a failure to advise is never a failure of the command.
  }
}

warnIfLocalInstall()

// Fire-and-forget: reads a cached timestamp, and at most once a day hands off to a detached
// `dist/update-check.js` that fetches, and silently installs, AFTER this process exits. Adds no
// startup latency, never throws, never changes the exit code. Opt out with INFRA_KIT_NO_AUTO_UPDATE.
maybeAutoUpdate(packageJson.version)

/**
 * Bare-invocation interactive menu: build the grouped command palette from the single command
 * catalog and let the user pick one command (returns its name, or null when nothing is picked).
 * Interactive TTY → Ink command palette, loaded lazily via dynamic import so React/Ink never touch
 * the MCP / `--json` / non-TTY code paths. Otherwise falls back to the Inquirer menu (scripts, pipes,
 * CI). Ctrl-C / Esc at the menu backs out cleanly (returns null).
 */
/**
 * Flat {name, description, group} palette list shared by the Ink palette, the Inquirer fallback, and
 * the session shell. Membership and order live in the command catalog; descriptions come from
 * Commander (single source). Each `name` is the canonical grouped path (`release create`).
 */
const buildPaletteItems = (): PaletteItem[] => {
  return buildPaletteItemsFromCommands(program.commands)
}

const runInteractiveMenu = async (): Promise<string | null> => {
  const paletteItems = buildPaletteItems()

  let selected: string | null = null

  // Ctrl-C / Esc at the menu throws — from the Ink palette as a PromptCancelledError, from the
  // inquirer fallback as an AbortPromptError (see lib/prompts/escapable-context). Either is a clean exit.
  //
  // NAME THE STREAM, always: the fallback below is taken when EITHER stream is not a tty, and the two
  // are not interchangeable. With STDOUT redirected but STDIN still a tty (`infra-kit > log.txt`) the
  // fallback runs interactively and Esc GENUINELY CANCELS it — `withEscape` keys on stdin, so its guard
  // does not fire. Only a non-tty STDIN (a pipe, CI) makes Esc inert here, and correctly so: there is no
  // keypress to receive. Saying "non-TTY" unqualified is what makes this spot read as dead code when it
  // is not.
  try {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      const { runCommandPalette } = await import('src/tui/boot')

      selected = await runCommandPalette(paletteItems)
    } else {
      const alignedLabels = formatAlignedRows(
        paletteItems.map((item) => {
          return [item.name, item.description] as const
        }),
      )

      // Headers come from the palette's own group column, which is already in MENU_GROUPS order and
      // already omits empty groups — so this cannot render a `— Label —` header over nothing, and the
      // two menu surfaces cannot list different commands.
      const choices = paletteItems.flatMap((item, index) => {
        const header =
          paletteItems[index - 1]?.group === item.group ? [] : [new Separator(' '), new Separator(`— ${item.group} —`)]

        return [...header, { name: alignedLabels[index] ?? item.name, value: item.name }]
      })

      selected = await withEscape(
        (context) => {
          return select({ message: 'Select a command to run', choices }, context)
        },
        { output: process.stderr },
      )
    }
  } catch (error) {
    // Ctrl-C / Esc at the menu is a clean back-out; leave `selected` as null.
    if (!isPromptCancellation(error)) throw error
  }

  return selected
}

/**
 * Persistent session shell: bare `infra-kit` in a capable interactive TTY keeps running after each
 * command. Each pick echoes `$ infra-kit <canonical argv>` and spawns it as a fresh child that
 * inherits this terminal, so the command's real output lands in the scrollback and stays there, closed
 * out by a status footer. React-free loop logic lives in `src/lib/session`; the Ink palette is reached
 * only through the lazy `src/tui/boot` import.
 */
const runSessionShell = async (): Promise<void> => {
  const { runCommandPalette } = await import('src/tui/boot')
  const cliPath = fileURLToPath(import.meta.url)
  // Keyed by the SAME string the palette rows carry — the space-joined group path — so a pick resolves
  // by what it displays. Keying by `cliName` worked only while every command had a flat alias to name it.
  const catalogByName = new Map(
    commandCatalog.map((entry) => {
      return [entry.groupPath.join(' '), entry]
    }),
  )

  await runSession(buildPaletteItems(), {
    renderPalette: runCommandPalette,
    resolveCommand: (name) => {
      const entry = catalogByName.get(name)

      return entry
        ? {
            groupPath: entry.groupPath,
            entersAltScreen: entry.entersAltScreen,
            sessionEnvNotice: entry.sessionEnvNotice,
            longRunning: entry.longRunning,
          }
        : undefined
    },
    cliPath,
  })
}

if (process.argv.length <= 2) {
  const streams = {
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    // The palette and the transcript both render to stderr; redirect it and the shell is unusable.
    stderrIsTTY: Boolean(process.stderr.isTTY),
  }

  if (sessionGateEnabled(process.env, streams)) {
    // A capable interactive TTY → the persistent session shell (exit code always 0).
    await runSessionShell()
  } else {
    // Pipes / CI / non-TTY / opt-out → today's one-shot behaviour and exit codes.
    const selected = await runInteractiveMenu()

    // `selected` is the grouped path (`release create`), so it must be split back into argv tokens —
    // passed whole, Commander would look for a single command literally named "release create".
    if (selected) {
      await runProgram(['node', 'infra-kit', ...selected.split(' ')])
    }
  }
} else {
  await runProgram()
}
