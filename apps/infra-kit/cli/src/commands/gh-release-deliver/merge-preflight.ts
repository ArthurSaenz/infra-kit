import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import type { ReleaseType } from 'src/lib/release-utils'

interface MergeTreeResult {
  tree: string
  conflicts: string[]
}

/**
 * `git merge-tree --write-tree` merges in the object store only — no checkout, no index — so the
 * whole delivery chain can be rehearsed before anything irreversible runs. Exit 1 is "conflicts",
 * not a failure: the first stdout line is still the (conflicted) tree, the rest are the paths.
 */
const mergeTree = async (ours: string, theirs: string): Promise<MergeTreeResult> => {
  const result = await $({
    quiet: true,
    nothrow: true,
  })`git merge-tree --write-tree --name-only --no-messages ${ours} ${theirs}`

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new OperationError(new Error(result.stderr), {
      operation: `rehearse merging ${theirs} into ${ours}`,
      remediation: 'git merge-tree --write-tree needs git >= 2.38; check `git --version` and that both refs exist',
    })
  }

  const [tree = '', ...paths] = result.stdout.trim().split('\n')

  return { tree, conflicts: result.exitCode === 1 ? [...new Set(paths.filter(Boolean))] : [] }
}

/**
 * Stand-in for the commit a `gh pr merge --squash` will create on `onto`: the merged tree with
 * `onto` as its only parent, so a later rehearsal sees the same merge base the real squash will.
 * The commit is never referenced, so `git gc` collects it.
 */
const squashCommit = async (tree: string, onto: string): Promise<string> => {
  const result = await $({ quiet: true })`git commit-tree ${tree} -p ${onto} -m ${'infra-kit deliver preflight'}`

  return result.stdout.trim()
}

const refuseOnConflict = (step: string, merge: MergeTreeResult): void => {
  if (merge.conflicts.length === 0) return

  throw new OperationError(undefined, {
    operation: `deliver: ${step} would conflict`,
    remediation: `resolve the conflicts in ${merge.conflicts.join(', ')}, push, then re-run`,
  })
}

interface DeliveryMergePlan {
  releaseBranch: string
  releaseType: ReleaseType
  /** A prior run already squash-merged the release PR (and deleted the branch). */
  releaseMerged: boolean
  /** A prior run already merged the dev → main RC PR. Ignored for hotfixes. */
  rcMerged: boolean
}

/**
 * Rehearse every merge `release deliver` will make, against freshly fetched `origin` refs, and
 * refuse before the confirm prompt when any of them would conflict. Without it a conflict surfaced
 * mid-run — worst case in the main → dev sync, after the prod deploy was already dispatched.
 */
export const assertDeliveryMergesClean = async (plan: DeliveryMergePlan): Promise<void> => {
  const { releaseBranch, releaseType, releaseMerged, rcMerged } = plan
  const release = `origin/${releaseBranch}`

  await $({ quiet: true })`git fetch origin main dev ${releaseMerged ? [] : [releaseBranch]}`

  if (releaseType === 'hotfix') {
    let main = 'origin/main'

    if (!releaseMerged) {
      const merge = await mergeTree('origin/main', release)

      refuseOnConflict(`merging ${releaseBranch} into main`, merge)
      main = await squashCommit(merge.tree, 'origin/main')
    }

    refuseOnConflict('syncing main back into dev', await mergeTree('origin/dev', main))

    return
  }

  let dev = 'origin/dev'

  if (!releaseMerged) {
    const merge = await mergeTree('origin/dev', release)

    refuseOnConflict(`merging ${releaseBranch} into dev`, merge)
    dev = await squashCommit(merge.tree, 'origin/dev')
  }

  // A clean dev → main squash also makes the main → dev sync clean (same base, and main's side
  // only adds dev's own changes), so the sync needs its own rehearsal only once the RC merged.
  if (rcMerged) {
    refuseOnConflict('syncing main back into dev', await mergeTree(dev, 'origin/main'))
  } else {
    refuseOnConflict('merging dev into main (RC PR)', await mergeTree('origin/main', dev))
  }
}
