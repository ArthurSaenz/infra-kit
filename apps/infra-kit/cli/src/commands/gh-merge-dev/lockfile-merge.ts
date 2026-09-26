import fs from 'node:fs/promises'
import path from 'node:path'
import { $ } from 'zx'

export const LOCKFILE = 'pnpm-lock.yaml'

const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?:\s|$)/m

export type LockfileMergeResult = { ok: true } | { ok: false; reason: string }

/**
 * Merge a conflicted `pnpm-lock.yaml` deterministically: start from dev's valid lockfile, let pnpm
 * add whatever the merged manifests need on top of it, and stage the result.
 *
 * Must run only after every other conflicted path — `package.json`s included — is resolved and
 * staged, because pnpm resolves against the manifests in the working tree.
 */
// Never run pnpm on the marked lockfile: pnpm 12 prints `WARN Ignoring broken lockfile` and
// re-resolves every dependency from scratch, silently upgrading every ranged pin (measured in the
// S0 spike, .omc/plans/merge-dev-skill.md §2.0). Stage 3 is dev's side, because the merge runs on
// the release branch. `--no-frozen-lockfile` because pnpm defaults to frozen under `CI`.
export const mergeLockfile = async (worktreePath: string): Promise<LockfileMergeResult> => {
  const lockfilePath = path.join(worktreePath, LOCKFILE)
  const stage = `:3:${LOCKFILE}`

  try {
    const devSide = await $({ cwd: worktreePath, quiet: true })`git show ${stage}`

    await fs.writeFile(lockfilePath, devSide.stdout)
  } catch (error) {
    return { ok: false, reason: `dev has no ${LOCKFILE} to start from: ${stderrOf(error)}` }
  }

  try {
    await $({
      cwd: worktreePath,
      quiet: true,
    })`pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`
  } catch (error) {
    return { ok: false, reason: `pnpm could not merge ${LOCKFILE}: ${stderrOf(error)}` }
  }

  if (CONFLICT_MARKER.test(await fs.readFile(lockfilePath, 'utf8'))) {
    return { ok: false, reason: `${LOCKFILE} still carries conflict markers after pnpm ran` }
  }

  await $({ cwd: worktreePath, quiet: true })`git add -- ${LOCKFILE}`

  return { ok: true }
}

const stderrOf = (error: unknown): string => {
  const { stderr, message } = error as { stderr?: string; message?: string }

  return String(stderr || message || error).trim()
}
