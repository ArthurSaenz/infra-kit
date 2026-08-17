import { $ } from 'zx'

import {
  assertPristineWorktree,
  hasMergeInProgress,
  isAncestor,
  resetScratchWorktree,
  revParseVerify,
} from 'src/lib/git-utils'

/**
 * Terminal state of one release branch in a merge-dev run.
 *
 * `up-to-date` and `fast-forward` are successes, not degenerate cases: an
 * already-merged branch is exactly what a re-run should report, and that is what
 * makes the whole command idempotent.
 */
export type MergeStatus =
  'up-to-date' | 'fast-forward' | 'merged' | 'conflict' | 'hook-failed' | 'error' | 'not-attempted'

export interface MergePlanEntry {
  branch: string
  status: MergeStatus
  /** The merge commit to push. Absent for every non-success status. */
  mergeSha?: string
  /** Conflicted paths, for the report — never a diff, just names. */
  conflictPaths?: string[]
  /** git's own words, trimmed. The report quotes rather than paraphrases. */
  reason?: string
  /** Wall-clock for this branch, so a slow one is visible in the transcript. */
  durationMs?: number
}

const MERGE_MESSAGE_PREFIX = "Merge remote-tracking branch 'origin/dev' into "

const stderrOf = (error: unknown): string => {
  return String((error as { stderr?: string }).stderr ?? (error as { message?: string }).message ?? error).trim()
}

/**
 * Conflicted paths, by name only. `--diff-filter=U` is the authoritative list;
 * parsing merge output would be a second, weaker source of the same truth.
 */
const conflictedPaths = async (cwd: string): Promise<string[]> => {
  try {
    const result = await $({ cwd, quiet: true })`git diff --name-only --diff-filter=U`

    return result.stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
  } catch {
    return []
  }
}

/**
 * Classify a failed `git merge`.
 *
 * A conflict is identified by the presence of unmerged paths rather than by the
 * exit code, because a failing `commit-msg` / `pre-merge-commit` hook also fails
 * the merge without producing any. Keeping the two apart matters in practice:
 * the scratch worktree starts cold, so a hook that shells out to something in
 * `node_modules` can fail where the operator's own merge succeeds — a false
 * failure produced *by* the fidelity of using real `git merge`. Filing that as
 * `conflict` would send the operator hunting for a conflict that does not exist.
 *
 * **Both tests are structural, so neither depends on git's language or on what a
 * hook chose to say.** Measured: when a `commit-msg` hook rejects the merge, git
 * exits 1, writes the hook's own stderr followed by `Not committing merge; use
 * 'git commit' to complete the merge.` — and the word "hook" appears nowhere in
 * git's own output. A `/hook/i` match on the message therefore only works when
 * the hook happens to mention itself; a hook that says "policy violation" would
 * be filed as a generic `error`. What that state DOES leave behind is
 * unambiguous: `MERGE_HEAD` present with zero unmerged paths — the merge
 * resolved cleanly and was then refused at commit time.
 *
 * git's stderr is still carried as `reason`, because it holds the hook's actual
 * complaint, which is the only thing that tells the operator what to fix. It is
 * reported, never branched on.
 */
const classifyMergeFailure = async (
  cwd: string,
  error: unknown,
): Promise<{ status: MergeStatus; conflictPaths?: string[]; reason: string }> => {
  const reason = stderrOf(error)
  const paths = await conflictedPaths(cwd)

  if (paths.length > 0) return { status: 'conflict', conflictPaths: paths, reason }

  // Merged cleanly, then refused at commit time — a hook. The scratch worktree
  // starts cold, so a hook shelling into `node_modules` fails here where the
  // operator's own merge succeeds; naming it precisely is what stops them
  // hunting for a conflict that does not exist.
  if (await hasMergeInProgress(cwd)) return { status: 'hook-failed', reason }

  return { status: 'error', reason }
}

export interface PlanMergeRunArgs {
  /** Main repo root — where refs are resolved. */
  cwd: string
  /** Scratch detached worktree; merges happen here and nowhere else. */
  worktreePath: string
  branches: string[]
}

/**
 * Merge `origin/dev` into each branch inside the scratch worktree, collecting a
 * sha per success — and pushing nothing.
 *
 * Producing the plan and performing the merge are the SAME operation on purpose.
 * Any design where one engine predicts and another applies can ship a preflight
 * that disagrees with the artifact; here the thing shown to the operator is
 * literally the thing that will be pushed.
 *
 * Per-branch failures are values, never throws: one branch's conflict must not
 * change another branch's result. The `finally` around each iteration is what
 * makes that true — without it a conflicted merge left in place makes the *next*
 * `checkout --detach` fail with `error: you need to resolve your current index
 * first`, and branches k+1…N report an error that branch k caused.
 */
export const planMergeRun = async (args: PlanMergeRunArgs): Promise<MergePlanEntry[]> => {
  const { cwd, worktreePath, branches } = args
  const entries: MergePlanEntry[] = []

  const devSha = await revParseVerify(cwd, 'origin/dev')

  if (!devSha) {
    return branches.map((branch) => {
      return { branch, status: 'error' as const, reason: 'origin/dev does not resolve' }
    })
  }

  for (const branch of branches) {
    const startedAt = Date.now()
    const entry = await planOne({ cwd, worktreePath, branch, devSha })

    entries.push({ ...entry, durationMs: Date.now() - startedAt })
  }

  return entries
}

