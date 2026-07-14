import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'

import { getProjectRoot } from 'src/lib/git-utils'

/** Where GitHub keeps dispatchable workflows. The only place we look for environment declarations. */
const WORKFLOWS_DIR = '.github/workflows'

/**
 * The environment list a workflow will accept, read from its own `workflow_dispatch` `choice` input.
 *
 * This replaces `infra-kit.json → environments`, which was a THIRD copy of a fact GitHub already owns
 * and already enforces: a `choice` input is validated server-side on dispatch, so an out-of-range value
 * is rejected by GitHub whether or not we check it here. The copy had drifted — hulyo declared 6 envs
 * while every hulyo workflow declared 8, and the CLI's client-side check turned that drift into a
 * REFUSAL to deploy to `stage` and `prod`.
 *
 * So this is advisory ONLY: it sources the interactive picker, and callers must NOT veto against it.
 * The value returned here comes from the WORKING TREE, while the dispatch targets `--ref <branch>` —
 * the two can legitimately differ, and an explicit `--env` must always win. Vetoing on a local read of
 * a remote fact is what created the bug this function exists to remove.
 *
 * Never throws. A repo with no such workflow (bridge has none), a `type: string` input, an absent
 * `options:` key, or malformed YAML all yield `[]` — an empty picker, never a dead command.
 *
 * @example
 * await readWorkflowEnvOptions('deploy-all.yml') // => ['dev', 'arthur', 'stage', 'prod']
 * await readWorkflowEnvOptions('absent.yml')     // => []
 */
export const readWorkflowEnvOptions = async (workflowFile: string): Promise<string[]> => {
  const projectRoot = await getProjectRoot()

  return parseEnvOptions(path.resolve(projectRoot, WORKFLOWS_DIR, workflowFile))
}

/**
 * Every environment this repo declares anywhere — the union across ALL workflows.
 *
 * Deliberately a UNION, and deliberately not `deploy-all.yml` alone. Two repos prove why: travelist's
 * `deploy-all` omits `eliran` and `roman` (who both hold live tokens and ARE deployable via
 * `deploy-selected-services`), and bridge has no `deploy-all.yml` at all, so a single-file read would
 * report that it has zero environments.
 *
 * Note the asymmetry with {@link readWorkflowEnvOptions}, and keep it: this answers the REPO-scoped
 * question ("what environments exist here?") and so unions; the deploy pickers answer the
 * WORKFLOW-scoped question ("where can THIS workflow deploy?") and so must not.
 *
 * Never throws — an unreadable workflows directory yields `[]`.
 *
 * @example
 * await listWorkflowEnvs() // => ['dev', 'arthur', 'eliran', 'renana', 'roman', 'oriana', 'stage', 'prod']
 */
export const listWorkflowEnvs = async (): Promise<string[]> => {
  const projectRoot = await getProjectRoot()
  const workflowsDir = path.resolve(projectRoot, WORKFLOWS_DIR)

  let entries: string[]

  try {
    entries = await fs.readdir(workflowsDir)
  } catch {
    return []
  }

  const workflows = entries
    .filter((entry) => {
      return entry.endsWith('.yml') || entry.endsWith('.yaml')
    })
    .sort()

  const perWorkflow = await Promise.all(
    workflows.map((file) => {
      return parseEnvOptions(path.resolve(workflowsDir, file))
    }),
  )

  // First-seen order, de-duped: the picker reads best when `dev` leads, as it does in every workflow.
  return [...new Set(perWorkflow.flat())]
}

/**
 * Pull `on.workflow_dispatch.inputs.environment.options` out of one workflow, or `[]`.
 *
 * `yaml.parse` is untyped, and every hop here is a place a real workflow legitimately differs (a
 * `push`-only workflow has no `workflow_dispatch`; a reusable `_jobs.yml` takes `environment` as a
 * `type: string`). Hence the guards rather than a schema: absence is normal, not an error.
 *
 * @example
 * await parseEnvOptions('/repo/.github/workflows/deploy-all.yml') // => ['dev', 'prod']
 * await parseEnvOptions('/repo/.github/workflows/code-quality.yml') // => []
 */
const parseEnvOptions = async (workflowPath: string): Promise<string[]> => {
  let parsed: unknown

  try {
    parsed = yaml.parse(await fs.readFile(workflowPath, 'utf-8'))
  } catch {
    return []
  }

  // `on` is the YAML 1.1 boolean `true` under some parsers; `yaml@2` keeps it a string, but read
  // defensively — a wrong key here would silently empty every picker.
  const on = pick(parsed, 'on') ?? pick(parsed, 'true')
  const options = pick(pick(pick(pick(on, 'workflow_dispatch'), 'inputs'), 'environment'), 'options')

  if (!Array.isArray(options)) return []

  return options.filter((option): option is string => {
    return typeof option === 'string' && option.length > 0
  })
}

/** One safe hop into an unknown object graph. Returns `undefined` for anything that is not a record. */
const pick = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  return (value as Record<string, unknown>)[key]
}
