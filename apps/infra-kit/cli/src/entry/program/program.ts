import { Command } from 'commander'

import { commandCatalog } from 'src/entry/command-catalog'

import { registerGlobalOptions, registerLifecycleHooks } from './lifecycle'
import { registerConfigCommands } from './register/config'
import { registerDeployCommands, registerDeprecatedLocalCommands } from './register/deploy'
import { registerDevCommands } from './register/dev'
import {
  registerAuditCommand,
  registerDoctorCommand,
  registerInfoCommands,
  registerSetupCommand,
} from './register/diagnostics'
import { registerEnvCommands } from './register/env'
import { registerReleaseCommands } from './register/release'
import { registerVendorCommands } from './register/vendor'
import { registerWorktreesCommands } from './register/worktrees'

/**
 * Side-effect-free construction of the Commander program. It is deliberately isolated from
 * `src/entry/cli.ts` (which runs `warnIfLocalInstall()`, `maybeAutoUpdate()`, and a top-level `await`
 * at module load) so a test — or the session shell — can import and walk the command tree WITHOUT
 * triggering those boot side effects. `cli.ts` calls `buildProgram()` once and owns everything else.
 *
 * This file only composes: each domain's commands live in `./register/<domain>.ts`, the flags and
 * hooks every command shares in `./lifecycle.ts`.
 */

/**
 * Build the full Commander program: ONE surface per command (the grouped form — `release create`, never
 * `release-create`), plus `--json` on every command and the pre-action hooks. Pure: no I/O, no
 * top-level await, no process mutation — safe to import from a test to introspect the command tree.
 *
 * @example
 * const program = buildProgram()
 * program.commands.some((c) => c.name() === 'doctor') // => true
 */
export const buildProgram = (): Command => {
  // `-C` is git's spelling and, like git's, it is ROOT-ONLY: `infra-kit -C <dir> release list`. It is
  // applied by zx's `cd` in the preAction hook (`./lifecycle.ts`), FIRST, so every cwd reader downstream
  // (`getProjectRoot`, the layer-3 seed, `commandEcho`) sees one directory. Capital `-C` so it never
  // collides with the `-c <config>` leaf option on `env-load`; Commander keeps them apart regardless.
  const program = new Command().option(
    '-C <dir>',
    'Run as if infra-kit was started in <dir> instead of the current working directory',
  )

  // Registration order is the `--help` order. A new command goes into the `register/` module of its
  // domain (or a new module, added to this list) — nothing else in this file changes.
  registerReleaseCommands(program)
  registerWorktreesCommands(program)
  registerConfigCommands(program)
  registerDeprecatedLocalCommands(program)
  registerAuditCommand(program)
  registerDeployCommands(program)
  registerVendorCommands(program)
  registerDoctorCommand(program, commandCatalog)
  registerDevCommands(program)
  registerSetupCommand(program)
  registerInfoCommands(program)
  registerEnvCommands(program)

  // After the last command: both walk the tree that exists at call time.
  registerGlobalOptions(program)
  registerLifecycleHooks(program)

  return program
}
