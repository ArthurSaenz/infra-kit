import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

interface Options {
  maxLines?: number
  maxExampleLines?: number
  exemptTags?: string[]
}

// Prose budget = total lines MINUS `@example` body lines. Simulated against the real rule
// semantics over the linted corpus (6108 blocks across the source repo + its five sync
// targets; evidence brief §4c): 15 → 125 reports / 113 unique / 2.12% of linted blocks —
// a normal lint-rule yield, roughly one sprint of cleanup. 20 → 47 reports, too thin to
// change behaviour; 12 → 235, more than one sprint.
// NOTE: the brief's §2 figure ("183 at cap 15") measures raw BLOCK length, not this budget.
const DEFAULT_MAX_LINES = 15

// `@example` body length across the 637 example-carrying blocks (brief §4b):
// p50=4, p90=9, p95=12, p99=23, max=35. 10 ≈ p90 → 48 reports / 28 unique (§4c).
// 20 would reach only 10 blocks corpus-wide — too loose to justify the rule's strongest half.
const DEFAULT_MAX_EXAMPLE_LINES = 10

// Zero existing usages of any of these tags corpus-wide (§4), so adopting them costs nothing.
// This is the ONLY exemption mechanism: there is deliberately no positional fallback, because
// position exempts by luck — the corpus's `stdin-ref.ts:3` is a 39-line file-level block whose
// next statement is `let readers = 0`, so no "precedes the first import" spelling would reach it.
const DEFAULT_EXEMPT_TAGS = ['fileoverview', 'module', 'packageDocumentation']

/** A JSDoc block: the house idiom, shared verbatim with `require-jsdoc-example`. */
const isJsdocBlock = (comment: ESTree.Comment): boolean => {
  return comment.type === 'Block' && comment.value.startsWith('*')
}

/**
 * The block's lines with the leading whitespace and `*` gutter removed, so tag
 * detection sees `@example` rather than ` * @example`. One entry per source line the
 * block occupies (`comment.value` keeps every newline between `/**` and the closer).
 */
const strippedLines = (comment: ESTree.Comment): string[] => {
  return comment.value.split('\n').map((line) => {
    return line.replace(/^\s*\*+/, '').trim()
  })
}

/**
 * The JSDoc tag a stripped line opens (`@example …` → `example`), or null for body/prose.
 *
 * Lower-cased on the way out: the match is case-insensitive, so every comparison against it
 * must be too. Without this, `@Example` parses as a tag but matches neither the example scan
 * nor `exemptTags` — the author gets a prose violation and a `@Fileoverview` escape hatch that
 * silently does not work.
 */
const tagNameOf = (line: string): string | null => {
  return line.match(/^@([A-Z][\w-]*)/i)?.[1]?.toLowerCase() ?? null
}

/**
 * Total lines occupied by the block's `@example` bodies.
 *
 * A scan enters example mode on an `@example` line (the tag line itself counts) and leaves
 * it at the next line opening any tag. An `@example` that is the block's last tag therefore
 * runs through the closing `*` + `/` line — which is how the corpus was measured, and what
 * makes `prose + example === total` exact. Bodies from multiple `@example` tags sum.
 *
 * KNOWN PARSER HAZARD: any line opening with `@` ends the body, so a decorator
 * (`@Injectable`) written inside an `@example` truncates it early. The effect is worse than an
 * under-count: the truncated lines are recharged to PROSE, so the block reports `tooManyLines`
 * and advises `@fileoverview` — misleading advice for a block whose real problem is a long
 * example. A scan of all 637 example bodies in the corpus found ZERO lines starting with `@`
 * that were not real tags, so this is correct today — measured, not assumed, and not
 * future-proof. A real JSDoc parser is the fix if that ever stops holding.
 */
const countExampleLines = (lines: string[]): number => {
  let inExample = false
  let count = 0

  for (const line of lines) {
    const tag = tagNameOf(line)

    if (tag) {
      inExample = tag === 'example'
    }

    if (inExample) {
      count += 1
    }
  }

  return count
}

/**
 * Whether the block declares any exempt tag — the rule's one and only escape hatch.
 *
 * `exemptTags` is normalised here rather than at the call site so a configured
 * `['FileOverview']` behaves the same as `['fileoverview']`; `tagNameOf` already lower-cases.
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

export const maxJsdocLines: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Cap the height of a JSDoc block, budgeting its prose and its `@example` bodies separately so a rule-mandated example never consumes the prose budget.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#max-jsdoc-lines',
    },
    // Deliberately NOT fixable. Any fixer would have to delete sentences, and the longest
    // blocks in the corpus are the most valuable documentation in it. The part of this
    // problem that IS mechanically fixable — blank-line padding and `{type}` annotations —
    // is already handled upstream by `jsdoc/tag-lines` and `jsdoc/no-types`.
    schema: [
      {
        type: 'object',
        properties: {
          maxLines: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum lines a JSDoc block may span, excluding its `@example` bodies, before the rule reports.',
          },
          maxExampleLines: {
            type: 'integer',
            minimum: 1,
            description:
              "Maximum lines the block's `@example` bodies may span in total. Budgeted separately from `maxLines` so a rule-mandated example never consumes the prose budget.",
          },
          exemptTags: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tag names (without `@`) that exempt a block from every check. The only exemption mechanism; intended for module-level blocks whose length is the point.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      // Names `@fileoverview` inline: with no positional exemption, this message is the only
      // thing standing between a long file-level rationale block and an author's delete key.
      tooManyLines:
        'This JSDoc block spans {{lines}} lines of prose (max {{max}}; `@example` bodies are budgeted separately). Keep the contract — what it does and what a caller must know — and move rationale into a `//` note or the file-level block. If this IS module-level rationale, tag the block `@fileoverview` to exempt it.',
      exampleTooLong:
        'The `@example` bodies in this JSDoc block span {{lines}} lines (max {{max}}). Show the smallest call that teaches usage; a full walkthrough belongs in a test or the readme.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    const maxExampleLines = options.maxExampleLines ?? DEFAULT_MAX_EXAMPLE_LINES
    const exemptTags = options.exemptTags ?? DEFAULT_EXEMPT_TAGS

    const { sourceCode } = context

    return {
      Program() {
        // EOF guard (NOT symbol attachment — this rule deliberately never resolves the symbol
        // a block documents): the start offset of the last token, so a trailing block with no
        // token after it can be skipped as degenerate input.
        const lastTokenStart = sourceCode.ast.tokens.at(-1)?.range[0] ?? -1

        // Comment-driven, not node-driven: every JSDoc-shaped block in the file is linted and
        // exemptions are explicit. A node-driven walk needs an anchor-type allowlist, which is
        // exactly how `jsdoc/match-description` ends up not covering `type`/`interface`. It also
        // avoids `SourceCode#getJSDocComment`, which ESLint 10 removed outright.
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

          const totalLines = comment.loc.end.line - comment.loc.start.line + 1
          const exampleLines = countExampleLines(lines)
          const proseLines = totalLines - exampleLines

          // Two independent budgets: both can report on the same block.
          if (proseLines > maxLines) {
            context.report({
              loc: comment.loc,
              messageId: 'tooManyLines',
              data: { lines: proseLines, max: maxLines },
            })
          }

          if (exampleLines > maxExampleLines) {
            context.report({
              loc: comment.loc,
              messageId: 'exampleTooLong',
              data: { lines: exampleLines, max: maxExampleLines },
            })
          }
        }
      },
    }
  },
}