const planOne = async (args: {
  cwd: string
  worktreePath: string
  branch: string
  devSha: string
}): Promise<MergePlanEntry> => {
  const { cwd, worktreePath, branch, devSha } = args
  const remoteRef = `origin/${branch}`

  // Must precede is-ancestor: `merge-base --is-ancestor` exits 128 on an unknown
  // ref, which would abort the whole run rather than failing this one branch.
  if (!(await revParseVerify(cwd, remoteRef))) {
    return { branch, status: 'error', reason: `${remoteRef} does not exist on origin` }
  }

  if (await isAncestor(cwd, 'origin/dev', remoteRef)) {
    return { branch, status: 'up-to-date' }
  }

  try {
    await assertPristineWorktree(worktreePath)

    await $({ cwd: worktreePath, quiet: true })`git checkout --detach ${remoteRef}`

    // `-m` rather than bare `--no-edit`: a merge on a detached HEAD writes
    // "… into HEAD", which would differ from the operator's own
    // `git switch <B> && git merge origin/dev` — and reproducibility by a command
    // they already know is the reason this engine was chosen.
    const message = `${MERGE_MESSAGE_PREFIX}${branch}`

    await $({ cwd: worktreePath, quiet: true })`git merge origin/dev --no-edit -m ${message}`

    const mergeSha = (await $({ cwd: worktreePath, quiet: true })`git rev-parse HEAD`).stdout.trim()

    // A branch strictly behind dev fast-forwards: no merge commit is created, and
    // HEAD lands exactly on dev. Reported distinctly because the operator sees a
    // different history shape, not because it is handled differently.
    return { branch, status: mergeSha === devSha ? 'fast-forward' : 'merged', mergeSha }
  } catch (error) {
    return { branch, ...(await classifyMergeFailure(worktreePath, error)) }
  } finally {
    await resetScratchWorktree(worktreePath)
  }
}

/** The branches a plan would actually push, in plan order. */
export const pushableRefs = (entries: MergePlanEntry[]): { branch: string; sha: string }[] => {
  return entries.flatMap((entry) => {
    return entry.mergeSha ? [{ branch: entry.branch, sha: entry.mergeSha }] : []
  })
}

/** Bare `--verify`: the cheap tier, and the one an operator will actually leave on. */
export const DEFAULT_VERIFY_COMMAND = 'pnpm install --frozen-lockfile'

export interface VerifyOutcome {
  /** Refs that passed and may still be pushed, in plan order. */
  kept: { branch: string; sha: string }[]
  /** branch → the verification failure, for the report. */
  failed: Map<string, string>
}

/**
 * Check out each collected merge and run the verification command against it,
 * dropping any branch that fails.
 *
 * **Pre-push, always.** A failed verification must never lead to rolling back a
 * pushed merge, because rewinding a shared ref is the one thing this command
 * refuses to do. Verifying first makes the question moot rather than answered.
 *
 * Why the default tier is `pnpm install --frozen-lockfile` rather than a test
 * suite: the characteristic breakage of a `dev` → release merge in a pnpm
 * monorepo is `pnpm-lock.yaml` — both sides touched it, the text merge is clean,
 * and the result is semantically broken. No merge engine reports anything,
 * because it is not a conflict. That check is fast and cannot flake on timing,
 * which is what makes it a tier an operator leaves switched on.
 *
 * The command is supplied by the caller rather than read from repo config on
 * purpose: this CLI's config file is a strict schema, so a new key could not be
 * adopted by consumer repos without a schema change and a published release.
 * Configuring at the call site also keeps the plan's rule — never invoke a
 * repo's root `qa` by name — a matter of what the operator types.
 */
export const verifyMerges = async (args: {
  worktreePath: string
  refs: { branch: string; sha: string }[]
  command: string
}): Promise<VerifyOutcome> => {
  const { worktreePath, refs, command } = args
  const kept: { branch: string; sha: string }[] = []
  const failed = new Map<string, string>()

  for (const ref of refs) {
    try {
      await assertPristineWorktree(worktreePath)
      await $({ cwd: worktreePath, quiet: true })`git checkout --detach ${ref.sha}`
      await $({ cwd: worktreePath, quiet: true })`sh -c ${command}`

      kept.push(ref)
    } catch (error) {
      failed.set(ref.branch, stderrOf(error))
    } finally {
      await resetScratchWorktree(worktreePath)
    }
  }

  return { kept, failed }
}

export interface ReclassifyResult {
  /** Still genuinely needing a push, in plan order. */
  kept: { branch: string; sha: string }[]
  /** Branches someone else merged while we were planning. */
  nowUpToDate: string[]
}

/**
 * Re-check the plan against origin immediately before pushing, dropping branches
 * that no longer need it.
 *
 * Mandatory rather than defensive, for two independent reasons:
 *
 * 1. Two operators planning against the same `origin/dev` produce the same tree
 *    but different shas (the committer timestamp differs), so the second push is
 *    rejected on a branch that is in fact correctly merged. Reporting that as a
 *    failure on a daily command manufactures recurring false alarms.
 * 2. Under `--atomic` it is worse than a false alarm: one teammate's hand-merge
 *    would abort the push for *every* branch in the run. `--atomic` without this
 *    step is a downgrade, not an upgrade.
 *
 * Cheap by construction — one fetch plus one `is-ancestor` per branch, no
 * checkout — so it is also safe to run twice when a long `--verify` pass sits
 * between the plan and the push.
 */
export const reclassify = async (cwd: string, refs: { branch: string; sha: string }[]): Promise<ReclassifyResult> => {
  await $({ cwd, quiet: true })`git fetch origin --prune`

  const kept: { branch: string; sha: string }[] = []
  const nowUpToDate: string[] = []

  for (const ref of refs) {
    if (await isAncestor(cwd, 'origin/dev', `origin/${ref.branch}`)) {
      nowUpToDate.push(ref.branch)
    } else {
      kept.push(ref)
    }
  }

  return { kept, nowUpToDate }
}
