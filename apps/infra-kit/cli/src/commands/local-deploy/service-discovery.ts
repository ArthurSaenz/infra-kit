import type { DeployConfig } from '@slip-stream-kit/config/internal'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loadDeployConfig, manifestGates } from 'src/lib/deploy-workflows'
import { OperationError } from 'src/lib/errors/operation-error'
import { intersectGates, readWorkflowGates } from 'src/lib/workflow-gates'

/** Where both consumer monorepos keep their deploy scripts. The only place we look. */
const SCRIPTS_DIR = 'devops/scripts'

/** `deploy-<service>.sh` — the `lib/` subdir and `e2e-*.sh` are excluded by the shape itself. */
const SCRIPT_PATTERN = /^deploy-(?<service>[a-z0-9-]+)\.sh$/

/**
 * `skip_unless_env_enabled "$DEPLOY_STAGE" "<label>" "<space separated envs>"` — third arg is the
 * allow-list.
 *
 * Applied per line, to lines already known not to be comments (see {@link codeLines}). Matching
 * the whole file at once needed a `[^#\n]*` prefix to skip comment text, and that prefix next to `\s+`
 * backtracks super-linearly — cheaper and clearer to filter the lines first.
 */
const GUARD_PATTERN = /skip_unless_env_enabled\s+"[^"]*"\s+"[^"]*"\s+"(?<envs>[^"]*)"/

/**
 * The `--name` argument of ANY `aws ssm get-parameter` call, literal or not.
 *
 * Stops at whitespace or `)` because the consumers write the read as `X=$(aws ssm … "/p/environment")`,
 * where the closing paren belongs to the command substitution, not the name.
 */
const SSM_READ_PATTERN = /aws\s+ssm\s+get-parameter\s+--name[=\s]+(?<arg>[^\s)]+)/

/**
 * The environment parameter written as a literal — the only form infra-kit can preflight.
 *
 * `--name=` and `--name ` both count, quotes are optional, and the negative lookahead is what keeps
 * `/hulyo/environment` from also matching a longer sibling such as `/hulyo/environment_v2`.
 */
