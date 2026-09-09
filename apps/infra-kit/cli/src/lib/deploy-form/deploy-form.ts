import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { releaseBranchLabels } from 'src/lib/release-utils'
import { deployableEnvs, isSharedEnv, readWorkflowEnvOptions, resolveProtectedEnvAccess } from 'src/lib/workflow-envs'
import { readGatesFromWorkflow } from 'src/lib/workflow-gates'
import { parseServicesFromWorkflow } from 'src/lib/workflow-services'
import type { ArgumentFormProvider } from 'src/types'

/**
 * @fileoverview
 *
 * The argument form the four deploy tools offer: pick a release, an environment, and — on
 * `gh-release-deploy-selected` — the services, from the values this repo actually declares.
 *
 * This is the FIRST live `formProvider` in the codebase. The seam (`types.ts`, `argument-form.ts`,
 * `tool-handler.ts`) was built before anything registered one, and every failure mode on this path
 * is SILENT: `buildArgumentForm` catches whatever `elicit()` throws and returns `null`, which the
 * handler reads as "this client cannot render forms" and gates instead. A provider that is simply
 * WRONG is therefore indistinguishable, from the outside, from a provider that correctly decided it
 * had nothing to offer — so the constraints below are load-bearing, and each is pinned by a test
 * that asserts `buildArgumentForm(...) !== null` rather than "a gate came back".
 */

/** The literal `resolveDeployBranch` accepts for "deploy from the dev branch, not a release". */
const DEV_VERSION = 'dev'

/** The arguments a deploy tool can have filled in by a form. */
export type DeployFormField = 'version' | 'env' | 'services'

interface DeployFormProviderArgs {
  /**
   * The workflow this tool dispatches, and the file BOTH the env list and the service list are read
   * from. Two tools, two files: `gh-release-deploy-all` reads `deploy-all.yml` and
   * `gh-release-deploy-selected` reads `deploy-selected-services.yml`, which genuinely declare
   * different environments in the consumer repos.
   */
  workflowFile: string
  /** Which arguments this tool has. The local pair offers no `version`; only `-selected` has services. */
  fields: readonly DeployFormField[]
  /** Named in the `form options empty` log line, which is how "nothing to offer" stays diagnosable. */
  toolName: string
}

/** A plain object — not an array, not `null`, not a primitive. */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether round 1 left this field for the human to supply.
 *
 * A JSON-RPC request cannot carry `undefined`, so an explicitly-`undefined` key can only come from
 * a hand-built call; treating it as absent is the reading that lets the form fill it, and it stays
 * safe because `narrowsArgs` only checks that the key is PRESENT afterwards.
 */
const isAbsent = (params: Record<string, unknown>, field: DeployFormField): boolean => {
  return params[field] === undefined
}

