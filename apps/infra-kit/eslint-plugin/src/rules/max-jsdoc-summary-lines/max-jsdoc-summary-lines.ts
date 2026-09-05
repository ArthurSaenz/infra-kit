import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

interface Options {
  maxSummaryLines?: number
  exemptTags?: string[]
}

// The user's stated requirement: a reader should grasp the essence of a comment in 3 to 5 lines.
// 5 is the loose end of that range, so it is the default — the rule enforces the ceiling the user
// named, not a tighter one invented here.
//
// Calibration: 51 of 2,171 JSDoc blocks in `apps/infra-kit/cli/src` exceed 5 summary lines (static
// script, 2026-09-05, `docs/comment-review-skill-plan.md` §9). That is 2.3% of linted blocks — the
// same order as `max-jsdoc-lines`'s 2.12%, i.e. a normal lint-rule yield rather than a sweep.
const DEFAULT_MAX_SUMMARY_LINES = 5

// COMPOSES WITH `max-jsdoc-lines`, does not overlap it: that rule caps the WHOLE block at 15 lines
// (prose and `@example` bodies budgeted separately); this one caps only the FIRST PARAGRAPH at 5.
// A block can satisfy either and fail the other — a 40-line block whose summary is two lines is a
// well-shaped long block, and a 7-line block that is one unbroken paragraph is a badly-shaped short
// one. Do not unify them: the second number is about whether a reader can skim, not about height.
//
// Same list as `max-jsdoc-lines` deliberately, so one `@fileoverview` tag exempts a module-level
// block from both rules rather than requiring two different escape hatches.
const DEFAULT_EXEMPT_TAGS = ['fileoverview', 'module', 'packageDocumentation']

/** A JSDoc block: the house idiom, shared verbatim with `max-jsdoc-lines`. */
const isJsdocBlock = (comment: ESTree.Comment): boolean => {
  return comment.type === 'Block' && comment.value.startsWith('*')
}

/**
 * The block's lines with the leading whitespace and `*` gutter removed, so a gutter-only line
 * reads as `''` and tag detection sees `@param` rather than ` * @param`. One entry per source
 * line the block occupies (`comment.value` keeps every newline between `/**` and the closer).
 */
const strippedLines = (comment: ESTree.Comment): string[] => {
  return comment.value.split('\n').map((line) => {
    return line.replace(/^\s*\*+/, '').trim()
  })
}

/**
 * The JSDoc tag a stripped line opens (`@param …` → `param`), or null for body/prose.
 *
 * Lower-cased on the way out so every comparison against it can be case-insensitive; without
 * this a `@Fileoverview` would parse as a tag but match neither the paragraph boundary check nor
 * `exemptTags`, giving the author an escape hatch that silently does not work.
 */
const tagNameOf = (line: string): string | null => {
  return line.match(/^@([A-Z][\w-]*)/i)?.[1]?.toLowerCase() ?? null
}

/**
 * The height of the summary paragraph, in PROSE lines.
 *
 * The scan skips leading gutter-only lines (the `/**` opener strips to `''`, and so does a block
 * that opens with a blank gutter line), then counts prose until the first blank line or the first
 * line opening any tag, whichever comes first. A block with neither is one paragraph end to end,
 * so its whole prose body is the summary.
 *
 * Delimiter lines are NOT counted: the opener and the closing line carry no prose, and charging them
 * would make every block read two lines longer than what a reader actually reads. This is the one
 * place the count differs from `max-jsdoc-lines`, which measures visual height and so counts them.
 *
 * A block whose first non-empty line already opens a tag has a zero-line summary and can never
 * report — intentional, since `@param`-only blocks are a contract, not a description.
 */
const summaryLineCount = (lines: string[]): number => {
  let count = 0

  for (const line of lines) {
    const isBlank = line === ''

    if (tagNameOf(line) !== null || (isBlank && count > 0)) {
      break
    }

    if (!isBlank) {
      count += 1
    }
  }

  return count
}

/**
 * Whether the block declares any exempt tag — the rule's one and only escape hatch.
 *
 * `exemptTags` is normalised here rather than at the call site so a configured `['FileOverview']`
 * behaves the same as `['fileoverview']`; `tagNameOf` already lower-cases.
 */
const hasExemptTag = (lines: string[], exemptTags: string[]): boolean => {
  const normalized = exemptTags.map((tag) => {
    return tag.toLowerCase()
  })

  return lines.some((line) => {
    const tag = tagNameOf(line)

    return tag !== null && normalized.includes(tag)
  })
}

export const maxJsdocSummaryLines: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Cap the height of a JSDoc summary paragraph, so the first thing a reader sees is graspable at a glance and the detail sits below a blank line.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#max-jsdoc-summary-lines',
    },
    // Deliberately NOT fixable, for the same reason `max-jsdoc-lines` is not: the mechanical fix
    // (insert a blank line after line 5) splits a paragraph at an arbitrary point and produces a
    // summary that reads as truncated. Deciding what the first glance must contain is judgement.
    schema: [
      {
        type: 'object',
        properties: {
          maxSummaryLines: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum prose lines the summary paragraph may span before the rule reports. The summary runs from the first prose line to the first blank line or first tag.',
          },
          exemptTags: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tag names (without `@`) that exempt a block from the check. The only exemption mechanism; intended for module-level blocks whose length is the point.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      // Names the offending count, the cap, and the escape hatch inline. No `suggest`: a suggestion
      // is host-UI-only and therefore invisible to the text-reading agents that are half this
      // rule's audience.
      summaryTooLong:
        'This JSDoc summary paragraph runs {{lines}} lines (max {{max}}). Keep the first paragraph to what a reader needs in one glance, then a blank line, then the detail. If this IS module-level rationale, tag the block `@fileoverview` to exempt it.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const maxSummaryLines = options.maxSummaryLines ?? DEFAULT_MAX_SUMMARY_LINES
    const exemptTags = options.exemptTags ?? DEFAULT_EXEMPT_TAGS

    const { sourceCode } = context

    return {
      Program() {
        // EOF guard (NOT symbol attachment — this rule deliberately never resolves the symbol a
        // block documents): the start offset of the last token, so a trailing block with no token
        // after it is skipped as degenerate input. Mirrors `max-jsdoc-lines`.
        const lastTokenStart = sourceCode.ast.tokens.at(-1)?.range[0] ?? -1

        // Comment-driven, not node-driven: every JSDoc-shaped block in the file is linted and
        // exemptions are explicit. `//` line comments and plain `/* */` blocks are not JSDoc and
        // are never measured — `isJsdocBlock` is the whole filter.
        for (const comment of sourceCode.getAllComments()) {
          if (!isJsdocBlock(comment) || !comment.loc || !comment.range) {
            continue
          }

          if (lastTokenStart <= comment.range[1]) {
            continue
          }

          const lines = strippedLines(comment)

          if (hasExemptTag(lines, exemptTags)) {
            continue
          }

          const summaryLines = summaryLineCount(lines)

          if (summaryLines > maxSummaryLines) {
            context.report({
              loc: comment.loc,
              messageId: 'summaryTooLong',
              data: { lines: summaryLines, max: maxSummaryLines },
            })
          }
        }
      },
    }
  },
}
