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
 * The argument form `release-remove` offers when `version` is omitted: the CLI picker's list — the
 * open release PRs, with their type and Jira description — as ONE required select, feeding the
 * confirm gate.
 *
 * Same seam as `lib/deploy-form` and `lib/release-form`, same silent failure modes — the tests assert
 * `!== null` on the wire shape for that reason. Unlike `release-form`, the enumeration here CAN come
 * back with nothing to offer, and it can do so for three reasons a human acts on differently (no
 * open release PRs / `gh` failed / `gh` was too slow), so each reason is its own log line and none
 * of them is collapsed into another.
 *
 * Imports deliberately stop at `src/lib/**` and `src/integrations/**`. `release-remove.ts` registers
 * this provider inside its module-scope `defineMcpTool({...})` literal; an import back into
 * `src/commands/**` from here would make any entry through this module evaluate that literal before
 * this module's body exists (an ESM TDZ `ReferenceError`). The provider's own test is the detector.
 */

/**
 * How long EACH of the two fetches (the PR enumeration, the Jira descriptions) may take, in
 * parallel, before the form goes out without it — or, for the enumeration, not at all.
 *
 * One `gh pr list --search` measured 853 / 1170 / 1108 ms on hulyo-monorepo (37 open release PRs)
 * and 1494 / 819 / 1199 ms on travelist-monorepo (34), three runs each, warm `gh` auth, 2026-09-15;
 * 862 / 773 / 997 ms on this repo. `fetchAllReleasePRs` issues its two searches together, so the
 * enumeration costs the slower of the pair — ~1.2 s typical, 1.5 s seen — and 2 500 leaves the
 * worst run ~1.7× headroom while staying 500 ms under the chokepoint's `FORM_DEADLINE_MS` (3 000),
 * which arms only AFTER this provider's promise exists. Overrunning THIS budget costs the form with a
 * log line that says so; overrunning the chokepoint's would cost it silently, and this budget is what
 * makes that unreachable.
 */
export const FETCH_BUDGET_MS = 2_500

const TOOL_NAME = 'release-remove'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Round 1 left `version` for the human to supply. A blank string counts: the tool's schema accepts
 * `''` and the handler refuses it on confirm, so offering the picker is the better exit.
 */
const versionAbsent = (params: Record<string, unknown>): boolean => {
  return params.version === undefined || params.version === ''
}

type Enumeration = { outcome: 'listed'; prs: ReleasePRInfo[] } | { outcome: 'empty' } | { outcome: 'failed' }

/**
 * `getReleasePRsWithInfo` reports "nothing open" and "gh failed" through the same `throw`; only the
 * refusal's `operation` tells them apart, and the human's next step differs ("there is nothing to
 * remove" vs "check `gh auth status`"), so the split happens here rather than in `withDeadline`,
 * which would flatten both into the timeout's `null`.
 */
const enumerate = async (): Promise<Enumeration> => {
  try {
    return { outcome: 'listed', prs: await getReleasePRsWithInfo() }
  } catch (error) {
    return error instanceof OperationError && error.operation === NO_OPEN_RELEASE_PRS_OPERATION
      ? { outcome: 'empty' }
      : { outcome: 'failed' }
  }
}

/** `null` with a REASON: one line per way the enumeration can yield nothing (see the fileoverview). */
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

interface PickerRow {
  label: string
  prose: string
}

/**
 * One row per open release PR, as the CLI picker renders it: `1.2.5 [regular]`, and
 * ` — <description>` when Jira has one. The description map is keyed by the Jira version NAME
 * (`v1.2.5`), the same keying `formatBranchPickerItems` uses — a branch-keyed lookup renders nothing.
 */
const pickerRows = (prs: ReleasePRInfo[], descriptions: Map<string, string> | null): PickerRow[] => {
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

/** The rows' sentence, plus what the human is told when Jira could not decorate them. */
const rowsProse = (rows: PickerRow[], descriptions: Map<string, string> | null, budgetMs: number): string => {
  const listed = rows
    .map((row) => {
      return row.prose
    })
    .join('; ')

  if (descriptions !== null) return `Open release PRs right now: ${listed}. `

  logger.info({ msg: `Tool execution form descriptions unavailable (timeout): ${TOOL_NAME}` })

  // Interpolated, not spelled: the budget is injectable, and a literal "2.5 s" would drift from it.
  return `Open release PRs right now: ${listed}. Jira descriptions could not be fetched within ${budgetMs / 1000} s. `
}

/**
 * Build the `formProvider` for the `release-remove` tool.
 *
 * @example
 * defineMcpTool({ name: 'release-remove', requiresHumanConfirm: true, formProvider: createReleaseRemoveFormProvider(), ... })
 */
export const createReleaseRemoveFormProvider = (options: { fetchBudgetMs?: number } = {}): ArgumentFormProvider => {
  const fetchBudgetMs = options.fetchBudgetMs ?? FETCH_BUDGET_MS

  return {
    // The form FEEDS the gate here; the env picker's "picking one LOADS it" is the ungated opposite.
    message:
      'Choose the release to remove. Nothing runs yet: the confirm gate follows, and the agent will show you the resolved arguments to approve.',

    isFormable: (params: unknown): boolean => {
      return isRecord(params) && versionAbsent(params)
    },

    // No provider-level try/catch: `refuseMissingArguments` already wraps this call, and a second
    // wrap would only hide a programming error from the unit lane that calls this directly.
    buildRequestedSchema: async (): Promise<z.ZodObject<z.ZodRawShape> | null> => {
      // Both bounded, both abandoned rather than cancelled on timeout. `enumerate` never rejects, so
      // the enumeration's `null` can only mean the deadline; the descriptions' `null` means either.
      const [enumeration, descriptions] = await Promise.all([
        withDeadline(enumerate(), fetchBudgetMs),
        withDeadline(getJiraDescriptions(), fetchBudgetMs),
      ])

      if (enumeration === null || enumeration.outcome !== 'listed') return noOptions(enumeration, fetchBudgetMs)

      const rows = pickerRows(enumeration.prs, descriptions)

      // `z.enum([])` is not an empty dropdown, it is a `TypeError` thrown inside `elicit()` and
      // flattened into the same `null` a form-less client produces — unreachable while `listed`
      // carries at least one PR whose head ref parses, which `getReleasePRsWithInfo` guarantees.
      if (rows.length === 0) return noOptions({ outcome: 'empty' }, fetchBudgetMs)

      // REQUIRED: round 1 has no usable `version` by construction, so there is nothing for a blank
      // to keep, and what a host sends for an untouched optional select on Accept is unmeasured.
      return z.object({
        version: z
          .enum(
            rows.map((row) => {
              return row.label
            }),
          )
          .describe(
            `The ONE release to tear down. ${rowsProse(rows, descriptions, fetchBudgetMs)}` +
              'Nothing runs yet: the confirm gate follows, and the agent will show you the resolved arguments to approve. ' +
              'Removal deletes the worktree, closes the PR, deletes both branches AND removes the Jira fix version — the last is irreversible.',
          ),
      })
    },

    // MERGES over round 1 — never a fresh object. A blank round-1 `version` is replaced, and any
    // other key (`moveIssuesTo`, `confirm`) rides through untouched.
    toArgs: (content: Record<string, unknown>, params: unknown): Record<string, unknown> | null => {
      if (typeof content.version !== 'string') return null

      return { ...(isRecord(params) ? params : {}), version: content.version }
    },
  }
}
