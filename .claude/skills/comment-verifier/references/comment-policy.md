# Comment policy

This file is the only source of the policy. The ESLint options and the skill's JSON output are
derived expressions of it, never second copies of the prose.

## The policy, verbatim

> Comment the **why**, never the **what**. If a comment would only restate what the code already
> says (a name, a type, an obvious assignment), delete it — and if code needs a comment to be
> *understood*, prefer renaming/refactoring until it reads on its own. Reserve comments for the
> genuinely non-obvious: external quirks, ordering constraints, fail-safe branches, workarounds.
> Keep them compact. Focus on business-logic descriptions.

## Size

A comment should be graspable in **3 to 5 lines**. That number governs the **summary paragraph** —
the prose from the block's first line to the first blank line or the first `@tag`, whichever comes
first — not the whole block. A block with a three-line summary and twenty `@param` lines is within
policy.

The mechanical layer caps the **whole block** at 15 lines, which is a different measurement. The two
compose rather than overlap: 5 for the summary, 15 for the block.

## The five actions

Every reviewed comment gets exactly one.

| Action | Meaning |
|---|---|
| `delete` | The comment restates something the code already says. Removing it loses nothing. |
| `shorten` | The comment carries a real why, buried in more lines than it needs. Keep the why, cut the rest. |
| `rewrite-as-why` | The comment describes what the code does; the same site has a why worth recording instead. |
| `rename-or-refactor-instead` | The comment exists because the code does not read on its own. The fix is the code, not the comment. Reported as a leftover for a human; the apply phase never acts on it. |
| `keep` | The comment records something genuinely non-obvious. Naming which reserved category applies is what makes this a decision rather than a shrug. |

The reserved categories for `keep` are **external quirk**, **ordering constraint**, **fail-safe
branch**, and **workaround**. A `keep` that names none of them is not a `keep`.

## Corpus

Real sites from the `apps/infra-kit/cli` corpus this policy was derived from, not invented
examples. The paths are citations rather than files in this repo — the last row is the exception,
and it is here under `vendor/configs`.

| Site | Comment | Verdict |
|---|---|---|
| `apps/infra-kit/cli/src/commands/worktrees-add/worktrees-add.ts:126` | `// Ask for confirmation` above `await confirmOrExit(...)` | **Delete.** Pure restatement of the callee name. Same at `worktrees-remove.ts:155` and `worktrees-sync.ts:47`. |
| `apps/infra-kit/cli/src/commands/worktrees-list/worktrees-list.ts:61` | `// Log formatted output` | **Delete.** |
| `apps/infra-kit/cli/src/commands/gh-release-deploy-selected/gh-release-deploy-selected.ts:131` | `// Validate all selected services` above `const invalidServices = selectedServices.filter(` | **Delete**, or fold into the variable name. |
| `apps/infra-kit/cli/src/lib/vendor/manifest.ts:21-24` | the `schemaVersion` block explaining why the field is optional with no default | **Keep.** Records a compatibility constraint that no name can carry. |
| `vendor/configs/eslint-config/src/configs/docs.ts:40-42` | the `informative-docs` stemming note | **Keep.** An empirical finding about an external tool, the archetype of a comment worth writing. |

Every `what`-comment in that table is a `//` line comment, and no JSDoc rule reads those. That
asymmetry runs through the whole skill: the mechanical layer catches over-long JSDoc, the reviewer
catches restating line comments.

## The budget

That corpus is 313 files and 41,991 lines excluding tests, with 2,171 JSDoc block openers and 2,481
`//` lines. **Many of the JSDoc one-liners are already good why-comments**, and the same holds for
any codebase this skill is pointed at.

**The skill must not propose a JSDoc sweep.** A review that flags most of the JSDoc it reads has
misread the policy, not found a problem. A long block is a candidate, never a verdict: the
`informative-docs` stemming note and the `schemaVersion` note are both long precisely because they
record something no name can carry.
