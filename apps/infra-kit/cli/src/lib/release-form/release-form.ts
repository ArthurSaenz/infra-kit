import { z } from 'zod'

import { withDeadline } from 'src/lib/deadline'
import { logger } from 'src/lib/logger'
import { classifyReleaseToken, loadExistingVersions, suggestNextVersion } from 'src/lib/version-utils'
import type { ArgumentFormProvider } from 'src/types'

/**
 * @fileoverview
 *
 * The argument form `release-create` offers when `releases` is omitted: the wizard's three questions
 * (type, version-or-name, description) for ONE release, feeding the confirm gate.
 *
 * Same seam as `lib/deploy-form`, same silent failure modes — the tests assert `!== null` on the
 * wire shape for that reason. Unlike the deploy and env-load providers there is NO enumeration here
 * to come back empty: the only network-bound work is the `[next]` hint, and it degrades to prose, so
 * this provider never answers `null` from `buildRequestedSchema`.
 *
 * Imports deliberately stop at `src/lib/**`. `release-create.ts` registers this provider inside its
 * module-scope `defineMcpTool({...})` literal; an import back into `src/commands/**` from here would
 * make any entry through this module evaluate that literal before this module's body exists (an ESM
 * TDZ `ReferenceError`). The provider's own test is the detector.
 */

/**
 * How long the `[next]` hint may take before the form goes out without it.
 *
 * `git ls-remote --heads origin 'release/v*'` over SSH measured 1.65 / 1.80 / 1.88 s (three runs,
 * this repo, 2026-09-15), and `loadExistingVersions` is the slower of that and the Jira fetch. 2 000
 * would drop the hint on roughly half of ordinary runs; 2 500 leaves 500 ms under the chokepoint's
 * `FORM_DEADLINE_MS` (3 000), which arms only AFTER this provider's promise exists, so the headroom
 * covers event-loop latency and nothing else. Overrunning THIS budget costs the hint; overrunning the
 * chokepoint's would cost the whole form, and this budget is what makes that unreachable.
 */
export const HINT_BUDGET_MS = 2_500

/** A plain object — not an array, not `null`, not a primitive. */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface NextHint {
  regular: string | null
  hotfix: string | null
}

const computeHint = async (): Promise<NextHint> => {
  const known = await loadExistingVersions()

  return { regular: suggestNextVersion(known, 'regular'), hotfix: suggestNextVersion(known, 'hotfix') }
}

/**
 * The `[next]` sentence appended to the `release` field's prose — the hint rides in the description
 * because the elicitation wire shape has nowhere else to put it.
 */
const hintProse = (hint: NextHint | null, budgetMs: number): string => {
  if (hint === null) {
    logger.info({ msg: 'Tool execution form hint unavailable (timeout): release-create' })

    // Interpolated, not spelled: the budget is injectable, and a literal "2.5 s" would drift from it.
    return `The "next" hint could not be computed within ${budgetMs / 1000} s — "next" still works and is resolved at execution.`
  }

  if (hint.regular === null && hint.hotfix === null) {
    logger.info({ msg: 'Tool execution form hint unavailable (no prior versions): release-create' })

    return 'No prior version is known from origin release/v* branches or Jira, so "next" will be REFUSED — pass an explicit semver.'
  }

  return `"next" resolves to ${hint.regular} for a regular release or ${hint.hotfix} for a hotfix (computed now from origin release/v* branches and Jira fix versions; recomputed at execution).`
}

/**
 * Build the `formProvider` for the `release-create` tool.
 *
 * @example
 * defineMcpTool({ name: 'release-create', formProvider: createReleaseFormProvider(), ... })
 */
export const createReleaseFormProvider = (options: { hintBudgetMs?: number } = {}): ArgumentFormProvider => {
  const hintBudgetMs = options.hintBudgetMs ?? HINT_BUDGET_MS

  return {
    // The form FEEDS the gate here; the env picker's "picking one LOADS it" is the ungated opposite.
    message:
      'Choose the release to cut. Nothing runs yet: the confirm gate follows, and the agent will show you the resolved arguments to approve.',

    isFormable: (params: unknown): boolean => {
      // The CLI action collapses an empty input list to `undefined` (program.ts), so the empty-array
      // clause serves unit tests and direct callers only.
      return (
        isRecord(params) &&
        (params.releases === undefined || (Array.isArray(params.releases) && params.releases.length === 0))
      )
    },

    // No provider-level try/catch: `refuseMissingArguments` already wraps this call, and a second
    // wrap would only hide a programming error from the unit lane that calls this directly.
    buildRequestedSchema: async (): Promise<z.ZodObject<z.ZodRawShape> | null> => {
      // The ONLY collapse to `null` on this path; it abandons the git child rather than cancelling it.
      const hint = await withDeadline(computeHint(), hintBudgetMs)

      // Property order is the wizard's: type before the token. Both are REQUIRED on the wire — what a
      // host sends for an untouched optional select on Accept is unmeasured, and if it were `""` the
      // enum would reject and discard the whole accepted form, the human's `release` included. No
      // `.min(1)`/`.regex()` on `release`: neither is a measured wire shape; blank is `toArgs`'s job.
      return z.object({
        type: z
          .enum(['regular', 'hotfix'])
          .describe(
            'Release type. "regular" branches off dev and bumps the minor; "hotfix" branches off main and bumps the patch.',
          ),
        release: z
          .string()
          .describe(
            `A semver such as "1.64.0", the literal "next", or a kebab-case name such as "checkout-redesign". ${hintProse(hint, hintBudgetMs)}`,
          ),
        description: z
          .string()
          .optional()
          .describe('Optional. Becomes the Jira fix version description and feeds the PR body. Blank means none.'),
      })
    },

    toArgs: (content: Record<string, unknown>, params: unknown): Record<string, unknown> | null => {
      const token = typeof content.release === 'string' ? content.release.trim() : ''

      // The one `null`: a blank token lands on the `formDiscarded` gate, whose round-1 arguments carry
      // no `releases`, and confirming THAT is refused by the command — so a blank can never execute.
      if (token === '') return null

      // Total, and always PRESENT: the tool's transform defaults `type`, so the merged object must
      // already carry it or the gate would sign arguments that differ from what round 2 parses.
      const type = content.type === 'hotfix' ? 'hotfix' : 'regular'
      const description =
        typeof content.description === 'string' && content.description.trim() !== ''
          ? content.description.trim()
          : undefined

      // A name the rule rejects still goes through: `resolveReleaseEntries` refuses it on round 2 with
      // the kebab-case remediation, before anything has mutated — a refusal that names the rule, where
      // a `null` here would be a gate that names nothing.
      const id = classifyReleaseToken(token)

      return {
        ...(isRecord(params) ? params : {}),
        releases: [{ ...id, type, ...(description === undefined ? {} : { description }) }],
      }
    },
  }
}
