import { runGit, shortSha } from './git'

/**
 * The commit subject for a sync.
 *
 * @example
 * syncCommitMessage('starter-workspace', 'a1b2c3d4e5') // => '[ROOT] vendor: sync from starter-workspace@a1b2c3d'
 */
export const syncCommitMessage = (sourceName: string, headSha: string): string => {
  return `[ROOT] vendor: sync from ${sourceName}@${shortSha(headSha)}`
}

export type CommitResult = { ok: true } | { ok: false; output: string }

const gitOutput = (error: unknown): string => {
  const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown }
  const combined = [stdout, stderr]
    .filter((part): part is string => {
      return typeof part === 'string' && part.trim().length > 0
    })
    .join('\n')
    .trim()

  return combined || String(error)
}

/**
 * Commit exactly `paths` in `targetRoot`.
 *
 * Paths travel NUL-separated on stdin as literal pathspecs, so `[id].tsx` is not a glob and a large diff
 * cannot hit the argv length limit. `add -A` stages the deletions `commit` must see; `--only` commits just
 * these paths and leaves any other pre-staged entry staged and out of the commit. A failure (e.g. a commit-msg
 * hook rejecting the subject) is returned with git's output rather than thrown, because the files stay
 * written and the caller reports the row.
 */
export const commitSyncedPaths = async (
  targetRoot: string,
  paths: readonly string[],
  message: string,
): Promise<CommitResult> => {
  if (paths.length === 0) return { ok: true }

  const pathspecs = paths.join('\0')
  const fromStdin = ['--pathspec-from-file=-', '--pathspec-file-nul']

  try {
    await runGit(targetRoot, ['--literal-pathspecs', 'add', '-A', ...fromStdin], { input: pathspecs })
    await runGit(targetRoot, ['--literal-pathspecs', 'commit', '--only', '-m', message, ...fromStdin], {
      input: pathspecs,
    })

    return { ok: true }
  } catch (error) {
    return { ok: false, output: gitOutput(error) }
  }
}
