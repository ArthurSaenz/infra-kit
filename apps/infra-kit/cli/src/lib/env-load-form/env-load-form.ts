import process from 'node:process'
import { z } from 'zod'

import { buildEnvTokenStatus } from 'src/commands/env-list'
import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler/token-resolver'
import { INFRA_KIT_SESSION_VAR } from 'src/lib/constants'
import { readTokenStore } from 'src/lib/env-tokens'
import { logger } from 'src/lib/logger'
import type { ProjectEnv } from 'src/lib/project-envs'
import { listProjectEnvs } from 'src/lib/project-envs'
import type { ArgumentFormProvider } from 'src/types'

/**
 * @fileoverview
 *
 * The argument form `env-load` offers when `config` is omitted: pick the environment to load into
 * the calling terminal session, from the same list `env-list` reports.
 *
 * Same seam as `lib/deploy-form`, same silent failure modes — the tests assert `!== null` on the
 * wire shape for that reason.
 */

/** A plain object — not an array, not `null`, not a primitive. */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collapse a failed enumeration into an empty one — the provider's own contract is never-throws. */
const orEmpty = async (work: Promise<ProjectEnv[]>): Promise<ProjectEnv[]> => {
  try {
    return await work
  } catch {
    return []
  }
}

/**
 * The envs no token resolves for. An unreadable store reports every env as token-less: the load
 * would fail on the same read, so the form says so up front rather than pretending otherwise.
 */
const tokenlessEnvs = async (envs: ProjectEnv[]): Promise<string[]> => {
  const store = await readTokenStore().catch(() => {
    return null
  })

  return buildEnvTokenStatus(envs, store?.envs ?? {}, process.env[INFRA_KIT_ENV_TOKEN_VAR])
    .filter((status) => {
      return !status.hasToken
    })
    .map((status) => {
      return status.env
    })
}

/**
 * Build the `formProvider` for the `env-load` tool.
 *
 * @example
 * envLoadMcpTool.formProvider = createEnvLoadFormProvider()
 */
export const createEnvLoadFormProvider = (): ArgumentFormProvider => {
  return {
    // A getter, not a string: `envLoadMcpTool` is a module-scope constant, so a plain string would
    // freeze the session id at import time. Production never changes it after boot; tests set it
    // after the import. Satisfies `message: string` structurally.
    get message(): string {
      const session =
        process.env[INFRA_KIT_SESSION_VAR] ?? `UNKNOWN — ${INFRA_KIT_SESSION_VAR} is not set, the load will fail`

      return `Choose the environment to load into terminal session ${session}. Picking one LOADS it; there is no further prompt.`
    },

    isFormable: (params: unknown): boolean => {
      return isRecord(params) && (params.config === undefined || params.config === '')
    },

    buildRequestedSchema: async (): Promise<z.ZodObject<z.ZodRawShape> | null> => {
      const envs = await orEmpty(listProjectEnvs())

      // `null` with a log line, never `z.enum([])`: the latter throws inside `elicit()` and degrades
      // to a gate that looks exactly like a client which cannot render forms.
      if (envs.length === 0) {
        logger.info({ msg: 'Tool execution form options empty: env-load' })

        return null
      }

      const names = envs.map((env) => {
        return env.env
      })
      const tokenless = await tokenlessEnvs(envs)

      // The token annotation rides in the field prose: the elicitation wire shape carries no
      // per-option labels, so the description is the only place the human can be told before they pick.
      return z.object({
        config: z
          .enum(names)
          .describe(
            `The environment to load. ${
              tokenless.length === 0
                ? 'A service token is stored for every one of them.'
                : `NO stored token for: ${tokenless.join(', ')} — choosing one of those fails until you run \`infra-kit env-token-set <env>\`.`
            } The list is what env-list knows: workflow-declared environments first, then token-only ones.`,
          ),
      })
    },

    toArgs: (content: Record<string, unknown>, params: unknown): Record<string, unknown> | null => {
      const { config } = content

      if (typeof config !== 'string' || config.length === 0) return null

      return { ...(isRecord(params) ? params : {}), config }
    },
  }
}
