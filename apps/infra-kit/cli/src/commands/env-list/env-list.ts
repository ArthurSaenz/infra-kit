import process from 'node:process'
import { z } from 'zod'

import { getDopplerProject } from 'src/integrations/doppler/doppler-project'
import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler/token-resolver'
import { readTokenStore } from 'src/lib/env-tokens'
import { logger } from 'src/lib/logger'
import type { ProjectEnv, ProjectEnvSource } from 'src/lib/project-envs'
import { listProjectEnvs } from 'src/lib/project-envs'
import { defineMcpTool, textContent } from 'src/types'

/** One row of the token column: an env, where we learned it exists, and whether a token resolves. */
export interface EnvTokenStatus {
  env: string
  /** `gh-workflow` — declared in a workflow's dispatch options. `token-only` — we hold a token, no workflow names it. */
  source: ProjectEnvSource
  hasToken: boolean
}

/**
 * Build the token column: one row per known environment, reporting only WHETHER a token resolves —
 * never the token itself. Mirrors `resolveEnvToken`'s precedence (`INFRA_KIT_ENV_TOKEN` shadows the
 * store for every env) without importing it, so this stays a pure, no-I/O function the same way
 * `buildEnvTokenRows` in `env-token-list` is.
 *
 * @example
 * buildEnvTokenStatus([{ env: 'dev', source: 'gh-workflow' }], { dev: 'dp.st.dev.xxxx' }, undefined)
 * // => [{ env: 'dev', source: 'gh-workflow', hasToken: true }]
 */
export const buildEnvTokenStatus = (
  envs: ProjectEnv[],
  storeTokens: Record<string, string>,
  envToken: string | undefined,
): EnvTokenStatus[] => {
  return envs.map(({ env, source }) => {
    return { env, source, hasToken: Boolean(envToken || storeTokens[env]) }
  })
}

/** Column headers for the environments table, in render order. */
const ENV_TABLE_HEADERS = ['Environment', 'Source', 'Token'] as const

/**
 * Render the environments as an aligned, vertical-bar-separated table — the same columnar shape as
 * `gh-release-list`, with explicit `|` column rules. Display only: the structured/MCP payload is built
 * separately in {@link buildResult} from the same rows, so the machine contract never depends on this
 * formatting. Deliberately prints no fix command — setting a token is a manual `env-token-set` step,
 * not something this read-only listing spells out.
 *
 * @example
 * formatEnvTable([{ env: 'dev', source: 'gh-workflow', hasToken: true }])
 * // => ['Environments:', '', 'Environment | Source      | Token', '───────────…', 'dev         | gh-workflow | set']
 */
const formatEnvTable = (rows: EnvTokenStatus[]): string[] => {
  const cells = rows.map((row) => {
    return [row.env, row.source, row.hasToken ? 'set' : 'not set']
  })

  const widths = ENV_TABLE_HEADERS.map((header, col) => {
    return Math.max(
      header.length,
      ...cells.map((cell) => {
        return (cell[col] ?? '').length
      }),
    )
  })

  const renderRow = (values: readonly string[]): string => {
    return values
      .map((value, col) => {
        return value.padEnd(widths[col] ?? 0)
      })
      .join(' | ')
      .trimEnd()
  }

  const separator = widths
    .map((width) => {
      return '─'.repeat(width)
    })
    .join('─┼─')

  return ['Environments:', '', renderRow(ENV_TABLE_HEADERS), separator, ...cells.map(renderRow)]
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
 * // logs an aligned table: 'dev | gh-workflow | set', 'stage | gh-workflow | not set'
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
    logger.info('  or add a token for one manually.')

    return buildResult({ project, envs: tokens })
  }

  for (const line of formatEnvTable(tokens)) {
    logger.info(line)
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
    "List the environments this project has. The list is the union of two local sources: every environment declared in a GitHub workflow's `workflow_dispatch` `environment.options` (source `gh-workflow`), and every environment the local token store holds a token for (source `token-only`). Not a live fetch from Doppler — a Doppler service token is config-scoped and cannot enumerate sibling configs. Also returns the Doppler project name, and reports per environment whether a service token resolves locally (from the token store or INFRA_KIT_ENV_TOKEN) — presence only, never the token value, and never a live Doppler probe. Read-only.",
  inputSchema: {},
  outputSchema: {
    project: z.string().describe('Detected Doppler project name'),
    configs: z.array(z.string()).describe('Every environment name known to this project'),
    tokens: z
      .array(
        z.object({
          env: z.string().describe('Environment / Doppler config name'),
          source: z
            .enum(['gh-workflow', 'token-only'])
            .describe('Where we learned this environment exists — a workflow declaration, or a token we hold'),
          hasToken: z.boolean().describe('Whether a service token resolves locally for this environment'),
        }),
      )
      .describe('Per-environment token presence — never the token value'),
  },
  handler: envList,
})
