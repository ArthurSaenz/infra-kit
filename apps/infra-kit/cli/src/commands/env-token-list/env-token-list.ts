import process from 'node:process'
import { z } from 'zod'

import { buildDopplerChildEnv } from 'src/commands/env-load'
import { INFRA_KIT_ENV_TOKEN_VAR, getDopplerProject, probeEnvToken } from 'src/integrations/doppler'
import type { EnvTokenProbeOutcome } from 'src/integrations/doppler'
import { readTokenStore } from 'src/lib/env-tokens'
import { logger } from 'src/lib/logger'
import { listProjectEnvNames } from 'src/lib/project-envs'
import { redactToken } from 'src/lib/redact'
import { defineMcpTool, textContent } from 'src/types'

export interface EnvTokenListArgs {
  /** Additionally ask Doppler whether each token is alive AND scoped where it claims. One call per env. */
  check?: boolean
}

/** Where an env's token came from, rendered for the table. `-` when there is none. */
type TokenSource = 'store' | `env:${typeof INFRA_KIT_ENV_TOKEN_VAR}` | '-'

interface EnvTokenRow {
  env: string
  source: TokenSource
  /** Redacted — at most the last 4 chars. The raw token NEVER leaves this module. */
  redactedToken: string
  present: boolean
  /** Only with `--check`. `unreachable` means COULDN'T TELL, never "bad". */
  status?: EnvTokenProbeOutcome
}

/**
 * Build one row per declared environment. Pure apart from the two reads it is handed, so the
 * precedence rule — `INFRA_KIT_ENV_TOKEN` shadows the store for EVERY env, exactly as `resolveEnvToken`
 * resolves it — is testable and provably the same rule the loader uses.
 *
 * The env var is reported against every env because that is what it does: it is a single value with no
 * env dimension, so a developer with it exported is using it everywhere, whatever their store says.
 *
 * @example
 * buildEnvTokenRows(['dev'], { dev: 'dp.st.dev.abcd1234' }, undefined)
 * // => [{ env: 'dev', source: 'store', redactedToken: '****1234', present: true }]
 */
export const buildEnvTokenRows = (
  environments: string[],
  storeTokens: Record<string, string>,
  envToken: string | undefined,
): EnvTokenRow[] => {
  return environments.map((env) => {
    const token = envToken || storeTokens[env]

    if (!token) return { env, source: '-' as const, redactedToken: '-', present: false }

    return {
      env,
      source: envToken ? (`env:${INFRA_KIT_ENV_TOKEN_VAR}` as const) : ('store' as const),
      redactedToken: redactToken(token),
      present: true,
    }
  })
}

/** The rendered table's columns, in order. `CHECK` only appears when `--check` was asked for. */
const BASE_COLUMNS = ['ENV', 'SOURCE', 'TOKEN', 'PRESENT'] as const

/**
 * Render the rows as an aligned table. Values are ALREADY redacted by {@link buildEnvTokenRows} —
 * this function never sees a raw token, which is the point of doing the redaction upstream.
 *
 * @example
 * formatEnvTokenTable([{ env: 'dev', source: 'store', redactedToken: '****1234', present: true }], false)
 * // => ['ENV  SOURCE  TOKEN     PRESENT', 'dev  store   ****1234  yes']
 */
export const formatEnvTokenTable = (rows: EnvTokenRow[], checked: boolean): string[] => {
  const header = [...BASE_COLUMNS, ...(checked ? ['CHECK'] : [])]

  const cells = rows.map((row) => {
    return [row.env, row.source, row.redactedToken, row.present ? 'yes' : 'no', ...(checked ? [row.status ?? '-'] : [])]
  })

  const widths = header.map((column, index) => {
    return Math.max(
      column.length,
      ...cells.map((cell) => {
        return (cell[index] ?? '').length
      }),
    )
  })

  return [header, ...cells].map((row) => {
    return row
      .map((cell, index) => {
        return cell.padEnd(widths[index]!)
      })
      .join('  ')
      .trimEnd()
  })
}

/**
 * Show which environments have a service token, where it came from, and (with `--check`) whether
 * Doppler still accepts it for that config.
 *
 * The ONLY env-token command exposed over MCP, and it can only ever emit redacted values — the raw
 * token is read here and never rendered, logged, or returned.
 */
export const envTokenList = async ({ check }: EnvTokenListArgs = {}) => {
  // Every env the project has, not just the ones with a token — a missing token is the row worth
  // printing. See `lib/project-envs` for why this is a union of the workflows and the store.
  const envs = await listProjectEnvNames()
  const store = await readTokenStore()
  const envToken = process.env[INFRA_KIT_ENV_TOKEN_VAR]

  const rows = buildEnvTokenRows(envs, store?.envs ?? {}, envToken)

  if (check) {
    const project = await getDopplerProject()

    for (const row of rows) {
      if (!row.present) continue

      // The RAW token is re-read here (never from the row, which only carries the redaction) and goes
      // straight into the child env — by ENV, never argv.
      const token = envToken || store!.envs[row.env]!

      const probe = await probeEnvToken({
        childEnv: buildDopplerChildEnv(token),
        project,
        config: row.env,
      })

      row.status = probe.outcome
    }
  }

  for (const line of formatEnvTokenTable(rows, Boolean(check))) {
    logger.info(line)
  }

  const missing = rows.filter((row) => {
    return !row.present
  })

  if (missing.length > 0) {
    logger.info(
      `\nNo token for: ${missing
        .map((row) => {
          return row.env
        })
        .join(', ')}. Add one with \`infra-kit env-token-set <env>\`.`,
    )
  }

  const structuredContent = { tokens: rows }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
//
// The ONLY env-token command that is an MCP tool, and the reason is the same one that keeps
// `doctor --fix` CLI-only: `lib/tool-handler` injects `confirmedCommand: true` into EVERY tool call,
// so the MCP boundary auto-confirms by construction. An agent must never be one call away from
// writing a credential (`env-token-set`) or destroying one (`env-token-remove`). This command only
// READS, and only ever emits redacted values. Do not "fix" this by exposing the other two.
export const envTokenListMcpTool = defineMcpTool({
  name: 'env-token-list',
  description:
    'List the Doppler service tokens configured for this repo: one row per environment declared in infra-kit.json, with its source (the local token store, or the INFRA_KIT_ENV_TOKEN env var) and a REDACTED token (last 4 chars at most — the raw value is never returned). With check=true, also asks Doppler whether each token is valid and correctly scoped (valid | revoked | mis-scoped | unreachable; "unreachable" means the probe could not tell, NOT that the token is bad). Read-only.',
  inputSchema: {
    check: z
      .boolean()
      .optional()
      .describe('Probe Doppler for each token’s validity and scope (one cheap call per environment).'),
  },
  outputSchema: {
    tokens: z
      .array(
        z.object({
          env: z.string().describe('Environment / Doppler config name'),
          source: z.string().describe('"store", "env:INFRA_KIT_ENV_TOKEN", or "-" when absent'),
          redactedToken: z.string().describe('Redacted token — last 4 chars at most, never the raw value'),
          present: z.boolean().describe('Whether a token is configured for this environment'),
          status: z.string().optional().describe('Only with check=true: valid | revoked | mis-scoped | unreachable'),
        }),
      )
      .describe('One row per declared environment'),
  },
  handler: envTokenList,
})
