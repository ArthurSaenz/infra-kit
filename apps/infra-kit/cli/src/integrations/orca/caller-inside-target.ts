import process from 'node:process'

import { realpathForOrcaCwd } from './realpath-for-orca-cwd'

const WORKTREE_ID_SEPARATOR = '::'

/**
 * The path half of `ORCA_WORKTREE_ID` (`<repoId>::<abs path>`), or `null` when the
 * caller is not inside an Orca terminal. The id is per-terminal env — `cd` and
 * `-C` never change it — which is exactly why it identifies the terminal a
 * removal would destroy, and why "re-run from elsewhere" is the only remediation.
 */
const orcaCallerWorktreePath = (env: NodeJS.ProcessEnv): string | null => {
  const id = env.ORCA_WORKTREE_ID

  if (!id) {
    return null
  }

  const separatorAt = id.indexOf(WORKTREE_ID_SEPARATOR)

  if (separatorAt < 0) {
    return null
  }

  const path = id.slice(separatorAt + WORKTREE_ID_SEPARATOR.length)

  return path.length > 0 ? path : null
}

/**
 * The first of `paths` that is the caller's own Orca worktree, or `null`. Runs in
 * the command preflight of `worktrees remove` / `release-remove` — before the
 * confirm prompt and before any git call — because closing that worktree's
 * terminals would kill the shell running infra-kit.
 */
export const orcaCallerInsideTargets = async (
  paths: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> => {
  const callerPath = orcaCallerWorktreePath(env)

  if (callerPath === null) {
    return null
  }

  const caller = await realpathForOrcaCwd(callerPath)

  for (const path of paths) {
    if ((await realpathForOrcaCwd(path)) === caller) {
      return path
    }
  }

  return null
}
