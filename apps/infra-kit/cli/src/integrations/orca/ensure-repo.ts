import { realpathForOrcaCwd } from './realpath-for-orca-cwd'
import { runOrca } from './run-orca'

export type OrcaRepoVisibility = 'show' | 'hide'

interface OrcaRepoRow {
  path: string
  externalWorktreeVisibility?: OrcaRepoVisibility
}

interface OrcaRepoListResult {
  repos?: OrcaRepoRow[]
}

interface OrcaRepoAddResult {
  repo?: OrcaRepoRow
}

export interface OrcaRepoLookup {
  registered: boolean
  visibility?: OrcaRepoVisibility
}

/**
 * Whether Orca knows the repo at `mainRepoRoot`, and whether its external
 * worktrees (infra-kit's `<repo>-worktrees/*`) are shown in the sidebar. Split
 * from {@link addOrcaRepo} so a caller can put "will register <repo> in Orca" in
 * its confirm preview before mutating — `repo add` carries hook policy defaults.
 */
export const findOrcaRepo = async (mainRepoRoot: string): Promise<OrcaRepoLookup> => {
  const [{ repos = [] }, wanted] = await Promise.all([
    runOrca<OrcaRepoListResult>(['repo', 'list']),
    realpathForOrcaCwd(mainRepoRoot),
  ])

  for (const repo of repos) {
    if ((await realpathForOrcaCwd(repo.path)) === wanted) {
      return { registered: true, visibility: repo.externalWorktreeVisibility }
    }
  }

  return { registered: false }
}

/** Registers the repo; the returned visibility is `hide` for a fresh row (measured). */
export const addOrcaRepo = async (mainRepoRoot: string): Promise<{ visibility?: OrcaRepoVisibility }> => {
  const { repo } = await runOrca<OrcaRepoAddResult>(['repo', 'add', '--path', mainRepoRoot])

  return { visibility: repo?.externalWorktreeVisibility }
}
