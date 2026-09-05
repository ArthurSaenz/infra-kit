# [ROOT] comment-verifier: comment policy skill on top of a lint layer

Status: APPROVED for execution via ralph (2026-09-05; ralplan consensus v1.3.1 — Architect SOUND, Critic APPROVE; review mechanism settled: (ii) direct reviewer prompt for Unit 5a, `ai-slop-cleaner` standard mode under `--fix` only)

## 1. Summary

A new project skill `.claude/skills/comment-verifier/` reviews code comments against one written
policy: comment the **why**, never the **what**. A mechanical ESLint pass runs first; its findings
and the policy text drive a reviewer pass that emits a per-comment verdict and never an edit. A
separate `--fix` invocation consumes that verdict, delegates the edits to `ai-slop-cleaner` standard
mode, and is checked afterwards by a mechanical `--verify-fix` gate.

**v1.1 named the wrong rule.** `jsdoc/informative-docs` promoted to `error` over
`apps/infra-kit/cli/src` yields **zero findings**, byte-identical to the run without the override,
and it never reads `//` line comments, which is where every verified offender in §3 lives. A rule
with zero measured yield is not a mechanical layer. The mechanical layer is `@wl/max-jsdoc-lines`
instead, which yields an estimated **103 hits across the CLI source tree** and is **available
today**: the plugin is
installed at `0.1.23`, that tarball contains `dist/rules/max-jsdoc-lines/`, and it is registered for
CLI source files through `wl.configs.recommended` at
`vendor/configs/eslint-config/src/configs/components.ts:8`. `--print-config` on a CLI source file
shows three `@wl/` rules, all off. Nothing is missing but a severity. The `^0.1.23` pin was never the
obstacle, and no workspace link or publish is needed to turn this on.

What survives from v1.1: `vendor/` is checksum-guarded, `writeManifest` has no production caller,
and `infra-kit vendor check` already exits 1 on committed HEAD, so the enforcement seam is
`apps/infra-kit/cli/eslint.config.js`, which already appends local config objects.

Order of work: detectors in `packages/linter-spec`, then real enforcement in week one —
`max-jsdoc-lines` at `warn` with `--quiet` dropped from the CLI package — then the skill, then the
cleanup sprint that earns the flip to `error`.

---

## 2. RALPLAN-DR

### Principles

1. **The policy has exactly one source.** One Markdown file inside the skill. ESLint options and the
   skill's JSON output are derived expressions of it, never second copies of the prose.
2. **Mechanical before judgment, but only where a rule has measured yield.** Anything a rule can
   decide must be decided by a rule. A rule with a yield of zero decides nothing and is decoration;
   naming it in the plan does not make the plan mechanical. Every rule this plan relies on carries
   a number in §9.
3. **A comment is a claim about intent, and deleting one destroys information.** Every mechanical
   signal is a *candidate*, and the verdict names an action per comment rather than authorising a
   sweep.
4. **Writer and reviewer never share a pass.** Review leaves the working tree byte-identical. The
   fix pass runs as a separate invocation and is verified mechanically afterwards.
5. **No unit may make an already-red gate redder.** `vendor check` is red on HEAD with no refresh
   command. Adding drift to it is not a tradeoff, it is a one-way door.

### Decision drivers

- **D1 — The vendor mirror is write-once.** `configs/eslint-config/package.json` and
  `configs/eslint-config/src/configs/docs.ts` are both checksummed in `vendor/.sync-manifest.json`
  (157 files). `vendor check` compares against it and fails on drift. `writeManifest` is exported
  from `apps/infra-kit/cli/src/lib/vendor/manifest.ts` but is called only from tests: no command
  regenerates the manifest. `pnpm run qa` runs `pnpm run vendor:check &&` before everything else, so
  a vendor edit kills the whole root gate. It is already failing on HEAD with `Modified (2):
  configs/eslint-config/package.json, packages/docs-ui/package.json`.
- **D2 — `--quiet` makes `warn` invisible.** Every package's `eslint-check` is
  `pnpm exec eslint --cache --quiet --report-unused-disable-directives ./src`. A rule at `warn` is
  therefore reported to nobody, which is why the repo's dormant rules stay dormant unnoticed.
  Visibility and severity are two separate levers and this plan pulls them in that order.
- **D3 — The obvious mechanical rule enforces nothing.** `jsdoc/informative-docs` at `error` over
  `apps/infra-kit/cli/src` returns zero findings and exits 0, byte-identical to the run without the
  override. Its own documented stemming misses are recorded in
  `vendor/configs/eslint-config/src/configs/docs.ts:28-31`. It also never inspects `//` line
  comments, and every verified `what`-comment in §3's table is a `//` line comment. It is not a
  candidate for the mechanical layer at any severity.
- **D4 — `@wl/max-jsdoc-lines` is live, unenabled, and has real yield.** Installed at `0.1.23`,
  registered via `wl.configs.recommended` at
  `vendor/configs/eslint-config/src/configs/components.ts:8`, off in the resolved config. At its
  defaults it finds an estimated 103 hits in `apps/infra-kit/cli/src`, which against 2,171 JSDoc
  blocks is a 4.7% yield, roughly double the 2.12% the rule was originally calibrated to. The
  estimate is a per-file sum, not a single authoritative run; §9 records why and Unit 2 replaces it
  with a real number. At 103 the cleanup is not a single sitting. Unit 6 is scoped to carry it, and
  the plan accepts that the sprint may span two units rather than pretending it is a week.

### Options

| Option | Shape | Verdict |
|---|---|---|
| **A** | Lint first, lens on top: linter-spec detectors, then `@wl/max-jsdoc-lines` enabled locally at `warn` with `--quiet` dropped, then the skill, then the cleanup sprint that earns `error` | **Chosen** |
| **A-informative** | The same, but with `jsdoc/informative-docs` as the mechanical rule, as v1.1 specified | **Rejected.** D3. Zero findings at `error` over the whole CLI source tree. It would ship a mechanical layer that reports nothing and let the plan claim a lint gate it does not have. |
| **A-vendor** | The same, but the severity change lands in `vendor/configs/eslint-config/src/configs/docs.ts` | **Rejected.** D1. The edit reddens `vendor check`, `qa` dies at step 1, and no command can bless the manifest. It also propagates nowhere: `@wl/eslint-config` is `private: true` at `0.1.0` and is never published, and each consumer keeps its own frozen mirror with its own manifest. |
| **B** | Skill only, no lint change | **Rejected.** Contradicts the user's stated priority, and re-derives on every invocation what a cached rule decides in milliseconds. Retained *inside* A as the degraded path when ESLint cannot run. |
| **C** | Lint only, no skill | **Rejected.** No rule distinguishes "restates the code" from "records a non-obvious constraint in the vocabulary of the code", and `max-jsdoc-lines` measures length, not content: it cannot tell a bloated restatement from a dense rationale. It also cannot express "shorten to five lines and keep the why", which is the action the user wants most often. |

### Review mechanism

Marked **recommended; the user confirms at the approval gate.** The question has been put and no
answer has arrived, so this row is a recommendation and not a settled decision.

The user's original wording was that the skill "under the hood calls OMC ai-slop-cleaner with the
review flag". That is worth honouring where it fits, and it does not fit the review pass. In
`ai-slop-cleaner` 4.15.7, `--review` is defined as a reviewer pass that runs **after cleanup has
been drafted**, over "the cleanup plan, changed files, and regression coverage". Its five checks are
dead code, duplication, needless wrappers, missing tests and behaviour drift. The string "comment"
appears zero times in its `SKILL.md`. Pointed at untouched code, two of its three declared inputs
(a cleanup plan, a set of changed files) would have to be fabricated by the caller.

| Candidate | Shape | Verdict |
|---|---|---|
| (i) `ai-slop-cleaner --review` for the review pass | The user's literal request | **Not recommended for review.** Its contract is post-cleanup review, and the inputs it names do not exist at review time. Using it here means inventing a cleanup plan so the reviewer has something to read, which is a fiction the verdict then inherits. |
| (ii) A direct reviewer prompt carrying the policy text and the mechanical findings | Purpose-built, no fabricated inputs | **Recommended for the review pass (Unit 5a).** Its inputs are exactly what exists: the policy, the mechanical findings, the files. It is not a reimplementation of `ai-slop-cleaner`; it is a different job that skill does not claim to do. |
| (iii) `ai-slop-cleaner` standard mode with a comment-only scope | Its documented step 2 is "write a cleanup plan before code" | **Recommended for the fix pass (Unit 5b) only.** Here the skill is doing what it says it does: cleanup, with an explicit file list and a narrowed category. A comment-only scope is a legitimate narrowing of a cleanup skill, not a redefinition. This is where the user's request is honoured. |

