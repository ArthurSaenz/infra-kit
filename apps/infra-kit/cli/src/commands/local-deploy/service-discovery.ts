import fs from 'node:fs/promises'
import path from 'node:path'

import { intersectGates, readWorkflowGates } from './workflow-gates'

/** Where both consumer monorepos keep their deploy scripts. The only place we look. */
const SCRIPTS_DIR = 'devops/scripts'

/** `deploy-<service>.sh` — the `lib/` subdir and `e2e-*.sh` are excluded by the shape itself. */
const SCRIPT_PATTERN = /^deploy-(?<service>[a-z0-9-]+)\.sh$/

/**
 * `skip_unless_env_enabled "$DEPLOY_STAGE" "<label>" "<space separated envs>"` — third arg is the
 * allow-list.
 *
 * Applied per line, to lines already known not to be comments (see {@link readAllowedEnvs}). Matching
 * the whole file at once needed a `[^#\n]*` prefix to skip comment text, and that prefix next to `\s+`
 * backtracks super-linearly — cheaper and clearer to filter the lines first.
 */
const GUARD_PATTERN = /skip_unless_env_enabled\s+"[^"]*"\s+"[^"]*"\s+"(?<envs>[^"]*)"/

export interface DeployService {
  /** `client-be`, `docs-fe`, `media` — the identity CI already uses as `script_name`. */
  name: string
  /** Absolute path to the script this service runs. */
  scriptPath: string
  /**
   * Environments this service may deploy to, or `null` when it declares no restriction.
   *
   * Read from the script's own `skip_unless_env_enabled` call rather than from the workflow's `if:`
   * conditions. Both encode the same rule, but only the script's copy travels with a local run — and
   * `deploy-utils.sh` says so explicitly: the guard is "defense-in-depth alongside the workflow-level
   * env gate: protects manual runs and any other pipeline that wires the script in".
   */
  allowedEnvs: string[] | null
}

/**
 * Every deployable service in the current repo, derived from disk.
 *
 * Deliberately NOT a hand-maintained list in `infra-kit.json`. Measured against both consumer repos,
 * globbing is strictly more accurate than the workflows' own `script_name` values in BOTH directions:
 * hulyo's `deploy-selected-services.yml` offers live `ai-ui` and `widgets-fe` checkboxes whose scripts
 * do not exist (ticking either fails the job), while `media` exists on disk with no `script_name` at
 * all because it has a dedicated workflow. Disk is the truth; the YAML has drifted from it.
 *
 * Sorted by name so the picker and `--dry-run` output are stable.
 *
 * @example
 * await discoverServices('/repo') // => [{ name: 'ai-be', … }, { name: 'backoffice-be', … }, …]
 */
export const discoverServices = async (projectRoot: string): Promise<DeployService[]> => {
  const scriptsDir = path.resolve(projectRoot, SCRIPTS_DIR)

  let entries: string[]

  try {
    entries = await fs.readdir(scriptsDir)
  } catch {
    return []
  }

  // Both sources are read because they drift: travelist gates `mobile` and `media` in the workflow
  // but has no `skip_unless_env_enabled` in either script, so trusting the script alone would let
  // `--all` include services CI refuses.
  const gates = await readWorkflowGates(projectRoot)

  const services = await Promise.all(
    entries
      .map((entry) => {
        return { entry, match: SCRIPT_PATTERN.exec(entry) }
      })
      .filter((candidate) => {
        return candidate.match !== null
      })
      .map(async ({ entry, match }) => {
        const scriptPath = path.resolve(scriptsDir, entry)
        const name = match?.groups?.service ?? ''

        return {
          name,
          scriptPath,
          allowedEnvs: intersectGates(await readAllowedEnvs(scriptPath), gates.get(name)),
        }
      }),
  )

  return services.sort((left, right) => {
    return left.name.localeCompare(right.name)
  })
}

/**
 * The service's env allow-list, or `null` when it declares none.
 *
 * `null` and `[]` mean opposite things and must not be conflated: `null` is "no restriction, deploys
 * anywhere", `[]` would be "deploys nowhere". An unreadable script yields `null` — the same as
 * declaring no guard — because refusing to list a service on a read error would silently shrink the
 * picker.
 */
const readAllowedEnvs = async (scriptPath: string): Promise<string[] | null> => {
  let source: string

  try {
    source = await fs.readFile(scriptPath, 'utf-8')
  } catch {
    return null
  }

  // Comments are dropped before matching: `deploy-utils.sh` names the function several times in its
  // own docblock, and a consumer script may well explain the guard above the call.
  const envs = source
    .split('\n')
    .filter((line) => {
      return !line.trimStart().startsWith('#')
    })
    .reduce<string | undefined>((found, line) => {
      return found ?? GUARD_PATTERN.exec(line)?.groups?.envs
    }, undefined)

  if (envs === undefined) return null

  const parsed = envs.split(/\s+/).filter(Boolean)

  return parsed.length > 0 ? parsed : null
}

/**
 * Whether a service will actually deploy to an environment.
 *
 * Mirrors `skip_unless_env_enabled`: a service with no allow-list goes anywhere.
 *
 * @example
 * isEligible({ allowedEnvs: ['dev', 'prod'] } as DeployService, 'arthur') // => false
 * isEligible({ allowedEnvs: null } as DeployService, 'arthur')            // => true
 */
export const isEligible = (service: DeployService, env: string): boolean => {
  return service.allowedEnvs === null || service.allowedEnvs.includes(env)
}

/**
 * The services `--all` should run for an environment — i.e. what CI's `deploy-all` would actually do
 * there, not everything on disk.
 *
 * Without this, `--all --env stage` would deploy `docs-fe` and `mobile`, which CI refuses: both repos
 * gate `docs-fe` to dev + the personal envs, `mobile` to dev/prod, and travelist gates `media` to prod
 * alone. Filtering here is what keeps the local run honest against the pipeline it is imitating.
 */
export const eligibleServices = (services: DeployService[], env: string): DeployService[] => {
  return services.filter((service) => {
    return isEligible(service, env)
  })
}
