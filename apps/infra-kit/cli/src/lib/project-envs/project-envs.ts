import { readTokenStore } from 'src/lib/env-tokens'
import { listWorkflowEnvs } from 'src/lib/workflow-envs'

/** Where the knowledge that an environment EXISTS came from. Never says anything about credentials. */
export type ProjectEnvSource = 'gh-workflow' | 'token-only'

export interface ProjectEnv {
  env: string
  source: ProjectEnvSource
}

/**
 * Every environment this project has, as the union of the two authorities that actually own the
 * answer: `gh-workflow` (declared in a `workflow_dispatch` `environment.options` list) and
 * `token-only` (we hold a token for it, but no workflow mentions it — real and reachable, just not
 * deployable from here).
 *
 * @example
 * await listProjectEnvs()
 * // => [{ env: 'dev', source: 'gh-workflow' }, …, { env: 'prod_observability', source: 'token-only' }]
 */
// `gh-workflow` is what a repo says about itself, in git, reviewed, and enforced by GitHub on
// dispatch. It is the ONLY source that works on a fresh clone with zero credentials, which is
// exactly when a new developer needs to be told the env names they have to run
// `infra-kit env-token-set <env>` for. hulyo's `prod_observability` is exactly a token-only env.
//
// The union is the point. Neither source alone is the truth: the token store is a per-DEVELOPER
// cache (a teammate's holds one entry; a fresh clone's holds none), and the workflows cannot know
// about an env that exists only to be read from. Reading them together is what replaced
// `infra-kit.json → environments`, which was a hand-maintained third copy of both and had drifted
// from both.
export const listProjectEnvs = async (): Promise<ProjectEnv[]> => {
  const workflowEnvs = await listWorkflowEnvs()
  const store = await readTokenStore()

  const declared: ProjectEnv[] = workflowEnvs.map((env) => {
    return { env, source: 'gh-workflow' }
  })

  const known = new Set(workflowEnvs)

  const tokenOnly: ProjectEnv[] = Object.keys(store?.envs ?? {})
    .filter((env) => {
      return !known.has(env)
    })
    .sort()
    .map((env) => {
      return { env, source: 'token-only' }
    })

  // Workflow envs first, in the order the workflows declare them (`dev` leads everywhere), then the
  // strays. A picker reads best when the common choice is at the top.
  return [...declared, ...tokenOnly]
}

/** The env names alone, for the callers that only need choices. Same order as {@link listProjectEnvs}. */
export const listProjectEnvNames = async (): Promise<string[]> => {
  const envs = await listProjectEnvs()

  return envs.map((entry) => {
    return entry.env
  })
}