So `ai-slop-cleaner` is under the hood, on the half of the workflow whose contract matches. If the
user prefers (i) for review as well, Unit 5a changes its invocation and its acceptance criteria; the
verdict contract, the filter and `--verify-fix` are unaffected.

### Decision

**Option A, mechanical layer on `@wl/max-jsdoc-lines`, enforcement local to
`apps/infra-kit/cli/eslint.config.js`, review mechanism (ii) and fix mechanism (iii).**

Three layers, one policy file:

1. `packages/linter-spec` gets `comment-restates-code` and `comment-summary-too-long`, with honest
   `existing` coverage. Detectors are specified before rules exist; that is the house pattern.
2. `apps/infra-kit/cli/eslint.config.js` enables `@wl/max-jsdoc-lines` at `warn`, and the CLI
   package's `eslint-check` drops `--quiet` so the findings become visible without gating anything.
   That run is also the first authoritative count. This
   is the first unit that produces real enforcement and it needs no new dependency.
3. The skill's `scripts/lint-comments.mjs` runs the same rule over a scoped file list, plus the
   summary-paragraph rule once it exists, and hands the findings to the reviewer pass.

The name is **`comment-verifier`**, confirmed by the user. Alternatives and reasoning are in the ADR.

---

## 3. The policy

Verbatim, from the user. This text is the body of `references/comment-policy.md` and is quoted
nowhere else in the repo:

> Comment the **why**, never the **what**. If a comment would only restate what the code already
> says (a name, a type, an obvious assignment), delete it — and if code needs a comment to be
> *understood*, prefer renaming/refactoring until it reads on its own. Reserve comments for the
> genuinely non-obvious: external quirks, ordering constraints, fail-safe branches, workarounds.
> Keep them compact. Focus on business-logic descriptions.

Plus the size expectation the user stated separately: a comment should be graspable in **3 to 5
lines**, and the summary paragraph is what that number governs.

The policy is Markdown, not JSON, and the reason is worth stating because it looks inconsistent with
the user's "prioritise JSON validation". An LLM is the only reader of a rules-JSON, and for that
reader JSON is strictly worse prose. JSON belongs where a machine executes it: ESLint rule options,
and the skill's findings output. Both of those are in this plan. The prose stays prose.

Bad/good pairs come from the real corpus, not invented:

| Site | Comment | Verdict |
|---|---|---|
| `apps/infra-kit/cli/src/commands/worktrees-add/worktrees-add.ts:126` | `// Ask for confirmation` above `await confirmOrExit(...)` | Delete. Pure restatement of the callee name. Same at `worktrees-remove.ts:155` and `worktrees-sync.ts:47`. |
| `apps/infra-kit/cli/src/commands/worktrees-list/worktrees-list.ts:61` | `// Log formatted output` | Delete. |
| `apps/infra-kit/cli/src/commands/gh-release-deploy-selected/gh-release-deploy-selected.ts:131` | `// Validate all selected services` above `const invalidServices = selectedServices.filter(` | Delete or fold into the variable name. |
| `apps/infra-kit/cli/src/lib/vendor/manifest.ts:21-24` | the `schemaVersion` block explaining why the field is optional with no default | **Keep.** Records a compatibility constraint that no name can carry. |
| `vendor/configs/eslint-config/src/configs/docs.ts:28-31` | the `informative-docs` stemming note | **Keep.** An empirical finding about an external tool, the archetype of a comment worth writing. |

**Every `what`-comment in that table is a `//` line comment, and no JSDoc rule reads those.** That
asymmetry runs through the whole plan: the mechanical layer catches over-long JSDoc, the reviewer
catches restating line comments, and Unit 8 is the conditional attempt to mechanise the second half.

The corpus is 313 files and 41,991 lines under `apps/infra-kit/cli/src` excluding tests, with 2,171
JSDoc block openers and 2,481 `//` lines. Many of the JSDoc one-liners are already good
why-comments. **The skill must not propose a JSDoc sweep**, and the acceptance criteria below encode
that as a budget rather than a hope.

---

## 4. Pre-mortem

**Scenario 1 — a false positive deletes a load-bearing comment.** The reviewer flags a comment that
looks like a restatement but carries a constraint; the agent deletes it; an adjacent sentence goes
with it. This is the failure that costs the most and is the hardest to notice, because the diff
looks like tidying.
*Mitigation.* A mechanical hit is never an instruction. The verdict classifies every flagged comment
into one of five actions and must justify `delete` by quoting the code line that already says the
same thing. Review mode edits nothing, so a wrong verdict is a paragraph a human rejects. The `keep`
category is explicitly non-empty: external quirks, ordering constraints, fail-safe branches,
workarounds.

**Scenario 2 — `max-jsdoc-lines` floods and gets muted, joining the graveyard.** An estimated 103
hits is not a handful. If the flip to `error` lands before the cleanup, `eslint-check` goes red
across the CLI
package and the cheapest exit is
`vendor/configs/eslint-config/src/configs/temp-disabled.ts`, where `jsdoc/require-jsdoc`,
`require-description`, `require-example` and `@wl/require-jsdoc-example` already sit, enforcing
nothing. That file is proof this failure mode is real here, and the risk is materially higher at
about a hundred findings than it ever was at zero. The correction from 56 to ≈103 doubled the
pressure this scenario describes; it did not change the shape of it.
*Mitigation.* Staging, not gating. Unit 2 lands the rule at `warn` with `--quiet` removed, so the
findings are visible and nothing is red. Unit 6 flips to `error` only after the count reaches zero.
If the
sprint stalls, the rule stays at `warn` and §9 records why, which is a worse outcome than success
but a much better one than a mute.

**Scenario 3 — `max-jsdoc-lines` fires on legitimately long rationale.** A static script counts 124
blocks over 15 total lines while the rule reports about 103. Neither number is wrong: the rule
exempts `@fileoverview`, `@module` and `@packageDocumentation` and the static count does not, so
roughly twenty of the long blocks are file and module headers the rule deliberately lets through.
What remains is about a hundred ordinary blocks, and some of them are the best comments in the repo.
The `informative-docs` stemming note and the `schemaVersion` compatibility note in §3's table are
both long *because* they record something no name can carry. A length rule cannot tell them from
bloat.
*Mitigation.* The `warn` stage exists precisely so these surface before anything is red. The
standing rule for the cleanup sprint is that **a block a human judges load-bearing gets an inline
disable with a reason, not a rewrite.** If more than a quarter of the findings need that treatment,
the default of 15 lines is wrong for this codebase and the option is raised rather than the code
annotated; that rate is Unit 6's gate.

**Scenario 4 — the reviewer pass expands past comments.** Whatever mechanism runs the review, it is
reading code and will notice non-comment problems.
*Mitigation.* Scope is an explicit file list, never a directory. The prompt names comments as the
only in-scope category and instructs that non-comment findings are dropped rather than reported.
Review asserts a byte-identical working tree afterwards, and that assertion is an acceptance
criterion, not a convention.

**Scenario 5 — the fix pass deletes a comment the verdict marked `keep`.** This is Scenario 1 with
the safety rail removed, because now there is a real edit.
*Mitigation.* Three layers. The fix pass acts on the verdict, filtered to `delete`, `shorten` and
`rewrite-as-why`; `keep`, `rename-or-refactor-instead` and anything the verdict never listed are out
of scope. That filter is tested as a pure function. And `--verify-fix` re-reads the working tree
afterwards and fails on any changed hunk that is not a verdict-sanctioned comment, which makes the
property mechanical rather than a matter of the agent's compliance.

**Scenario 6 — the `--rule` override fails on a plugin namespace.** Verified: a tree-wide
`pnpm exec eslint --rule '{"@wl/max-jsdoc-lines":"error"}'` fails outright with
`could not find plugin "@wl"`, and so do some per-directory runs. A skill that shells the same
command across a mixed file list gets an error, not findings.
*Mitigation, two parts.* First, **the failure is glob-shaped, and the workaround is per-file
invocation.** The override applies to every file the run matches, so a single directory glob that
reaches even one file where the plugin is not registered kills the whole run. The same subtrees lint
cleanly one file at a time, which is how §9's per-subtree numbers were obtained and why that total
is a per-file sum. The skill therefore invokes ESLint per file rather than per glob whenever it
carries a plugin-namespaced `--rule`. Second, a **namespace guard** in `scripts/lint-comments.mjs`:
per file group, run `eslint --print-config` on one member and apply a plugin-namespaced rule only
where that plugin appears in the resolved config. Groups where it does not are skipped and
**reported as skipped** in the JSON output. A silent skip that reads as "clean" is the failure that
guard exists to prevent. Neither part is needed once a rule is enabled in a config file rather than
overridden on the command line, which is why Unit 2's run is the authoritative one.

