import { z } from 'zod'

import { NO_OPEN_RELEASE_PRS_OPERATION, getReleasePRsWithInfo } from 'src/integrations/gh'
import type { ReleasePRInfo } from 'src/integrations/gh'
import { withDeadline } from 'src/lib/deadline'
import { OperationError } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'
import { formatJiraName } from 'src/lib/release-id'
import { getJiraDescriptions, parseBranchChoices } from 'src/lib/release-utils'
import type { ArgumentFormProvider } from 'src/types'

/**
 * @fileoverview
 *
 * The argument form `release-rename` offers when `old` is omitted: the open release PRs as ONE
 * required select, plus the new name as free text, feeding the confirm gate. Modelled on
 * `release-remove-form`; imports stop at `src/lib/**` and `src/integrations/**` for the same ESM TDZ
 * reason that file gives.
 */

/** Same budget and measurement as `release-remove-form`'s `FETCH_BUDGET_MS`: one `gh pr list` pair. */
export const FETCH_BUDGET_MS = 2_500

const TOOL_NAME = 'release-rename'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const blank = (value: unknown): boolean => {
  return value === undefined || value === ''
}

type Enumeration = { outcome: 'listed'; prs: ReleasePRInfo[] } | { outcome: 'empty' } | { outcome: 'failed' }

const enumerate = async (): Promise<Enumeration> => {
  try {
    return { outcome: 'listed', prs: await getReleasePRsWithInfo() }
  } catch (error) {
    return error instanceof OperationError && error.operation === NO_OPEN_RELEASE_PRS_OPERATION
      ? { outcome: 'empty' }
      : { outcome: 'failed' }
  }
}

const noOptions = (enumeration: Enumeration | null, budgetMs: number): null => {
  if (enumeration === null) {
    logger.info({
      msg: `Tool execution form enumeration timed out (gh pr list, ${budgetMs / 1000} s): ${TOOL_NAME}`,
    })
  } else if (enumeration.outcome === 'failed') {
    logger.info({ msg: `Tool execution form enumeration failed (gh pr list): ${TOOL_NAME}` })
  } else {
    logger.info({ msg: `Tool execution form options empty (open release PRs): ${TOOL_NAME}` })
  }

  return null
}

/** `1.2.5 [regular] — <description>`; descriptions are keyed by the Jira NAME, not the branch. */
const rowLabels = (
  prs: ReleasePRInfo[],
  descriptions: Map<string, string> | null,
): { label: string; prose: string }[] => {
  const types = new Map(
    prs.map((pr) => {
      return [pr.branch, pr.type] as const
    }),
  )

  return parseBranchChoices(
    prs.map((pr) => {
      return pr.branch
    }),
  ).map(({ branch, id, label }) => {
    const description = descriptions?.get(formatJiraName(id))
    const tail = description === undefined ? '' : ` — ${description}`

    return { label, prose: `${label} [${types.get(branch) ?? 'regular'}]${tail}` }
  })
}

/**
 * Build the `formProvider` for the `release-rename` tool.
 *
 * @example
 * defineMcpTool({ name: 'release-rename', requiresHumanConfirm: true, formProvider: createReleaseRenameFormProvider(), ... })
 */
export const createReleaseRenameFormProvider = (options: { fetchBudgetMs?: number } = {}): ArgumentFormProvider => {
  const fetchBudgetMs = options.fetchBudgetMs ?? FETCH_BUDGET_MS

  return {
    message:
      'Choose the release to rename and its new name. Nothing runs yet: the confirm gate follows, and the agent will show you the resolved plan to approve.',

    isFormable: (params: unknown): boolean => {
      return isRecord(params) && blank(params.old)
    },

    buildRequestedSchema: async (): Promise<z.ZodObject<z.ZodRawShape> | null> => {
      const [enumeration, descriptions] = await Promise.all([
        withDeadline(enumerate(), fetchBudgetMs),
        withDeadline(getJiraDescriptions(), fetchBudgetMs),
      ])

      if (enumeration === null || enumeration.outcome !== 'listed') return noOptions(enumeration, fetchBudgetMs)

      const rows = rowLabels(enumeration.prs, descriptions)

      if (rows.length === 0) return noOptions({ outcome: 'empty' }, fetchBudgetMs)

      const listed = rows
        .map((row) => {
          return row.prose
        })
        .join('; ')

      return z.object({
        old: z
          .enum(
            rows.map((row) => {
              return row.label
            }),
          )
          .describe(`The ONE release to rename. Open release PRs right now: ${listed}.`),
        new: z
          .string()
          .min(1)
          .describe(
            'The new release version (e.g. "1.3.0") or kebab-case name (e.g. "checkout-redesign"); "next" is not accepted.',
          ),
      })
    },

    // MERGES over round 1: a blank field is replaced, every other key rides through.
    toArgs: (content: Record<string, unknown>, params: unknown): Record<string, unknown> | null => {
      if (typeof content.old !== 'string') return null

      const merged: Record<string, unknown> = { ...(isRecord(params) ? params : {}), old: content.old }

      if (typeof content.new === 'string' && content.new !== '') merged.new = content.new

      return merged
    },
  }
}