const SSM_ENVIRONMENT_PATTERN =
  /aws\s+ssm\s+get-parameter\s+--name[=\s]+["']?\/(?<prefix>[\w.-]+)\/environment["']?(?![\w./-])/

/**
 * A deploy.ts names the parameter as a whole string literal, e.g. `ssm(['/hulyo/environment', …])`;
 * the backreference closes on the same quote, which is what keeps `/hulyo/environment_v2` out.
 */
const TS_ENVIRONMENT_PATTERN = /(["'`])\/(?<prefix>[\w.-]+)\/environment\1/

/** A template literal building the environment parameter (`` `/${project}/environment` ``). */
const TS_TEMPLATE_ENVIRONMENT_PATTERN = /`[^`]*\$\{[^`]*\/environment[^`]*`/

/** How one script language marks comments and names the environment parameter. */
interface ScriptDialect {
  commentPrefixes: string[]
  literalPrefix: (text: string) => string | undefined
  isUnparseable: (text: string) => boolean
}

const SH_DIALECT: ScriptDialect = {
  commentPrefixes: ['#'],
  literalPrefix: (text) => {
    return SSM_ENVIRONMENT_PATTERN.exec(text)?.groups?.prefix
  },
  isUnparseable: (text) => {
    const arg = SSM_READ_PATTERN.exec(text)?.groups?.arg

    return arg !== undefined && mightReadEnvironment(arg)
  },
}

/**
 * A parameter held in a variable is not detected here: the toolkit's `ssm()` takes any expression,
 * so only a template literal naming `/environment` is recognisably an environment read.
 */
const TS_DIALECT: ScriptDialect = {
  commentPrefixes: ['//', '/*', '*'],
  literalPrefix: (text) => {
    return TS_ENVIRONMENT_PATTERN.exec(text)?.groups?.prefix
  },
  isUnparseable: (text) => {
    return TS_TEMPLATE_ENVIRONMENT_PATTERN.test(text)
  },
}

/** One non-comment line of a deploy script, with its 1-based position so a refusal can point at it. */
export interface ScriptLine {
  line: number
  text: string
}

/**
 * A `…/environment` read whose parameter name is not a literal.
 *
 * Distinct from `null` on purpose: `null` means "this script does not read the environment
 * parameter", which is true of `deploy-media.sh`. A read through `/${PROJECT}/environment` or a
 * bare `"$PARAM"` DOES read it, and infra-kit cannot know which parameter without executing the
 * script — so it must refuse, naming the line, rather than degrade to "no script reads it".
 */
export interface SsmPrefixUnparseable {
  unparseable: ScriptLine
}

export type SsmPrefix = string | null | SsmPrefixUnparseable

export interface DeployService {
  /** `client-be`, `docs-fe`, `media` — the identity CI already uses as `script_name`. */
  name: string
  /** Absolute path to the script this service runs: its manifest `deploy` file, or its `.sh`. */
  scriptPath: string
  /** `deploy-run` hands `scriptPath` (a deploy.ts) to `infra-kit deploy-run`; `sh` runs it directly. */
  runner: 'sh' | 'deploy-run'
  /**
   * Environments this service may deploy to, or `null` when it declares no restriction.
   *
   * Read from the script's own `skip_unless_env_enabled` call rather than from the workflow's `if:`
   * conditions. Both encode the same rule, but only the script's copy travels with a local run — and
   * `deploy-utils.sh` says so explicitly: the guard is "defense-in-depth alongside the workflow-level
   * env gate: protects manual runs and any other pipeline that wires the script in".
   */
  allowedEnvs: string[] | null
  /**
   * The `<project>` in the `/<project>/environment` SSM parameter this script reads for
   * `DEPLOY_STAGE`, `null` when it reads none, or the unparseable marker.
   *
   * Preflight probes this exact parameter to learn which environment the AWS account IS. It used
   * to guess the project from the checkout's directory basename, which is `hulyo-monorepo` in the
   * main checkout and the release name in a linked worktree — never `hulyo`. The scripts are the
   * only place the real name lives, so it is read from them.
   */
  ssmPrefix: SsmPrefix
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
 * A repo with an `infra-kit.deploy.ts` is read from that instead: it is what CI deploys from, and the
 * v1 scripts are deleted once each service has a deploy.ts.
 *
 * Sorted by name so the picker and `--dry-run` output are stable.
 *
 * @example
 * await discoverServices('/repo') // => [{ name: 'ai-be', … }, { name: 'backoffice-be', … }, …]
 */
export const discoverServices = async (projectRoot: string): Promise<DeployService[]> => {
  const config = await loadDeployConfig(projectRoot)

  // Both sources are read because they drift: travelist gates `mobile` and `media` in the workflow
  // but has no `skip_unless_env_enabled` in either script, so trusting the script alone would let
  // `--all` include services CI refuses.
  const gates = await readWorkflowGates(projectRoot)

  const services =
    config === undefined ? await scriptServices(projectRoot, gates) : await manifestServices(projectRoot, config, gates)

  return services.sort((left, right) => {
    return left.name.localeCompare(right.name)
  })
}

/** Every `devops/scripts/deploy-<service>.sh`, for a repo without a deploy manifest. */
const scriptServices = async (projectRoot: string, gates: Map<string, string[]>): Promise<DeployService[]> => {
  const scriptsDir = path.resolve(projectRoot, SCRIPTS_DIR)

  let entries: string[]

  try {
    entries = await fs.readdir(scriptsDir)
  } catch {
    return []
  }

  return Promise.all(
    entries.flatMap((entry) => {
      const name = SCRIPT_PATTERN.exec(entry)?.groups?.service

      return name === undefined ? [] : [scriptService(name, path.resolve(scriptsDir, entry), gates)]
    }),
  )
}

const scriptService = async (
  name: string,
  scriptPath: string,
  gates: Map<string, string[]>,
): Promise<DeployService> => {
  const lines = codeLines(await readScript(scriptPath), SH_DIALECT)

  return {
    name,
    scriptPath,
    runner: 'sh',
    allowedEnvs: intersectGates(readAllowedEnvs(lines), gates.get(name)),
    ssmPrefix: readSsmPrefix(lines, SH_DIALECT),
  }
}

/**
 * The manifest's services: a `deploy` runs through `infra-kit deploy-run`, as in CI; one without
 * falls back to its `.sh` (media's workflow runs `deploy-media.sh`), and is not offered without one.
 *
 * The manifest's `envs`/`skipEnvs` gate on top of the workflow gates, which still include the v1
 * workflows CI dispatches until the manifest `replaceV1`.
 */
const manifestServices = async (
  projectRoot: string,
  config: DeployConfig,
  gates: Map<string, string[]>,
): Promise<DeployService[]> => {
  const declared = manifestGates(config)

  const services = await Promise.all(
    Object.entries(config.services).map(async ([name, service]): Promise<DeployService | null> => {
      if (service.deploy === undefined) {
        const scriptPath = path.resolve(projectRoot, SCRIPTS_DIR, `deploy-${name}.sh`)

        if (!(await exists(scriptPath))) return null

        const legacy = await scriptService(name, scriptPath, gates)

        return { ...legacy, allowedEnvs: intersectGates(legacy.allowedEnvs, declared.get(name)) }
      }

      const scriptPath = path.resolve(projectRoot, service.deploy)
      const lines = codeLines(await readScript(scriptPath), TS_DIALECT)

      return {
        name,
        scriptPath,
        runner: 'deploy-run',
        allowedEnvs: intersectGates(declared.get(name) ?? null, gates.get(name)),
        ssmPrefix: readSsmPrefix(lines, TS_DIALECT),
      }
    }),
  )

  return services.filter((service) => {
    return service !== null
  })
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.access(file)

    return true
  } catch {
    return false
  }
}

/**
 * The script's source, or `''` when it cannot be read.
 *
 * Empty rather than thrown: every reader below treats "nothing to match" as "declares nothing",
 * because refusing to list a service on a read error would silently shrink the picker.
 */
const readScript = async (scriptPath: string): Promise<string> => {
  try {
    return await fs.readFile(scriptPath, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * The script's non-comment lines, numbered as they appear in the file.
 *
 * Comments are dropped before any pattern runs: `deploy-utils.sh` names `skip_unless_env_enabled`
 * several times in its own docblock, and a consumer script may well explain a guard or an SSM read
 * above the call. Numbering survives the filter so a refusal can cite `script:line`.
 */
const codeLines = (source: string, dialect: ScriptDialect): ScriptLine[] => {
  return source
    .split('\n')
    .map((text, index) => {
      return { line: index + 1, text }
    })
    .filter(({ text }) => {
      const trimmed = text.trimStart()

      return !dialect.commentPrefixes.some((prefix) => {
        return trimmed.startsWith(prefix)
      })
    })
}

/**
 * The service's env allow-list, or `null` when it declares none.
 *
 * `null` and `[]` mean opposite things and must not be conflated: `null` is "no restriction, deploys
 * anywhere", `[]` would be "deploys nowhere".
 */
const readAllowedEnvs = (lines: ScriptLine[]): string[] | null => {
  const envs = lines.reduce<string | undefined>((found, { text }) => {
    return found ?? GUARD_PATTERN.exec(text)?.groups?.envs
  }, undefined)

  if (envs === undefined) return null

  const parsed = envs.split(/\s+/).filter(Boolean)

  return parsed.length > 0 ? parsed : null
}

/**
 * Whether a non-literal `--name` argument might be the environment parameter.
 *
 * Two shapes qualify: a path that names `/environment` through an expansion (`/${PROJECT}/environment`),
 * and a bare variable (`"$PARAM"`) whose value lives on some other line — resolving that would mean
 * evaluating shell, so it is refused rather than guessed. Anything without an expansion is a literal
 * and has already had its chance to match {@link SSM_ENVIRONMENT_PATTERN}: a DIFFERENT parameter
 * (`/hulyo/api_gateway/website/restId`, or a sibling such as `/hulyo/environment_v2`) is ignored,
 * not refused — the refusal asks for a literal, which would be nonsense advice for one.
 */
const mightReadEnvironment = (arg: string): boolean => {
  const unquoted = arg.replaceAll(/["']/g, '')

  return unquoted.includes('$') && (unquoted.includes('/environment') || unquoted.startsWith('$'))
}

/**
 * The first environment read in the script — literal prefix, unparseable marker, or `null`.
 *
 * First match wins, as with the guard: every consumer script reads `DEPLOY_STAGE` exactly once, at
 * the top, so a second read would be a copy-paste that the >1-prefix refusal in
 * {@link resolveSsmPrefix} is the right place to catch across scripts.
 */
const readSsmPrefix = (lines: ScriptLine[], dialect: ScriptDialect): SsmPrefix => {
  for (const { line, text } of lines) {
    const prefix = dialect.literalPrefix(text)

    if (prefix !== undefined) return prefix

    if (dialect.isUnparseable(text)) return { unparseable: { line, text: text.trim() } }
  }

  return null
}

/**
 * How a refusal names a service's script without its full path. A deploy.ts is qualified by its
 * service, since every app's is called `deploy.ts`.
 */
const scriptLabel = (service: DeployService): string => {
  const basename = path.basename(service.scriptPath)

  return service.runner === 'sh' ? basename : `${service.name} (${basename})`
}

/** Script labels per distinct prefix, so a refusal can name the offenders. */
const groupByPrefix = (services: DeployService[]): Map<string, string[]> => {
  const groups = new Map<string, string[]>()

  for (const service of services) {
    if (typeof service.ssmPrefix !== 'string') continue

    groups.set(service.ssmPrefix, [...(groups.get(service.ssmPrefix) ?? []), scriptLabel(service)])
  }

  return groups
}

/** Refuse if any script reads the environment parameter through something infra-kit cannot read. */
const assertLiteralPrefixes = (services: DeployService[]): void => {
  const offenders = services.flatMap((service) => {
    if (service.ssmPrefix === null || typeof service.ssmPrefix === 'string') return []

    const { line, text } = service.ssmPrefix.unparseable

    return [`${scriptLabel(service)}:${line}: ${text}`]
  })

  if (offenders.length === 0) return

  throw new OperationError(undefined, {
    operation: 'resolve the SSM project prefix',
    remediation: 'write the parameter name as a literal `/<project>/environment` so infra-kit can preflight it',
    stderrExcerpt: offenders.join('; '),
  })
}

/**
 * The one `<project>` every deploy script agrees on — the prefix preflight will probe.
 *
 * Evaluated over ALL discovered services, not the ones chosen for this run, and BEFORE any picker
 * opens. A literal reading of "probe what the chosen scripts read" would let a copy-pasted
 * `/travelist/environment` sit unnoticed in a hulyo script until someone happened to pick it; the
 * refusal is worth more as drift detection, and it must fire before `pickEnv`/`pickServices` so a
 * human is not asked to choose a target the run was never going to reach.
 *
 * Refuses on 0, >1, or any unparseable prefix — each naming the offending script, because a repo
 * that reads nothing, disagrees with itself, or reads through a variable cannot be preflighted.
 *
 * @example
 * resolveSsmPrefix(await discoverServices('/hulyo-monorepo')) // => 'hulyo'
 */
export const resolveSsmPrefix = (services: DeployService[]): string => {
  assertLiteralPrefixes(services)

  const groups = groupByPrefix(services)
  const [prefix, ...others] = groups.keys()

  if (prefix === undefined) {
    throw new OperationError(undefined, {
      operation: 'resolve the SSM project prefix',
      remediation:
        'read the literal "/<project>/environment" in at least one deploy script: a deploy.ts in infra-kit.deploy.ts, or `aws ssm get-parameter --name "/<project>/environment"` in a devops/scripts/deploy-*.sh',
      stderrExcerpt: `none of ${services.length} deploy scripts reads /<project>/environment`,
    })
  }

  if (others.length > 0) {
    // Fewest scripts first: in a real drift one script disagrees with the other fourteen, and that
    // one is the fix — it must survive the message's excerpt cap.
    const listing = [...groups.entries()]
      .sort(([, left], [, right]) => {
        return left.length - right.length
      })
      .map(([prefix, scripts]) => {
        return `${prefix}: ${scripts.join(', ')}`
      })
      .join('; ')

    throw new OperationError(undefined, {
      operation: 'resolve the SSM project prefix',
      remediation: 'make every deploy script read the same /<project>/environment parameter',
      stderrExcerpt: `${groups.size} different prefixes across ${services.length} deploy scripts — ${listing}`,
    })
  }

  return prefix
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