**Scenario 7 — line numbers in the verdict go stale.** The verdict is produced by one invocation and
consumed by another. Any edit between them, or by the fix pass itself as it works through a file,
shifts every line below it. A fix pass keyed on line numbers edits the wrong comment, and the diff
still looks plausible.
*Mitigation.* Every verdict entry carries `textHash`, a hash of the exact comment text as read, and
every entry that adds bytes carries a required `replacement`. The fix pass re-reads the file and
matches on `textHash` before editing; the line number is a hint for humans only. A miss is a
reported failure naming the entry, never a silent skip and never a best-effort match. The fix pass
also snapshots the scoped files before editing, and that snapshot is `--verify-fix`'s baseline: the
working tree normally carries a couple of dozen unrelated dirty files, so diffing against `HEAD`
would conflate this run's edits with everything else in progress.

**Scenario 8 — the fixtures cannot be linted at all.** `.claude/skills/comment-verifier/__fixtures__/`
has no ancestor `eslint.config.*`, and this repo has no root config, so ESLint fails config
resolution before it produces a single finding. Every fixture-based acceptance criterion would fail
for a reason unrelated to what it tests.
*Mitigation.* Unit 4 lints fixtures through
`--stdin --stdin-filename apps/infra-kit/cli/src/<probe>.ts`, so the fixture content is linted under
the real CLI package config rather than a synthetic one written for the test. The alternative,
shipping an `eslint.config.js` inside the skill directory, was rejected: it would lint fixtures
under a config that no real file uses, so a passing fixture would prove nothing about real code.

---

## 5. Units of work

Each unit is independently shippable and independently revertible. Unit 2 is deliberately early: it
is the first unit that produces enforcement a human can see, and it needs no new dependency, no
publish and no vendor edit.

### Unit 1 — Register the two detectors in `packages/linter-spec`

**Files.** `packages/linter-spec/src/detector-ids.ts`,
`packages/linter-spec/src/detectors/ai-agentic.ts`.

**Steps.**

1. Add `'comment-restates-code'` and `'comment-summary-too-long'` to `DETECTOR_IDS`, in the
   `aiAgentic` block, next to the existing `comment-staleness`.
2. Author both with `scope: 'file'`, which forces the `eslint` seam to be present, per the
   discriminated union at `packages/linter-spec/src/types.ts:139`.
3. `comment-restates-code`: `defaultSeverity: Severity.warn`, `appliesTo: 'any'`,
   `status: 'proposed'` until Unit 8 pins the threshold, options `minOverlapRatio` (number, default
   to be set by Unit 3) and `checkLineComments` (boolean, default `true`),
   `eslint.messageId: 'commentRestatesCode'`, `fixable: null`. `existing`: `status: 'none'`,
   `plugin: 'jsdoc'`, `rule: 'informative-docs'`, `enabledInRepo: false`, with the note recording the
   measured truth — the rule is installed and reachable, yields **zero** findings at `error` over
   `apps/infra-kit/cli/src`, and does not inspect `//` line comments at all. `status: 'none'` rather
   than `'partial'`: a rule that finds nothing covers nothing, and the field documents what actually
   runs.
4. `comment-summary-too-long`: `defaultSeverity: Severity.warn`, `status: 'stable'`, option
   `maxSummaryLines` (number, default `5`), `eslint.messageId: 'jsdocSummaryTooLong'`,
   `fixable: null`. `existing`: `status: 'none'` (**corrected at implementation, 2026-09-05**: the
   `ExistingCoverage` contract and the catalog test require `'none'` whenever `enabledInRepo: false`;
   v1.3.1 said `'partial'`), `plugin: 'slip-stream-kit'`,
   `rule: 'max-jsdoc-lines'`, `enabledInRepo: false`, with the note recording that the rule caps the
   **whole block** at 15 lines while this detector caps the **summary paragraph** at 5, that the two
   compose rather than overlap, and that `max-jsdoc-lines` is **installed at `0.1.23` and reachable
   today**, registered through `wl.configs.recommended` at
   `vendor/configs/eslint-config/src/configs/components.ts:8` and simply not enabled by any config.
   Do not write that a version pin excludes it; that was v1.1's error.
5. Examples for both drawn from §3, using the real corpus sites.

**Acceptance.**

- `pnpm --filter @pkg/linter-spec test` passes, including the bijection sanity test between
  `DETECTOR_IDS` and the live catalog.
- `pnpm --filter @pkg/linter-spec ts-check` passes, which proves the `scope: 'file'` seam is
  well-formed.
- The catalog holds exactly **56** detector ids, two more than the current 54. The package is ESM,
  so probe it from a test or `node --input-type=module`, never `require`.

### Unit 2 — Turn on the mechanical layer: `max-jsdoc-lines` at `warn`, `--quiet` dropped

**Files.** `apps/infra-kit/cli/eslint.config.js`, `apps/infra-kit/cli/package.json`.

This is the unit that gives the user enforcement this week. Nothing goes red.

**Steps.**

1. Append a local config object to the array returned by the promise in
   `apps/infra-kit/cli/eslint.config.js`, alongside `noTuiOnMachinePaths` and `noRawStdinReaders`:
   `{ files: ['src/**/*.{ts,tsx}'], rules: { '@wl/max-jsdoc-lines': 'warn' } }`.
2. No plugin registration and no dependency change. The plugin is already registered for these files
   through `wl.configs.recommended`; `--print-config` on a CLI source file lists
   `@wl/require-jsdoc-example`, `@wl/max-jsx-return-size` and `@wl/max-components-per-file`, all off.
   Enabling a fourth `@wl/` rule by name is a severity change and nothing more.
3. Read the warning already in that file about flat-config replacement semantics: two matching
   objects that both set the same rule replace each other, last match wins, whole option object.
   This object sets a rule no other object sets, so it composes. Say that in its header comment,
   because the file's own history records a boundary rule silently deleted by exactly this
   mechanism.
4. Remove `--quiet` from `eslint-check` in `apps/infra-kit/cli/package.json`. Leave `--cache` and
   `--report-unused-disable-directives`. Warnings do not affect the exit code, so the script still
   passes; they simply become visible. Leave `eslint-fix` alone.
5. Expect exactly **11 other warnings** to surface, already measured: `jsdoc/multiline-blocks` 3,
   `react/set-state-in-effect` 3, `sonarjs/todo-tag` 2, `regexp/no-useless-flag` 2,
   `react/no-array-index-key` 1. This is a check with a known answer, not an open question. Eleven
   lines will not bury anything, so no follow-up and no restoring of `--quiet` is needed. A
   materially different set means something else changed in the resolved config and is worth
   understanding before the unit lands.
6. Note for the reader, not a step: root `pnpm run qa` runs turbo with `--output-logs=errors-only`,
   so a passing task's warnings may not appear there. These warnings are visible in the
   package-level run, which is where the cleanup sprint works.

**Acceptance.**

This run is **authoritative**, not confirmatory. §9's ≈103 is a per-file sum taken with `--rule`
overrides, which fail on some directory globs (Scenario 6). Unit 2 enables the rule through
`eslint.config.js` instead, so the namespace problem does not arise and one whole-package run under
the real config produces one real number.

- `pnpm --filter infra-kit run eslint-check` exits **0** and prints `@wl/max-jsdoc-lines` warnings.
  Both halves matter: a non-zero exit means the severity is wrong, and zero output means the rule or
  the `--quiet` removal did not take.
- **Record the printed `@wl/max-jsdoc-lines` count into §9 as the corpus total, replacing the ≈103
  estimate in the same commit.** Every downstream number, including Unit 6's budget, derives from
  this figure and not from the estimate.
- The 11 other warnings from step 5 appear, in those proportions.
- `pnpm --filter infra-kit run qa` exits 0.
- `git diff -- vendor/` is empty.

### Unit 3 — Residual measurements

**Files.** No repo files. A scratch script under the session scratchpad; the numbers land in §9.

§9 already carries the measurements that gate Units 2 and 6. Two numbers are still missing, and both
gate Unit 8.

**Steps.**

1. **Name the stemmer before measuring.** The crude run in §9 used prefix matching and found one
   candidate corpus-wide, and it did **not** fire on `// Ask for confirmation` above `confirmOrExit`,
   because "confirmation" does not prefix-match "confirm". That number measures the tokenizer, not
   the codebase. Vendor a small Porter stemmer, roughly 100 lines, into the measurement script and
   later into the rule folder. The repo does not add dependencies unless asked, so `natural` and
   `stemmer` from npm are out; a vendored implementation is the house-compatible choice.
2. Re-run the line-comment overlap count with the real stemmer over `apps/infra-kit/cli/src`,
   sweeping `minOverlapRatio` across 0.6, 0.7, 0.8 and 0.9. Record candidates per ratio.
