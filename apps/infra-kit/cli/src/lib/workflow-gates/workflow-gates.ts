import fs from 'node:fs/promises'
import path from 'node:path'

const WORKFLOWS_DIR = '.github/workflows'

/** `script_name: client-be` — ties a job block to the script it runs. */
const SCRIPT_NAME_PATTERN = /script_name:\s*(?<service>[a-z0-9-]+)/

/**
 * `uses: ./.github/workflows/_deploy-media-jobs.yml` — the other way a job names its script.
 *
 * `media` has no `script_name` in either repo because it has a dedicated reusable workflow rather
 * than going through the shared serverless one. Without this, travelist's prod-only media gate is
 * invisible and `--all` would offer it everywhere.
 *
 * This also matches `_deploy-serverless-jobs.yml` → `serverless`, which is not a service; callers
 * drop names that have no `deploy-<name>.sh` on disk, so it costs nothing.
 */
const REUSABLE_WORKFLOW_PATTERN = /uses:\s*\.\/\.github\/workflows\/_deploy-(?<service>[a-z0-9-]+)-jobs\.ya?ml/

/** `inputs.environment == 'prod'` — one arm of a job's `if:` gate. */
const ENV_EQUALS_PATTERN = /inputs\.environment\s*==\s*'(?<env>[a-z0-9-]+)'/g

/**
 * Every environment gate the repo declares for a service, unioned across ALL workflows.
 *
 * Answers "can this service deploy here at all from this machine". `local-deploy` uses it as a
 * fallback for services whose script carries no `skip_unless_env_enabled`: both sources encode the
 * same rule and normally agree, but they drift — travelist gates `mobile` to dev/prod and `media` to
 * prod alone in `deploy-all.yml`, while neither script has the guard hulyo's equivalents do. Reading
 * only the scripts would let `--all` include services CI refuses; reading only the YAML would miss
 * the guard that actually protects a manual run. So we read both and take the intersection.
 *
 * Best-effort by design: a gate we cannot parse yields no restriction, because inventing one would
 * silently shrink what the user can deploy.
 */
export const readWorkflowGates = async (projectRoot: string): Promise<Map<string, string[]>> => {
  const dir = path.resolve(projectRoot, WORKFLOWS_DIR)

  let files: string[]

  try {
    files = await fs.readdir(dir)
  } catch {
    return new Map()
  }

  return collectFrom(
    dir,
    files.filter((entry) => {
      return entry.endsWith('.yml') || entry.endsWith('.yaml')
    }),
  )
}

/**
 * The gates one named workflow declares — the file a dispatch is actually about to run.
 *
 * Answers a strictly different question from {@link readWorkflowGates}: "will THIS dispatch's job
 * run", not "can this service deploy here at all". Collapsing the two would be wrong in both
 * directions, and the union is the worse wrong one for a dispatch: travelist's `media` inherits
 * `['prod']` from `deploy-all.yml`, while `deploy-selected-services.yml` gates `media` not at all,
 * so a union-based refusal blocks `media` + `dev` on a workflow that would happily run it — a gate
 * borrowed from a file nobody dispatched.
 *
 * Same best-effort contract: an absent or unparseable file yields an empty map, i.e. no restriction.
 */
export const readGatesFromWorkflow = async (
  projectRoot: string,
  workflowFile: string,
): Promise<Map<string, string[]>> => {
  return collectFrom(path.resolve(projectRoot, WORKFLOWS_DIR), [workflowFile])
}

/** Union the gates of the given workflow files. An unreadable file contributes nothing. */
const collectFrom = async (dir: string, files: string[]): Promise<Map<string, string[]>> => {
  const gates = new Map<string, string[]>()

  for (const file of files) {
    let source: string

    try {
      source = await fs.readFile(path.resolve(dir, file), 'utf-8')
    } catch {
      continue
    }

    collectGates(source, gates)
  }

  return gates
}

/**
 * Pull `<service> -> [envs]` out of one workflow.
 *
 * Job blocks are split on two-space-indented keys, which is how every deploy workflow in both repos
 * is written. A block contributes only when it names a script AND its `if:` tests the environment —
 * an unconditional job means "all environments" and must not narrow anything.
 */
const collectGates = (source: string, gates: Map<string, string[]>): void => {
  for (const block of source.split(/\n(?= {2}[\w-]+:)/i)) {
    const service =
      SCRIPT_NAME_PATTERN.exec(block)?.groups?.service ?? REUSABLE_WORKFLOW_PATTERN.exec(block)?.groups?.service

    if (service === undefined) continue

    // A commented-out job (hulyo keeps `deploy-ai-ui` that way) declares nothing.
    if (block.trimStart().startsWith('#')) continue

    const envs = [...block.matchAll(ENV_EQUALS_PATTERN)].map((match) => {
      return match.groups?.env ?? ''
    })

    if (envs.length === 0) continue

    // A service appearing in several workflows is allowed wherever ANY of them allows it.
    gates.set(service, [...new Set([...(gates.get(service) ?? []), ...envs])])
  }
}

/**
 * Combine the script guard with the workflow gate.
 *
 * `null` on either side means "unrestricted from that source", so the answer is whatever the other
 * one says. When both restrict, the intersection is what actually deploys.
 */
export const intersectGates = (scriptEnvs: string[] | null, workflowEnvs: string[] | undefined): string[] | null => {
  if (scriptEnvs === null) return workflowEnvs ?? null
  if (workflowEnvs === undefined) return scriptEnvs

  return scriptEnvs.filter((env) => {
    return workflowEnvs.includes(env)
  })
}
