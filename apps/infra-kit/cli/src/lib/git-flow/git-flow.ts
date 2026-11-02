import fs from 'node:fs/promises'
import path from 'node:path'
import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import { getInfraKitConfig, getInfraKitConfigPaths } from 'src/lib/infra-kit-config'

const CONFIG_FILE = 'infra-kit.json'

/**
 * How a repo moves code to production, read from the project `infra-kit.json` key `gitFlow`.
 *
 * - `dev`: features and regular releases branch off `dev` and merge back into it; delivery promotes
 *   `dev` to `main` through an RC PR and syncs `main` back. Hotfixes branch off `main`.
 * - `main`: there is no integration branch. Features and releases branch off `main` and merge
 *   straight into it; there is one release type, because a hotfix would be indistinguishable.
 */
export type GitFlow = 'dev' | 'main'

/** Absent in config means the flow every repo had before the key existed. */
export const DEFAULT_GIT_FLOW: GitFlow = 'dev'

export const PRODUCTION_BRANCH = 'main'

/**
 * The branch work integrates into before it reaches production.
 *
 * @example
 * integrationBranchOf('dev')  // => 'dev'
 * integrationBranchOf('main') // => 'main'
 */
export const integrationBranchOf = (flow: GitFlow): string => {
  return flow === 'dev' ? 'dev' : PRODUCTION_BRANCH
}

/**
 * This repo's {@link GitFlow}. A git repo without `infra-kit.json` gets the default; a config that
 * exists but does not parse throws — guessing `dev` there would merge a release into a stale `dev`
 * branch of a repo that ships from `main`.
 *
 * @example
 * await resolveGitFlow() // infra-kit.json has "gitFlow": "main" => 'main'
 */
export const resolveGitFlow = async (): Promise<GitFlow> => {
  const { main } = await getInfraKitConfigPaths()

  try {
    await fs.access(main)
  } catch {
    return DEFAULT_GIT_FLOW
  }

  const flow = (await getInfraKitConfig()).gitFlow ?? DEFAULT_GIT_FLOW

  if (flow === 'dev') await assertNotBehindMainFlow(main)

  return flow
}

/**
 * The working tree's `infra-kit.json` belongs to whatever branch is checked out, so a branch cut
 * before `"gitFlow": "main"` landed reads as `dev` — and delivery would then sync production into a
 * stale `dev`. `origin/main`'s copy is the shared truth; a disagreement is refused, not guessed.
 * Unreadable (no remote, no file there, not JSON) proves nothing and is ignored.
 */
const assertNotBehindMainFlow = async (configPath: string): Promise<void> => {
  const committedRef = `origin/${PRODUCTION_BRANCH}:${CONFIG_FILE}`

  const shown = await $({
    quiet: true,
    nothrow: true,
  })`git -C ${path.dirname(configPath)} show ${committedRef}`

  if (shown.exitCode !== 0) return

  let committed: unknown

  try {
    committed = JSON.parse(shown.stdout)
  } catch {
    return
  }

  if ((committed as { gitFlow?: unknown } | null)?.gitFlow === 'main') {
    throw new OperationError(undefined, {
      operation: 'resolve the git flow',
      remediation: `origin/${PRODUCTION_BRANCH} sets "gitFlow": "main" but this checkout's infra-kit.json does not — switch to ${PRODUCTION_BRANCH} and pull, or rebase this branch onto it, then re-run`,
    })
  }
}

/**
 * The `origin/<integration>` ref of the repo's flow — what merge-dev merges into releases and
 * what a feature worktree is cut from by default.
 *
 * @example
 * await resolveIntegrationBranch() // gitFlow "main" => 'main'
 */
export const resolveIntegrationBranch = async (): Promise<string> => {
  return integrationBranchOf(await resolveGitFlow())
}