3. Hand-classify a random sample of 30 candidates at the best ratio into true restatement versus
   false positive. This is Unit 8's precision figure.
4. Confirm the ground truth: the three `// Ask for confirmation` sites, `// Log formatted output`
   and `// Validate all selected services` must all appear at the chosen ratio. If they do not, the
   heuristic is wrong and Unit 8 does not proceed on a threshold tweak.
5. Record the summary-paragraph distribution already measured (51 blocks over 5 lines, of 2,171) and
   its script, so Unit 7's default of 5 has a number behind it.

**Acceptance.**

- The sweep runs and reports one line per ratio:
  `node <scratch>/measure-overlap.mjs --root apps/infra-kit/cli/src --ratios 0.6,0.7,0.8,0.9 --format json`
- Ground-truth recall is checked by name, not by eyeball. The candidate list, filtered to the five
  §3 sites, has five entries:
  `node <scratch>/measure-overlap.mjs --root apps/infra-kit/cli/src --ratio <chosen> --format json | grep -cE 'worktrees-(add|remove|sync)\.ts|worktrees-list\.ts|gh-release-deploy-selected\.ts'`
  A count below 5 fails the unit, and Unit 8 does not proceed on a threshold tweak.
- §9 gains a row per ratio, the sampled precision, and the vendored stemmer's provenance.
- The numbers resolve Unit 8's gate without another round of review.

### Unit 4 — Skill scaffold and the mechanical pass

**Files.**

- `.claude/skills/comment-verifier/SKILL.md`
- `.claude/skills/comment-verifier/references/comment-policy.md`
- `.claude/skills/comment-verifier/scripts/lint-comments.mjs`
- `.claude/skills/comment-verifier/__fixtures__/restating.ts`
- `.claude/skills/comment-verifier/__fixtures__/clean.ts`
- `.claude/skills/comment-verifier/__tests__/frontmatter.test.mjs`
- `.claude/skills/comment-verifier/__tests__/lint-comments.test.mjs`

**Steps.**

1. **Frontmatter**, copying `full-cycle`'s style exactly. The OMC parser is a line scanner, not a
   YAML parser: a block list parses to empty and a folded `>-` scalar parses to the literal marker,
   both silently (`full-cycle/SKILL.md:170-171` records this). So lists are inline flow style
   (`aliases: [comment-verify]`) and `description` is a single-line plain scalar.
   `description` must carry the literal trigger phrases a user would type: "review comments",
   "comment policy", "why not what", and the Ukrainian "коментарі". Avoid the word "clean", so the
   description does not compete with `ai-slop-cleaner`'s `deslop` trigger or with `/code-review`.
   Body under 5,000 words, policy pushed into `references/` per `skill-creator`'s
   progressive-disclosure guidance.
2. `references/comment-policy.md` carries the §3 text verbatim, the five actions, and the corpus
   bad/good pairs.
3. `scripts/lint-comments.mjs`:
   - **Scope.** Explicit file arguments if given; otherwise `git diff --name-only` filtered to `.ts`
     and `.tsx` and excluding `__tests__`. Never the whole repo by default.
   - **Grouping.** Group each file under its nearest ancestor directory containing an
     `eslint.config.*`, because each package resolves its own config and this repo has no root one.
   - **Namespace guard (Scenario 6).** Per group, run `eslint --print-config` on one member. Apply a
     plugin-namespaced rule only if that plugin appears in the resolved config. Otherwise skip the
     group and record it under `skipped` with the reason. Never emit a skipped group as clean.
   - **Run.** Per surviving group, from the group root:
     `pnpm exec eslint --no-cache --format json --rule '{"@wl/max-jsdoc-lines":"error"}'` over the
     group's relative paths. `--cache` and `--quiet` are deliberately absent; the first would serve
     stale results across a severity override, the second would discard the output.
   - **Exit codes.** ESLint exits 1 when errors exist. Treat exit 1 with parsable JSON on stdout as
     success; only non-empty stderr or unparsable stdout is a failure. Capture the code directly,
     never through a pipeline that can mask it.
   - **Output.** One JSON object:
     `{ scope: string[], skipped: [{ group, reason }], findings: [{ file, line, column, ruleId, message, text, textHash }], counts: { files, findings, skipped }, degraded: boolean }`.
     `degraded: true` when ESLint could not run at all, so the reviewer falls back to reading files
     rather than reporting a clean bill.
   - **`textHash`, pinned.** It is what the fix pass matches on (Scenario 7), it is computed in one
     place and compared in another, so the definition is part of the contract and **must be written
     down before Unit 4 is implemented**, not settled by whichever side is coded first. It is
     **sha256 of the normalized comment text, first 12 hex characters**. Twelve hex is 48 bits,
     which is far beyond collision range for the few hundred comments a scoped run ever holds, and
     it stays readable in a JSON verdict a human skims. Normalization, applied identically by this
     script and by the verdict producer: CRLF folded to LF, trailing whitespace stripped per line,
     no other change. **Comment markers are excluded** — `//`, `/**`, the leading `*` of a
     continuation line and the closing `*/` are stripped before hashing, along with the single
     space that conventionally follows them. The reason is that `shorten` and `rewrite-as-why`
     routinely convert a block comment to a line comment or the reverse, and a hash that includes
     the markers would treat identical prose in a different wrapper as a different comment, which
     is exactly the case the verifier most needs to recognise.
   - **`--verify-fix <verdict.json> --baseline <dir>` mode.** Specified here, used by Unit 5b. It
     diffs the scoped files against a **pre-fix snapshot the fix pass takes before editing**, never
     against `HEAD`: the working tree carries roughly two dozen unrelated dirty files, so a
     `HEAD` diff conflates this run's edits with everything else in progress and the check would be
     meaningless. Then it verifies both directions. **Removed text** must hash to a `textHash` in
     the verdict with action `delete`, `shorten` or `rewrite-as-why`. **Added text** must hash to the
     `replacement` of the entry that removed it. Any failure in either direction fails the check and
     is named. Checking only removals would let the pass delete a sanctioned comment and write
     anything at all in its place.
   - **It compares regions, not raw diff hunks.** Two ordinary cases break a hunk-by-hunk reading,
     and both are expected rather than exceptional. A `shorten` whose replacement is a **subset of
     the original lines** produces a removal-only diff with no added lines at all, so a verifier
     looking for a matching addition would fail a perfectly correct fix. And a `delete` commonly
     takes **exactly one adjacent blank line** with it, since leaving the blank behind is what makes
     a deletion look sloppy. So the verifier resolves each verdict entry to its before-region in the
     snapshot and its after-region in the working tree, hashes those two regions, and permits at
     most one blank line of difference at a deleted region's boundary. Anything outside a resolved
     region is an unsanctioned change and fails.
4. **Fixtures are linted through stdin (Scenario 8).** `restating.ts` and `clean.ts` live in
   `__fixtures__/`, which has no ancestor config, so the script lints fixture content with
   `--stdin --stdin-filename apps/infra-kit/cli/src/<probe>.ts`, resolving the real CLI config.
   `restating.ts` carries an 18-line JSDoc block, a restating line comment modelled on
   `// Ask for confirmation`, and a seven-line summary paragraph. `clean.ts` carries only compact
   why-comments.

**Acceptance.**

- `node --test .claude/skills/comment-verifier/__tests__/` passes. Root `vitest.config.ts` scopes
  projects to `apps/*/*`, `packages/*`, `vendor/packages/*` and `vendor/configs/*`, so skill tests
  are **not** part of `pnpm run qa`; this command is the whole gate, exactly as it is for
  `full-cycle`'s two `node:test` files. Wiring them into qa is a follow-up in §7.
- The frontmatter test asserts the exact key set, that `description` is a single-line plain scalar,
  that every list value is inline flow style, and that `description` contains all four trigger
  phrases including "коментарі".
- `node scripts/lint-comments.mjs __fixtures__/restating.ts` reports `counts.findings >= 1` with a
  `@wl/max-jsdoc-lines` finding and a populated `textHash`; the same on `clean.ts` reports
  `counts.findings === 0`, `counts.skipped === 0` and `degraded: false`.
- Pointed at a file group where `@wl` is not registered, the script reports it under `skipped` with
  a reason and a non-zero `counts.skipped`, and does not report it as clean.
- Run against the three real `// Ask for confirmation` sites, the script exits without error and
  reports zero findings for them. That is the expected result and it is the whole argument for
  Units 5a and 8: no JSDoc rule sees a line comment.

### Unit 5a — The review pass

**Files.** `.claude/skills/comment-verifier/SKILL.md` (the workflow section),
`.claude/skills/comment-verifier/references/review-contract.md`.

Mechanism (ii) per §2, pending the user's confirmation at the approval gate.

**Steps.**