/** The round-1 value of a field, when it is a string worth quoting back in the prose. */
const roundOneString = (params: Record<string, unknown>, field: DeployFormField): string | undefined => {
  const value = params[field]

  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Collapse a failed enumeration into an empty one — the provider's own contract is never-throws. */
const orEmpty = async (work: Promise<string[]>): Promise<string[]> => {
  try {
    return await work
  } catch {
    return []
  }
}

/** The open releases as the labels `resolveDeployBranch` accepts (`1.2.5`, `checkout-redesign`). */
const releaseLabels = async (): Promise<string[]> => {
  const prs = await getReleasePRsWithInfo()

  return releaseBranchLabels(
    prs.map((pr) => {
      return pr.branch
    }),
  )
}

/**
 * The gate map, as the one marking the wire permits.
 *
 * There are NO per-option labels in an elicitation enum — `.describe()` attaches at the field level
 * only (measured, `docs/reviews/elicit-schema-measurements.md`) — so this prose, read before the
 * list, is the whole of what the human is told about which services the environments exclude. It is
 * derived from the same workflow-scoped `readGatesFromWorkflow` the pre-dispatch refusal uses, so
 * the two cannot drift; a hand-written map here would go stale silently and mislead rather than warn.
 */
const gateMapProse = (services: string[], gates: Map<string, string[]>): string => {
  const gated = services.filter((service) => {
    return gates.get(service) !== undefined
  })

  if (gated.length === 0) return 'none declared.'

  const marks = gated
    .map((service) => {
      return `${service}: ${(gates.get(service) ?? []).join(', ')} only.`
    })
    .join(' ')

  return gated.length < services.length ? `${marks} Others: any environment.` : marks
}

/**
 * Create the `formProvider` for one deploy tool.
 *
 * @example
 * createDeployFormProvider({
 *   workflowFile: 'deploy-selected-services.yml',
 *   fields: ['version', 'env', 'services'],
 *   toolName: 'gh-release-deploy-selected',
 * })
 */
export const createDeployFormProvider = (args: DeployFormProviderArgs): ArgumentFormProvider => {
  const { workflowFile, fields, toolName } = args

  // `null` with a REASON. `z.enum([])` is not an empty dropdown, it is a `TypeError` thrown inside
  // `inputRequired.elicit()` and flattened by `buildArgumentForm`'s catch into the same `null` a
  // non-elicitation client produces (measured). Returning early and logging is what keeps "there is
  // nothing to offer" a decision someone can read in the log rather than a swallowed error. This is
  // not hypothetical at this repo's own root, where neither deploy workflow exists.
  const noOptions = (list: string): null => {
    logger.info({ msg: `Tool execution form options empty (${workflowFile}): ${toolName}`, emptyList: list })

    return null
  }

  const versionField = async (params: Record<string, unknown>): Promise<z.ZodTypeAny | null> => {
    const labels = await orEmpty(releaseLabels())

    // Checked BEFORE `dev` is appended, deliberately: with it the list is never empty, so an empty
    // check afterwards could never fire and a `gh` outage would render a one-option dropdown that
    // looks like "there are no open releases".
    if (labels.length === 0) return null

    const current = roundOneString(params, 'version')

    return z
      .enum([...new Set([...labels, DEV_VERSION])])
      .optional()
      .describe(
        `Which release to deploy from. "${DEV_VERSION}" deploys from the dev branch instead of a release branch. ${
          current === undefined
            ? 'Leaving it blank sends no version, and the tool will refuse rather than guess one.'
            : `Leave it blank to keep the caller's "${current}".`
        }`,
      )
  }

  const envField = async (params: Record<string, unknown>): Promise<z.ZodTypeAny | null> => {
    const envs = deployableEnvs(await orEmpty(readWorkflowEnvOptions(workflowFile)), await resolveProtectedEnvAccess())

    if (envs.length === 0) return null

    const shared = envs.filter(isSharedEnv)
    const personal = envs.filter((env) => {
      return !isSharedEnv(env)
    })

    const current = roundOneString(params, 'env')

    return z
      .enum(envs)
      .optional()
      .describe(
        `Target environment. Shared with the whole team: ${shared.length > 0 ? shared.join(', ') : 'none'}. ` +
          `Personal accounts: ${personal.length > 0 ? personal.join(', ') : 'none'}. ` +
          `This list is read from .github/workflows/${workflowFile} in the WORKING TREE, not from the ` +
          `branch being deployed or from GitHub. ${
            current === undefined
              ? 'Leaving it blank sends no environment at all.'
              : `Leave it blank to keep the caller's "${current}" — including when this tree does not declare it.`
          }`,
      )
  }

  const servicesField = async (): Promise<z.ZodTypeAny | null> => {
    const projectRoot = await getProjectRoot()
    const services = await orEmpty(parseServicesFromWorkflow(projectRoot, workflowFile))

    if (services.length === 0) return null

    const gates = await readGatesFromWorkflow(projectRoot, workflowFile)

    // `z.array(z.enum(...))`, never `z.array(z.string())`. The second is the spelling this tool's own
    // `inputSchema` uses, so it is what an author copies across — and it THROWS inside `elicit()`
    // before a single byte is sent, degrading to a gate that looks exactly like a client which cannot
    // render forms. P10 is the guard, and it asserts on `buildArgumentForm`, not on this object.
    return z
      .array(z.enum(services))
      .optional()
      .describe(
        `Services to deploy. Environment gates declared by ${workflowFile} — ${gateMapProse(services, gates)} ` +
          `A service the chosen environment gates out is REFUSED before dispatch, not skipped in silence. ` +
          `Selecting none discards the form and falls back to the caller's arguments.`,
      )
  }

  return {
    message: `Choose the arguments for ${toolName}. Anything left blank keeps what the caller sent.`,

    isFormable: (params: unknown): boolean => {
      if (!isRecord(params)) return false

      return fields.some((field) => {
        return isAbsent(params, field)
      })
    },

    buildRequestedSchema: async (params: unknown): Promise<z.ZodObject<z.ZodRawShape> | null> => {
      const round1 = isRecord(params) ? params : {}
      // A MUTABLE shape: `z.ZodRawShape` is `Readonly` in zod 4, so it cannot be assembled in place.
      const shape: Record<string, z.ZodTypeAny> = {}

      if (fields.includes('version')) {
        const field = await versionField(round1)

        if (field === null) return noOptions('releases')

        shape.version = field
      }

      if (fields.includes('env')) {
        const field = await envField(round1)

        if (field === null) return noOptions('envs')

        shape.env = field
      }

      // Offered ONLY when round 1 omitted it. If the agent already supplied a list and the human
      // picks a different NUMBER of services, `narrowsArgs` sees an array whose length changed,
      // discards the whole merge, and gates on the agent's list — the human's selection vanishes with
      // the gate showing something they never chose. The conditional is what makes that unreachable.
      if (fields.includes('services') && isAbsent(round1, 'services')) {
        const field = await servicesField()

        if (field === null) return noOptions('services')

        shape.services = field
      }

      // Never `z.object({})` to mean "nothing to offer": an empty object renders cleanly and sends a
      // form with no fields in it, which the human can only accept or decline.
      if (Object.keys(shape).length === 0) return noOptions('fields')

      return z.object(shape)
    },

    // MERGES, field by field, over the round-1 arguments — never constructs a fresh object. Two
    // properties follow from that and are asserted by P11 and P12: a field the human left blank keeps
    // its round-1 value (which is also the drift escape hatch for an env this tree does not declare),
    // and no key outside round-1 keys ∪ `fields` can ever appear.
    toArgs: (content: Record<string, unknown>, params: unknown): Record<string, unknown> | null => {
      const merged: Record<string, unknown> = { ...(isRecord(params) ? params : {}) }

      for (const field of fields) {
        const value = content[field]

        if (value === undefined) continue

        // An empty selection is a NAMED discard, not an argument. `narrowsArgs` cannot catch it: the
        // key is absent from round 1, so `services: []` is a legal addition and would reach the tool
        // as "deploy nothing", which dispatches a run that reports success and ships nothing.
        // Returning `null` routes it through the existing validation-discard path instead, which sets
        // `formDiscarded` and says so in the gate's prose.
        if (field === 'services' && (!Array.isArray(value) || value.length === 0)) return null

        merged[field] = value
      }

      return merged
    },
  }
}
