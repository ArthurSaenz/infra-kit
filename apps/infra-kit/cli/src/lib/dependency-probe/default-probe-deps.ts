/**
 * The production wiring of {@link ProbeDeps} — the one implementation that actually shells out.
 *
 * It lives beside the probe rather than inside `dependency-probe.ts` because that module's whole
 * discipline is "no `spawn`, no `zx`, no `fs`", and beside the probe rather than inside
 * `lib/dependency-plan` because `doctor` needs it too: doctor may read the registry and the probe, and
 * must never reach the install recipes (`probe-argv-single-source.test.ts`). Housing the factory in the
 * planner would have forced doctor to import the module that owns `bootstrapInstall` / `updateFor` — or
 * to keep a second copy of the `$HOME/.local/bin` search, whose drift would make doctor and `setup`
 * disagree about whether a tool is installed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { safeRealpath } from 'src/lib/install-manager'
import { quietShell } from 'src/lib/quiet-shell'

import type { ProbeDeps } from './dependency-probe'

/**
 * Where a tool can live besides `PATH`.
 *
 * The AWS-documented installer writes `$HOME/.local/bin`, which is frequently not on `PATH` — the whole
 * reason `present` and `onPath` are separate. Searching these reports a real install as
 * installed-but-unreachable, with the `PATH` fix, instead of "not installed" plus an install command
 * that would run the installer a second time.
 */
const extraBinDirs = (): string[] => {
  return [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

/** `command -v`, so a shell-managed PATH (asdf, mise, nvm shims) is honoured rather than guessed at. */
const resolveOnPath = async (binName: string): Promise<string | null> => {
  try {
    const result = await quietShell()`command -v ${binName}`

    return result.stdout.trim() || null
  } catch {
    return null
  }
}

export const defaultProbeDeps = (): ProbeDeps => {
  return {
    runCommand: async (argv) => {
      const result = await quietShell()`${argv}`

      // stderr, not stdout, is where several of these print their version — `aws --version` is the
      // everyday case. Concatenating is what keeps `versionFrom` from silently returning null.
      return { stdout: `${result.stdout}\n${result.stderr}` }
    },
    resolveBinPath: async (binName) => {
      const onPath = await resolveOnPath(binName)

      if (onPath !== null) return onPath

      return (
        extraBinDirs()
          .map((dir) => {
            return path.join(dir, binName)
          })
          .find((candidate) => {
            return fs.existsSync(candidate)
          }) ?? null
      )
    },
    realpath: safeRealpath,
    platform: process.platform,
  }
}