1. Workflow: resolve scope, run Unit 4's script, then run a direct reviewer prompt whose inputs are
   the policy text, the mechanical findings, and the scoped files. No fabricated cleanup plan and no
   fabricated changed-file set, which is what mechanism (i) would require.
2. Verdict contract, in `references/review-contract.md`: every flagged comment gets exactly one of
   `delete`, `shorten`, `rewrite-as-why`, `rename-or-refactor-instead`, `keep`. A `delete` quotes the
   code line that already carries the information. A `keep` names which reserved category applies:
   external quirk, ordering constraint, fail-safe branch, workaround.
3. Output: a short human-readable report, then a fenced JSON block of
   `{ file, line, textHash, action, reason, replacement }` per comment. `textHash` is copied from
   the mechanical findings, or computed from the file for comments the reviewer raised itself.
   **`replacement` is required and non-empty for `shorten` and `rewrite-as-why`**, and carries the
   exact replacement text, not a description of it. Those two actions are the only ones that put new
   bytes in the file, and `--verify-fix` can only check new bytes it was told to expect. A `shorten`
   verdict that says "cut to four lines" instead of supplying the four lines is unverifiable, so the
   contract does not permit it. `replacement` is absent for `delete`, `keep` and
   `rename-or-refactor-instead`, none of which add anything.
4. Scope constraint in the prompt: comments are the only in-scope category, and non-comment findings
   are dropped rather than reported (Scenario 4).
5. The review pass never edits. `--fix` is Unit 5b, a separate invocation.

**Acceptance.**

*Automated.*

- `git status --porcelain` is byte-identical before and after a review-mode run.
- A schema test over a recorded verdict fixture: every entry carries one of the five actions and a
  non-empty `textHash`; every `shorten` and `rewrite-as-why` entry carries a non-empty `replacement`;
  no `delete`, `keep` or `rename-or-refactor-instead` entry carries one. A verdict violating either
  half is rejected before the fix pass ever sees it.

*Manual end-to-end, because the output is a model's.*

- Invoked on a scoped file list, the report contains the JSON block with at least one entry per
  mechanical finding.
- On a scoped list containing a file with obvious non-comment slop, such as an unused local, the
  verdict contains no finding about it.

### Unit 5b — The fix pass

**Files.** `.claude/skills/comment-verifier/SKILL.md` (the `--fix` section),
`.claude/skills/comment-verifier/references/review-contract.md` (the fix-input contract),
`.claude/skills/comment-verifier/scripts/lint-comments.mjs` (the `--verify-fix` mode),
`.claude/skills/comment-verifier/__fixtures__/restating-fix.ts`,
`.claude/skills/comment-verifier/__tests__/fix-pass.test.mjs`.

In v1 by the user's decision. Mechanism (iii): this is where `ai-slop-cleaner` runs, and where the
user's "under the hood calls OMC ai-slop-cleaner" is honoured.

**Steps.**

1. `/comment-verifier --fix <files>` is a **separate invocation** and never runs in the same pass as
   the review. That is Principle 4, and it is why these are two units rather than one flag.
2. Its input is the JSON verdict from Unit 5a, passed in or regenerated by running the review as its
   own invocation first. A `--fix` with no verdict in hand is refused with a line telling the user to
   run the review. It does not improvise a verdict while holding write access.
3. It filters the verdict to `delete`, `shorten` and `rewrite-as-why`. `keep`,
   `rename-or-refactor-instead` and anything the verdict never listed are out of scope.
   `rename-or-refactor-instead` is excluded because it is a code change; the fix pass reports it as a
   leftover for a human.
4. The edits are delegated to `Skill("oh-my-claudecode:ai-slop-cleaner")` in standard mode, scoped to
   the same explicit file list, with the filtered verdict as the cleanup plan. **Say this plainly:
   that skill has no documented input for an externally supplied cleanup plan.** Its documented step
   2 is to write one itself. The filtered verdict is injected as prompt context and there is no
   contractual guarantee it is followed. The real safety net is not the prompt; it is `--verify-fix`
   plus the re-run mechanical pass plus the package gate below.
5. **Before any edit, snapshot the scoped files** to a scratch directory. That snapshot, not `HEAD`,
   is `--verify-fix`'s baseline. The working tree routinely carries a couple of dozen unrelated
   dirty files, so a `HEAD` diff would mix this run's edits with everything else in flight and the
   verification would prove nothing.
6. Each edit matches its target by `textHash`, re-read from the file at edit time (Scenario 7). A
   miss is a reported failure naming the entry. Never a silent skip, never a nearest-match.
7. After editing, run
   `scripts/lint-comments.mjs --verify-fix <verdict.json> --baseline <snapshot>`, then re-run the
   mechanical pass over the same files, then the owning package's gate, which for
   `apps/infra-kit/cli` is `pnpm --filter infra-kit run qa`. Report all three, capturing exit codes
   directly rather than through a pipeline.
8. Print a one-line summary: comments removed, shortened, rewritten, left for a human.

**Acceptance.**

*Automated, and these are the safety properties.*

- `__tests__/fix-pass.test.mjs` drives the verdict filter as a pure function: a verdict containing
  all five actions yields only the `delete`, `shorten` and `rewrite-as-why` entries; a verdict of
  `keep` entries alone yields an empty set.
- `--verify-fix` on a tree where a non-verdict comment was removed **fails**, naming the hunk. This
  is Scenario 5's mechanical guard and it must be tested by constructing that tree and its baseline
  snapshot directly, without an agent in the loop.
- `--verify-fix` on a tree where a sanctioned comment was removed but the added text does **not**
  match the entry's `replacement` **fails**. This is the added-lines half of the check, and without
  a test it is the half that quietly does not exist.
- `--verify-fix` on a tree where only verdict-sanctioned comments changed, with added text matching
  `replacement` byte for byte, passes.
- With unrelated files dirty in the working tree, `--verify-fix` still passes on a correct fix,
  which proves the baseline is the snapshot and not `HEAD`.
- A `textHash` miss produces a non-zero exit and names the entry.

*Manual end-to-end, because the edits are a model's.*

- `__fixtures__/restating-fix.ts` carries three `// Ask for confirmation`-style comments, one
  `keep`-worthy workaround comment, and otherwise valid code. Review it, then `--fix` as a second
  call: `git diff --numstat` reads `0 3`, the workaround comment survives verbatim, `--verify-fix`
  passes, and the reported package-gate exit code is 0.
- `--fix` on `__fixtures__/clean.ts` edits nothing and prints an explicit "nothing to fix" line.
- A `keep`-only verdict produces no edit and the same line.

### Unit 6 — Cleanup sprint, then flip `max-jsdoc-lines` to `error`

**Files.** `apps/infra-kit/cli/src/**` (the cleanup), `apps/infra-kit/cli/eslint.config.js` (the
severity flip).

**Gate, derived from this rule's own measured yield rather than inherited from a different rule.**
The flip requires the `@wl/max-jsdoc-lines` count to reach **0** in `apps/infra-kit/cli`, since at
`error` any remaining hit fails the build. The sprint's own budget is the ceiling that decides
whether the threshold is right: **at most 25% of the authoritative Unit 2 count may be resolved by
an inline disable with a reason.** The budget is a rate, not a fixed number, and **it is recomputed
against the count Unit 2 records, never against the ≈103 estimate.** The estimate is a per-file sum
taken with `--rule` overrides and Unit 2 supersedes it; carrying a stale absolute number forward is
exactly the arithmetic error this revision exists to fix. At ≈103 the budget would be about 26
disables, and that figure is an illustration, not the gate. Above a quarter, the rule's 15-line
default is wrong for this codebase and the correct response is to raise the option, not to annotate
a quarter of the corpus. If the budget is exceeded, the rule stays at `warn`, §9 records the count
and the reason, and the option value is revisited.

**Steps.**

1. Work the findings recorded by Unit 2. The estimate that sized this unit was ≈103, distributed as
   `src/commands` 17 across 13 files, `src/lib` 34, `src/dev` 32, `src/tui` 9, `src/entry` 5,
   `src/integrations` 5, and 1 across `src/mcp`, `lib/node-warnings` and `lib/vite`. The `src/dev`
   concentration is worth planning around: a third of the work sits in one subtree.
2. **The cleanup owner is a human, by hand, optionally guided by the review pass's `shorten`
   action.** It is explicitly **not** the `--fix` pass. `max-jsdoc-lines` is deliberately not
   fixable, shortening a block without losing its content is judgment, and Scenario 3 is exactly the
   case where a mechanical shortener destroys the best comments in the repo.
3. Blocks that are long because they are load-bearing get
   `// eslint-disable-next-line @wl/max-jsdoc-lines -- <reason>`, with a real reason. Count them
   against the budget.
4. When the count is 0, change `'warn'` to `'error'` in the Unit 2 config object.

