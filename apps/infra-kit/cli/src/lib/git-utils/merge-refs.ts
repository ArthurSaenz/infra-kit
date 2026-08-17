import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'

/**
 * Resolve a ref to a commit sha, or `null` when it does not exist.
 *
 * Callers must run this BEFORE {@link isAncestor} on any ref that might be gone:
 * `git merge-base --is-ancestor` exits 128 on an unknown ref, which is a fatal,
 * not a boolean — so a release branch deleted on origin between the PR listing
 * and the fetch would abort the whole run instead of failing that one branch.
 */
export const revParseVerify = async (cwd: string, ref: string): Promise<string | null> => {
  const commitish = `${ref}^{commit}`

  try {
    const result = await $({ cwd, quiet: true })`git rev-parse --verify --quiet ${commitish}`

    return result.stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Whether `ancestor` is already contained in `descendant`.
 *
 * This is the idempotency probe for the whole command: when `origin/dev` is
 * already an ancestor of `origin/<branch>`, that branch needs no merge, no
 * checkout, and no refspec. It is also what makes a re-run after a partially
 * rejected push safe rather than duplicative.
 *
 * Exit 0 = contained, exit 1 = not. Anything else (notably 128 on an unknown
 * ref) is a programming error at the call site, so it propagates rather than
 * being flattened into `false` — a silent `false` would re-merge a branch that
 * was already done.
 */
export const isAncestor = async (cwd: string, ancestor: string, descendant: string): Promise<boolean> => {
  try {
    await $({ cwd, quiet: true })`git merge-base --is-ancestor ${ancestor} ${descendant}`

    return true
  } catch (error) {
    const exitCode = (error as { exitCode?: number }).exitCode

    if (exitCode === 1) return false

    throw new OperationError(error, {
      operation: `test whether ${ancestor} is contained in ${descendant}`,
      remediation: 'both refs must exist — verify them with rev-parse first',
    })
  }
}

/** The sha `origin` currently holds for a branch, or `null` when it has none. */
export const lsRemoteHead = async (cwd: string, branch: string): Promise<string | null> => {
  const result = await $({ cwd, quiet: true })`git ls-remote --heads origin ${branch}`
  const line = result.stdout.trim().split('\n')[0]

  return line ? (line.split(/\s+/)[0] ?? null) : null
}

export interface AtomicPushRef {
  branch: string
  sha: string
}

export interface AtomicPushResult {
  /** Refspecs exactly as handed to git — printed before the push so the transcript names what was in flight. */
  refspecs: string[]
  pushed: boolean
  /** Raw stderr on failure, for the report to quote rather than paraphrase. */
  stderr?: string
}

/**
 * Push every merge in one all-or-nothing `git push --atomic`.
 *
 * Atomicity is the whole point: a per-branch loop leaves 2^N possible outcomes
 * on a failure, and reconstructing which branches landed means inspecting every
 * remote by hand. With `--atomic`, one non-fast-forwardable ref leaves *every*
 * ref unchanged on origin.
 *
 * Deliberately never forced. No `--force`, no `--force-with-lease`, no `+`
 * refspec: each ref stays individually fast-forward-checked, so a teammate's
 * push landing between the plan and the apply loses safely — the push is
 * rejected and nothing is overwritten. A rejection here is a correct outcome,
 * not a bug to route around.
 */
export const pushAtomic = async (cwd: string, refs: AtomicPushRef[]): Promise<AtomicPushResult> => {
  const refspecs = refs.map((ref) => {
    return `${ref.sha}:refs/heads/${ref.branch}`
  })

  if (refspecs.length === 0) {
    return { refspecs, pushed: false }
  }

  try {
    await $({ cwd, quiet: true })`git push --atomic origin ${refspecs}`

    return { refspecs, pushed: true }
  } catch (error) {
    return {
      refspecs,
      pushed: false,
      stderr: (error as { stderr?: string }).stderr,
    }
  }
}
