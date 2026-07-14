import process from 'node:process'
import { z } from 'zod'

import { getDopplerProject } from 'src/integrations/doppler/doppler-project'
import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler/token-resolver'
import { readTokenStore } from 'src/lib/env-tokens'
import { logger } from 'src/lib/logger'
import type { ProjectEnv, ProjectEnvSource } from 'src/lib/project-envs'
import { listProjectEnvs } from 'src/lib/project-envs'
import { defineMcpTool, textContent } from 'src/types'

/** One row of the token column: an env, where we learned it exists, whether a token resolves, and the fix. */
export interface EnvTokenStatus {
  env: string
  /** `workflow` — declared in a workflow's dispatch options. `token-only` — we hold a token, no workflow names it. */
  source: ProjectEnvSource
  hasToken: boolean
  /**
   * Present only when `hasToken` is `false` — the exact command to run. Written in a BACKTICK code
   * span, the repo convention for naming a command to a human AND the anchor `program.test.ts` scans
   * to prove every command we print is a command we accept.
   */
  hint?: string
}

/**
 * Build the token column: one row per known environment, reporting only WHETHER a token resolves —
 * never the token itself. Mirrors `resolveEnvToken`'s precedence (`INFRA_KIT_ENV_TOKEN` shadows the
 * store for every env) without importing it, so this stays a pure, no-I/O function the same way
 * `buildEnvTokenRows` in `env-token-list` is.
 *
 * @example
 * buildEnvTokenStatus([{ env: 'dev', source: 'workflow' }], { dev: 'dp.st.dev.xxxx' }, undefined)
 * // => [{ env: 'dev', source: 'workflow', hasToken: true }]
 */
export const buildEnvTokenStatus = (
  envs: ProjectEnv[],
  storeTokens: Record<string, string>,
  envToken: string | undefined,
): EnvTokenStatus[] => {
  return envs.map(({ env, source }) => {
    const hasToken = Boolean(envToken || storeTokens[env])

    return hasToken
      ? { env, source, hasToken: true }
      : { env, source, hasToken: false, hint: `infra-kit env-token-set ${env}` }
  })
}

/**
 * List the environments this project has, alongside whether a service token resolves for each one.
 *
 * Purely local: reads the repo's workflows and the local token store, and does not call Doppler — so
 * it works before any service token exists, which is exactly when a user needs to see the env names
 * they have to run `infra-kit env-token-set <env>` for. (A Doppler SERVICE token could not answer this
 * anyway: it is config-scoped and enumerates only its own config.) The token PRESENCE check is a local
 * file read, not a network probe — validating that a stored token is still accepted stays
 * `env-token-list --check`'s job.
 *
 * @example
 * await envList()
 * // logs: 'dev (token set)', 'stage (no token — run `infra-kit env-token-set <env>`)', with <env> = stage
 */
export const envList = async () => {
  const project = await getDopplerProject()
  const envs = await listProjectEnvs()
  const store = await readTokenStore()
  const envToken = process.env[INFRA_KIT_ENV_TOKEN_VAR]

  const tokens = buildEnvTokenStatus(envs, store?.envs ?? {}, envToken)

  logger.info(`Doppler project: ${project}\n`)

  if (tokens.length === 0) {
    // Not an error — a repo can legitimately declare no dispatchable environment. But an empty list with
    // no explanation is the one thing this command must never print: it is read precisely by the person
    // who does not yet know what the env names ARE.
    logger.info('No environments found.')
    logger.info(`  Declare them in a workflow's \`workflow_dispatch\` \`environment.options\`,`)
    logger.info(`  or add a token directly with \`infra-kit env-token-set <env>\`.`)

    return buildResult({ project, envs: tokens })
  }

  logger.info('Environments:')

  for (const row of tokens) {
    const status = row.hasToken ? 'token set' : `no token — run \`${row.hint}\``
    const origin = row.source === 'token-only' ? ', not in any workflow' : ''

    logger.info(`  - ${row.env} (${status}${origin})`)
  }

  return buildResult({ project, envs: tokens })
}

/** Shared tail for both exits above — the empty state is a first-class result, not an error. */
const buildResult = ({ project, envs }: { project: string; envs: EnvTokenStatus[] }) => {
  const structuredContent = {
    project,
    configs: envs.map((row) => {
      return row.env
    }),
    tokens: envs,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const envListMcpTool = defineMcpTool({
  name: 'env-list',
  description:
    "List the environments this project has. The list is the union of two local sources: every environment declared in a GitHub workflow's `workflow_dispatch` `environment.options` (source `workflow`), and every environment the local token store holds a token for (source `token-only`). Not a live fetch from Doppler — a Doppler service token is config-scoped and cannot enumerate sibling configs. Also returns the Doppler project name, and reports per environment whether a service token resolves locally (from the token store or INFRA_KIT_ENV_TOKEN) — presence only, never the token value, and never a live Doppler probe. Read-only.",
  inputSchema: {},
  outputSchema: {
    project: z.string().describe('Detected Doppler project name'),
    configs: z.array(z.string()).describe('Every environment name known to this project'),
    tokens: z
      .array(
        z.object({
          env: z.string().describe('Environment / Doppler config name'),
          source: z
            .enum(['workflow', 'token-only'])
            .describe('Where we learned this environment exists — a workflow declaration, or a token we hold'),
          hasToken: z.boolean().describe('Whether a service token resolves locally for this environment'),
          hint: z.string().optional().describe('Fix command, only present when hasToken is false'),
        }),
      )
      .describe('Per-environment token presence — never the token value'),
  },
  handler: envList,
})