**Acceptance.**

- `pnpm --filter infra-kit run eslint-check` reports zero `@wl/max-jsdoc-lines` findings before the
  flip.
- After the flip, `pnpm --filter infra-kit run eslint-check` and `pnpm --filter infra-kit run qa`
  both exit 0.
- A deliberately 20-line JSDoc block added to any `src` file makes `eslint-check` exit non-zero.
  Revert it.
- The inline-disable count is at or below 25% of Unit 2's recorded count and each carries a reason.
  §9 records the final count and the rate.

### Unit 7 — `max-jsdoc-summary-lines` in the workspace plugin

**Files.** `apps/infra-kit/eslint-plugin/src/rules/max-jsdoc-summary-lines/{max-jsdoc-summary-lines.ts,index.ts,__tests__/max-jsdoc-summary-lines.test.ts}`,
`apps/infra-kit/eslint-plugin/src/rules/index.ts`, `apps/infra-kit/eslint-plugin/README.md`,
`packages/linter-spec/src/detectors/ai-agentic.ts` (flip `comment-summary-too-long` to
`existing.status: 'covered'`).

This is the rule that encodes the user's actual number. `max-jsdoc-lines` caps the whole block at
15; the user asked for a summary graspable in 3 to 5 lines. 51 of 2,171 blocks exceed 5 summary
lines, so the yield is known before the rule is written.

**Steps.**

1. Follow the shape of `max-jsdoc-lines`: a comment-driven walk over `sourceCode.getAllComments()`,
   the `isJsdocBlock` helper, deliberately not fixable.
2. Measure the summary paragraph only: from the block's first prose line to the first blank line or
   the first `@tag`, whichever comes first. Default `maxSummaryLines: 5`. Exempt the same tags
   `max-jsdoc-lines` exempts: `fileoverview`, `module`, `packageDocumentation`.
3. The two rules compose rather than overlap: 5 for the summary, 15 for the block. Say so in both
   READMEs so nobody later unifies them.
4. Message names the offender and the expected value: file, line, actual summary length, cap. No
   `suggest`; it is invisible to a text-reading agent.
5. `meta.docs.url` points at the README anchor.

**Acceptance.**

- `pnpm --filter @slip-stream-kit/eslint-plugin test` passes with RuleTester cases for: a 5-line
  summary (valid), a 6-line summary (invalid), a 6-line summary under `@fileoverview` (valid), a
  3-line summary followed by twenty `@param` lines (valid, only the summary is capped), and a block
  with no blank line and no tags (the whole block is the summary).
- `pnpm --filter @slip-stream-kit/eslint-plugin run qa` exits 0, which includes the sonarjs
  cognitive-complexity ceiling of 15 and the tsc pass vitest alone does not give.
- Run over `apps/infra-kit/cli/src`, the rule reports a count within 10% of the 51 blocks §9 records
  from the static script. A large divergence means the paragraph boundary is defined differently in
  the rule than in the script, and one of them is wrong.
- The rule is **not yet wired into this repo's lint.** Wiring is Unit 9.

### Unit 8 — `no-restating-comment` in the workspace plugin

**Conditional. Implement in v1 only if Unit 3, using the vendored Porter stemmer, finds at least 25
line-comment restatement candidates in `apps/infra-kit/cli/src` at a ratio whose sampled precision is
at least 0.8, and only if all five §3 ground-truth sites appear at that ratio. Otherwise this unit
moves to §7 follow-ups and `comment-restates-code` stays `status: 'proposed'`.**

The concern is worth stating rather than waving through, because the unit reads like the obvious
completion of the set. This is a stemming and token-overlap heuristic, and the crude version already
run found **one** candidate corpus-wide while missing `// Ask for confirmation`, because
"confirmation" does not prefix-match "confirm". That number is evidence about the tokenizer, not
about the codebase, which is exactly why Unit 3 names the stemmer before it measures again. But it
is also a warning: the mechanism is sensitive enough to its own implementation details that a
threshold picked against a handful of samples cannot be told apart from one overfitted to them.
`max-jsdoc-lines` needed 6,108 blocks to land on 2.12%.

The cost of being wrong is asymmetric in the direction that hurts. Line comments are where this
codebase keeps its genuine why-comments, including both `keep` rows in §3, so a false positive is a
proposal to delete a load-bearing note; a false negative merely leaves work for the review pass that
was going to read the file anyway. If the count comes back high, the corpus exists and the rule is
calibratable. If it comes back at one again, the review pass was always the right answer and this
unit should not ship.

**Files.** As Unit 7, under `src/rules/no-restating-comment/`, plus the vendored stemmer and the
`comment-restates-code` flip from `proposed` to `stable`.

**Steps.**

1. Vendor the Porter stemmer from Unit 3 into the rule folder. No new npm dependency.
2. For each `//` line comment: tokenise, drop stopwords, stem, and compare against the identifiers on
   the next statement split on camelCase. Flag when the covered-token ratio meets `minOverlapRatio`,
   whose default is Unit 3's chosen ratio, not a guess.
3. Record the chosen ratio, its yield and the corpus size in the rule's header comment, with the
   command, the way `max-jsdoc-lines` records its calibration.
4. Message quotes the offending comment text and names the identifier that already carries it. That
   message is the entire interface for an agent reading the output.
5. Not fixable. Deleting a comment is never a mechanical decision.

**Acceptance.**

- RuleTester flags `// Ask for confirmation` above `await confirmOrExit(...)` and does **not** flag
  the `schemaVersion` comment at `apps/infra-kit/cli/src/lib/vendor/manifest.ts:21`, both as literal
  fixtures.
- Run over `apps/infra-kit/cli/src`, the count matches Unit 3's measurement at the same ratio within
  10%.
- `pnpm --filter @slip-stream-kit/eslint-plugin run qa` exits 0.

### Unit 9 — Wire the new plugin rules into this repo

**Files.** `apps/infra-kit/cli/package.json`, `apps/infra-kit/cli/eslint.config.js`.

**Scope note.** This unit exists only for rules that do **not** ship in the installed `0.1.23`,
which means Units 7 and 8. `@wl/max-jsdoc-lines` needs none of this; it was enabled by name in
Unit 2. v1.1 claimed the `^0.1.23` pin excluded it, and that was wrong: the published 0.1.23 tarball
contains `dist/rules/max-jsdoc-lines/`, the lockfile resolves 0.1.23, and the rule is registered for
CLI source files and merely off.

**Blocked path, recorded so it is not proposed again.** Bumping the plugin range and adding the rules
in `vendor/configs/eslint-config/` is the natural move and it is blocked: both
`configs/eslint-config/package.json` and `configs/eslint-config/src/configs/docs.ts` are checksum
entries in `vendor/.sync-manifest.json`, `vendor check` fails on drift, `qa` runs it first, no
command regenerates the manifest, and the check already exits 1 on HEAD.

**Viable path.** Add `@slip-stream-kit/eslint-plugin: workspace:*` to `apps/infra-kit/cli`'s
`devDependencies`, register it in that package's own `eslint.config.js` under a namespace distinct
from the base config's `@wl` (use `@ik`), and enable `@ik/max-jsdoc-summary-lines` and, if it ships,
`@ik/no-restating-comment`. This links the workspace plugin at `0.4.0`, so rule edits in
`apps/infra-kit/eslint-plugin` take effect here immediately, which they do not today.

**Steps.**

1. Add the devDependency, then run a root `pnpm install`. A new workspace link needs it.
2. Register the plugin under `@ik` and enable the new rules in the Unit 2 config object, at `warn`
   first, following the same staging Unit 2 and Unit 6 use.
3. Confirm `@ik` does not collide with `@wl` in the resolved config, via `--print-config`.
4. `infra-kit` is published. `workspace:*` in `devDependencies` is rewritten to a concrete version at
   publish, producing a devDep reference to a plugin version that may not be on npm. devDependencies
   are not installed by consumers, so this is cosmetic, but shasum `apps/infra-kit/cli/package.json`
   before and after any full `pnpm run qa` and diff before committing: a full qa run rewrites
   manifests, and `catalog:` leaking into published deps is a recurring bug here.

**Acceptance.**

- `pnpm --filter infra-kit run eslint-check` exits 0 with the new rules enabled at `warn` and prints
  their findings.
- Editing a message string in `apps/infra-kit/eslint-plugin/src/rules/max-jsdoc-summary-lines/` and
  rerunning `eslint-check` shows the new string. That is the proof the workspace link is live, and
  it is the one thing the vendor path cannot deliver.
- `git diff -- vendor/` is empty and `infra-kit vendor check` output is unchanged from its pre-unit
  state: the same two modified files, no more.

---

## 6. Test plan

**Automated unit.**

- `packages/linter-spec/src/__tests__/catalog.test.ts` — the existing bijection test picks up both
  new ids with no edit. If it needs a count bump, that is the signal it was checking the count rather
  than the bijection, and it should be fixed to check the bijection.
- RuleTester suites for both new rules, with the valid cases in Units 7 and 8. The false-positive
  cases matter more than the true positives and must be literal corpus text, not paraphrase.
- `__tests__/frontmatter.test.mjs` — `node:test`, no OMC install required, modelled on
  `full-cycle`'s. Asserts the key set, a single-line plain-scalar `description`, inline flow lists,
  and the four trigger phrases.
- `__tests__/fix-pass.test.mjs` — the verdict filter as a pure function, no ESLint and no agent.
- `--verify-fix` tests — a constructed working tree with an unsanctioned comment removal must fail;
  a sanctioned one must pass; a `textHash` miss must exit non-zero naming the entry. These are the
  Scenario 5 guards and they are the reason the safety property does not depend on the agent.

**Automated integration.**

- `__tests__/lint-comments.test.mjs` runs the script against both fixtures through the stdin path and
  asserts the JSON shape, the finding count, `counts.skipped`, and `degraded: false`.
- Namespace-guard test: point the script at a file group where `@wl` is not registered and assert it
  lands in `skipped` with a reason, not in a clean report.
- Degraded-path test: run with a PATH that cannot resolve ESLint, assert `degraded: true` and a
  non-throwing exit. A silent clean report on a broken toolchain is the worst possible output.
- Run against the three real `// Ask for confirmation` sites and assert zero findings. This pins the
  documented gap, and after Unit 8 it becomes the assertion that the gap closed.

**Manual end-to-end.** These depend on a model's output and are checked by a human, not by CI.

- Review over a scoped diff: the report contains the JSON block, every entry carries one of the five
  actions and a `textHash`, and `git status --porcelain` is unchanged.
- Empty scope: reports "nothing in scope" rather than falling back to the whole repository.
- Fix over `restating-fix.ts` as a second invocation: `git diff --numstat` reads `0 3`, the
  `keep`-marked comment survives, `--verify-fix` passes, the package gate exits 0.
- Fix over a clean fixture and over a `keep`-only verdict: no edit, explicit "nothing to fix".

**Observability.**

- Every number lives in §9 with the command that produced it, so a later reader can re-run rather
  than trust.
- The skill's JSON output is the false-positive channel: a disagreement has a file, a hash and an
  action to point at. Recurring disagreements go into the policy file's bad/good table, which is the
  only place the policy is edited.

---

## 7. Non-goals and follow-ups

**Non-goals for v1.**

- Changing anything under `vendor/`. See Unit 9's blocked path.
- Propagating the policy or the rules to hulyo and travelist. Those repos hold their own frozen
  mirrors behind their own checksum guards, and `@wl/eslint-config` is `private: true` and never
  published, so there is no channel short of hand-copying into a second manifest.
- Rewriting or forking `ai-slop-cleaner`. Where its contract fits, it is used; where it does not,
  the plan uses a purpose-built prompt rather than bending the skill.
- A repo-wide comment sweep. Scope is a diff or an explicit file list, always.
- Enforcing comment policy on tests, stories or declaration files. `GLOB_TS_DOC_EXCLUDE` already
  excludes them from the JSDoc layer and the skill matches that boundary.

**Follow-ups.**

- Enable `@wl/max-jsdoc-lines` in the other three packages with their own config:
  `packages/linter-spec`, `apps/infra-kit/config` and `apps/infra-kit/eslint-plugin`. Each needs the
  same three-line object plus its own cleanup. The CLI goes first by the user's decision.
- `no-restating-comment` — **Unit 8's gate was NOT met (2026-09-05, §9): recall 1/5 at 0.6, 4/5 at 0.5, `worktrees-list.ts:61` unreachable, 21 of 26 candidates one banner. Moved here.** The detector stays `proposed`
  until it is, which is what `proposed` is for.
- Fold `references/comment-policy.md` into the per-package `CLAUDE.md` managed-block bodies once
  `docs/agent-guidance-blocks-plan.md` lands. That plan is pending approval and unimplemented;
  nothing here depends on it.
- Give `vendor/.sync-manifest.json` a supported refresh path, since `writeManifest` already exists
  with no caller. That unblocks Unit 9's blocked path and fixes the currently red `vendor check`.
- Wire `.claude/skills/**/__tests__/` into `pnpm run qa`. Root `vitest.config.ts` scopes projects to
  `apps/*/*`, `packages/*`, `vendor/packages/*` and `vendor/configs/*`, so today both `full-cycle`'s
  tests and this skill's run only when invoked by hand.

---

## 8. ADR

**Decision.** Ship a `comment-verifier` project skill whose policy lives in one Markdown file, whose
mechanical layer is `@wl/max-jsdoc-lines` enabled locally at `warn` with `--quiet` dropped and
promoted to `error` after a bounded cleanup sprint, whose review pass is a purpose-built prompt, and
whose `--fix` pass delegates to `ai-slop-cleaner` standard mode and is checked mechanically by
`--verify-fix`. Register the two matching detectors in `packages/linter-spec` first. Land enforcement
in `apps/infra-kit/cli/eslint.config.js`, not in `vendor/`.

**Drivers.** The obvious mechanical rule enforces nothing: `jsdoc/informative-docs` at `error` yields
zero over the CLI source tree and never reads line comments (D3). The rule that does have yield is
already installed and merely unenabled (D4). `--quiet` hides `warn`, so visibility and severity are
separate levers (D2). The vendor mirror is checksum-guarded, has no refresh command and is already
failing, so it is not a landing site (D1).

**Alternatives considered.** `informative-docs` as the mechanical layer, rejected on a measured zero.
Editing the vendor config, rejected on D1 and on the fact that it propagates nowhere. A skill with no
lint layer, rejected against the user's stated priority. A lint layer with no skill, rejected because
length is not content and no rule tells a dense rationale from a bloated restatement.
`ai-slop-cleaner --review` for the review pass, not recommended because its contract is post-cleanup
review over a cleanup plan and a changed-file set that do not exist at review time; it is used for
`--fix`, where its contract fits. The name `comment-review` was rejected for colliding with
`/code-review`, and `deslop-comments` for fighting OMC's existing `deslop` keyword.

**Why chosen.** It puts real enforcement in the user's hands in the first configuration unit, with no
new dependency, no publish and no vendor edit, and it stages severity behind visibility so the
roughly a hundred findings cannot redden a build before anyone has seen them. Every gate is derived
from a number in §9, or from a rate applied to one, rather than inherited from a rule it was not
written for. And it corrects the premises that shaped v1.1 wrongly: the pin never excluded
`max-jsdoc-lines`, and the rule v1.1 built on finds nothing.

**Consequences.** Enforcement is repo-local and single-package to start. `error` arrives one unit
later than a single-step plan would promise, which is the price of not walking into the mute that
`temp-disabled.ts` records four previous rules walking into. The skill carries ESLint invocation
logic, including a namespace guard and a stdin path for fixtures, that a package config would not
need; both exist because verified failures demand them. Shipping `--fix` in v1 means the skill can
write, so the verdict filter and `--verify-fix` are safety properties and are tested as such,
independent of the agent. One of the two new rules is conditional on its own measurement and may not
ship at all.

**Follow-ups.** As §7.

---

## 9. Measurements

Taken read-only by the Architect. Every gate in this plan derives from a row here.

| Metric | Value | Command / method |
|---|---|---|
| `jsdoc/informative-docs` at `error`, `apps/infra-kit/cli/src` | **0 findings, exit 0** | `pnpm exec eslint --no-cache --format json --rule '{"jsdoc/informative-docs":"error"}' ./src` — byte-identical to the same run without `--rule` |
| `@wl/max-jsdoc-lines` at defaults, `src/commands` | 17 hits / 13 files | `--rule '{"@wl/max-jsdoc-lines":"error"}'` — estimate, superseded by Unit 2 |
| `@wl/max-jsdoc-lines`, `src/lib` | 34 hits | estimate, superseded by Unit 2 |
| `@wl/max-jsdoc-lines`, `src/dev` | 32 hits | estimate, superseded by Unit 2 |
| `@wl/max-jsdoc-lines`, `src/tui` (all files, not only `.tsx`) | 9 hits | supersedes the v1.2 figure of 5, which covered `**/*.tsx` only — estimate, superseded by Unit 2 |
| `@wl/max-jsdoc-lines`, `src/entry` | 5 hits | estimate, superseded by Unit 2 |
| `@wl/max-jsdoc-lines`, `src/integrations` | 5 hits | estimate, superseded by Unit 2 |
| `@wl/max-jsdoc-lines`, `src/mcp` + `lib/node-warnings` + `lib/vite` | 1 hit | estimate, superseded by Unit 2 |
| **`@wl/max-jsdoc-lines` corpus total** | **113, measured (2026-09-05)** | `pnpm --filter infra-kit run eslint-check` after Unit 2 enabled the rule via `eslint.config.js` (`--quiet` dropped); cross-checked with `pnpm exec eslint --no-cache --report-unused-disable-directives ./src` from `apps/infra-kit/cli`, both exit 0 and both report 113. Replaces the ≈103 per-file-sum estimate above, which predates a whole-package run. |
| Tree-wide and some per-directory `--rule '{"@wl/max-jsdoc-lines":"error"}'` runs | **fail** | `could not find plugin "@wl"`. Per-file runs succeed, which is why the total above is a per-file sum and therefore an estimate. Scenario 6 carries the cause and the workaround |
| JSDoc summary paragraph over 5 lines | 51 of 2,171 blocks | static script over the corpus |
| JSDoc blocks over 15 total lines | 124 | static script over the corpus. The gap to the rule's ≈103 is the `@fileoverview` / `@module` / `@packageDocumentation` exemptions, which the script does not apply |
| Crude line-comment overlap at ratio 0.8 | 1 candidate corpus-wide | prefix matching, no stemmer; **did not fire** on `// Ask for confirmation` above `confirmOrExit`, because "confirmation" does not prefix-match "confirm" |
| Corpus, `apps/infra-kit/cli/src` excluding tests | 313 files, 41,991 lines, 2,171 JSDoc openers, 2,481 `//` lines | |
| `DETECTOR_IDS` entries | 54 before Unit 1; **56 after Unit 1 (2026-09-05)** | `pnpm --filter @pkg/linter-spec test` bijection test, ESM probe against `dist/index.es.js` |

Filled by Unit 3 (2026-09-05), gating Unit 8 only. Scripts under the session scratchpad
`unit3/` (`porter.mjs`, `measure-overlap.mjs`, `measure-summary.mjs`, `stemmer.test.mjs`,
`check-ground-truth.py`). Stemmer: Porter 1980, *Program* 14(3), implemented from the published
algorithm, no code copied; `node --test stemmer.test.mjs` 7/7, including `confirmation`→`confirm`.
Corpus: 311 files, 2,487 `//` lines, 768 comment runs eligible for scoring.

| Metric | Value | Command / method |
|---|---|---|
| Line-comment candidates, real Porter stemmer, ratio 0.5 / 0.6 / 0.7 / 0.8 / 0.9 / 1.0 | 35 / 26 / 3 / 1 / 1 / 1 | `node measure-overlap.mjs --root apps/infra-kit/cli/src --ratios 0.5,0.6,0.7,0.8,0.9,1.0 --format json`. 0.5 added as sensitivity, not as a tuned threshold. Of the 35 at 0.5, **21 are one repeated `// MCP Tool Registration` banner** |
| Ground-truth recall, by exact file:line | **1 of 5 at 0.6; 4 of 5 at 0.5; no ratio recalls all five** | `worktrees-add/remove/sync` fire only at 0.5 (`ask` has no counterpart in `confirmOrExit`); `gh-release-deploy-selected.ts:131` at 0.667 (`validate`→`valid` vs `invalidServices`→`invalid`); **`worktrees-list.ts:61` is unreachable at any ratio** — its comment describes the block that follows, not the next statement |
| Sampled precision at ratio 0.5, n=30, seed 20260905 | 0.90 (27/30); **0.75 excluding the banner template** (9/12) | 18 of 30 samples are the identical MCP banner; false positives: `jira/api.ts:222`, `gh-release-list.ts:23`, `gh-merge-dev.ts:458` |
| Tokenizer defects exposed | 3 | string-literal contents count as code tokens; a trailing `//` on the code line counts as code; a one-line `/** */` after the comment is captured as the code line |
| **Unit 8 gate** | **FOLLOW-UP** | volume and precision pass, recall fails; the measurement command in Unit 3's acceptance (grep by filename) is unsound — it returns 6 at 0.6 and 9 at 0.5 because of banners in the same files. Any future gate must match file:line pairs |
| Summary paragraph over 5 lines (re-measured) | 51 of 2,166 blocks | `node measure-summary.mjs --root apps/infra-kit/cli/src --max 5 --maxTotal 15`; blocks over 15 total lines: 127 (v1.3 static script said 124 / 2,171 — file-set or opener difference; the over-5 figure reproduces exactly) |

Measured, and checked rather than discovered by Unit 2 step 5 — the other warnings that appear once
`--quiet` is dropped from the CLI package:

| Rule | Count |
|---|---|
| `jsdoc/multiline-blocks` | 3 |
| `react/set-state-in-effect` | 3 |
| `sonarjs/todo-tag` | 2 |
| `regexp/no-useless-flag` | 2 |
| `react/no-array-index-key` | 1 |
| **Total** | **11** |

Eleven lines alongside the rule's own output. Nothing is buried and no follow-up is needed.

Still to be recorded, by Unit 2 and Unit 6:

| Metric | Value | Command / method |
|---|---|---|
| Authoritative `@wl/max-jsdoc-lines` corpus count, replacing ≈103 | **113 (2026-09-05)** | `pnpm --filter infra-kit run eslint-check`, rule enabled via `eslint.config.js` |
| Inline disables used in the cleanup sprint, budget 25% of the row above | **0 of 113 (0%), 2026-09-05** | `grep -rn 'eslint-disable-next-line @wl/max-jsdoc-lines' apps/infra-kit/cli/src` → 0. Resolution mix across the three partitions: 66 contract/rationale splits (rationale moved verbatim into `//` blocks), 37 `@fileoverview` tags on module-level blocks as reported by the executors and 33 counted in the diff by the reviewer, 10 `@example` trims. Whole-package `--no-cache` run: 0 `@wl/max-jsdoc-lines`; the 11 other warnings unchanged. Flipped to `error` the same day; a 20-line probe block made `eslint-check` exit 1, reverted |

---

## 9b. Interface change after v1 (2026-09-05, user decision)

The `--fix` flag is **gone**. The skill is one invocation that reviews and then applies: scope →
mechanical → verdict → apply → verify. Units 5a and 5b remain accurate as a description of the
*phases*; they are no longer two commands.

The user's reasoning, and it is right: this is a *verifier* in the sense of a tool that leaves the
code correct, not one that files a report and waits. Asking twice for something the user always
wants twice is friction, not safety.

What was traded away, stated plainly: nothing forces a human to read the verdict before edits land.
That was Principle 4's real content, and it is now weaker.

What was **not** traded away, and this is why the trade is affordable:

- The verdict is still authored in full before any byte is written, and it goes into the report.
- The filter still drops `keep` and `rename-or-refactor-instead`.
- The snapshot is still taken before the first edit, and it is still the `--verify-fix` baseline.
- `--verify-fix` still fails on any changed byte no verdict entry accounts for, and a failure is now
  an explicit stop with a restore-from-snapshot instruction rather than a warning.

The safety property was always mechanical. It lived in `textHash` plus the region comparison, never
in the fact that a human typed the second command. Splitting the invocations protected against a
reviewer that self-approves; the region check protects against the same thing without the friction,
because it does not trust the reviewer at all.

## 10. Decisions taken, and what remains open

Settled by the user on the v1 draft:

1. **Name.** `comment-verifier`.
2. **Enforcement site.** A local `eslint.config.js`, never `vendor/`. The *rule* changed from
   `informative-docs` to `max-jsdoc-lines` on measurement, but the site the user chose is unchanged.
3. **Scope.** `apps/infra-kit/cli` first; the other three configs are a follow-up.
4. **`--fix`.** In v1, as Unit 5b, with `ai-slop-cleaner` standard mode underneath.

**Settled at the approval gate (2026-09-05): option (ii), a direct reviewer prompt for Unit 5a; `ai-slop-cleaner` standard mode stays under `--fix` (Unit 5b) only.** The question as it was put, kept for the record: the review mechanism. The user asked for
`ai-slop-cleaner --review` under the hood, and the measured contract of that flag does not fit a
pre-cleanup review: it reviews a cleanup plan and a changed-file set that do not exist yet. The
recommendation is a purpose-built reviewer prompt for Unit 5a and `ai-slop-cleaner` standard mode for
Unit 5b, which keeps the skill under the hood on the half where its contract holds. Confirming (i)
instead changes Unit 5a's invocation and its acceptance criteria and nothing else.

Two thresholds remain undecided and both resolve from numbers rather than preference:

- Whether Unit 6 flips to `error`, gated on the count reaching 0 with inline disables at or below
  25% of the count Unit 2 records.
- Whether Unit 8 ships, gated on Unit 3 finding at least 25 candidates at precision 0.8 or better
  with all five ground-truth sites recalled.
