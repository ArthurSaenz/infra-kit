# [DO] Guidance text as editable markdown resources

Status: **pending approval — ralplan consensus v4, Critic APPROVE** (Planner → Architect → Critic `ITERATE` → v3 → Architect `ITERATE` → v4 → Critic `APPROVE`; the three mandatory review edits are folded in)

## 1. Summary

The text `infra-kit` injects into `CLAUDE.md` files — the repo-root block, the five per-package type
bodies, and the `DESIGN.md` skeleton — lives today as string arrays inside TypeScript
(`src/lib/agent-guidance/bodies/*.ts`). This plan moves that prose into an editable `resources/` tree
of real `.md` files and keeps a thin TypeScript layer that substitutes variables into them. It
changes nothing about how the text propagates (npm release of the CLI) or how it is validated
(structural audit check, no body equality).

The layout is **one complete `.md` per package type** — open `resources/package/frontend.md` and read
the whole block top to bottom. No skeleton file, no slot parser. (v2 proposed a skeleton plus
heading-parsed slot files; the Critic showed it needed three files to display one body, which is the
criterion it used to reject its own rival.)

Two constraints shape everything, both measured and independently reproduced across passes (§7):

1. **The CLI is a single-file esbuild bundle** (`files: ["dist"]`), so resources are inlined at build
   time. `import x from './a.md?raw'` is the only syntax correct in esbuild, vitest **and** `tsc`.
2. **Prettier owns the bytes of every `.md` in `resources/`** — it is the adversary this design is
   built against, not a footnote. It rewrites `*outside*` → `_outside_`; it destroys a
   `{{placeholder}}` in YAML front matter; and it inserts a blank line beside a bare placeholder that
   sits between two block elements. Every placeholder position in this plan is **measured**
   prettier-stable, not reasoned about — v3 reasoned about one and was wrong (§2, C1 history).

---

## 2. RALPLAN-DR

### Principles

1. **The propagation channel does not change.** Bodies reach a consumer by a published CLI version.
   A resource file is a compile-time input, never a runtime read.
2. **One import syntax, three toolchains.** Anything working in esbuild but not vitest (or vice
   versa) is disqualified — it would make the test suite exercise different bytes than the build.
3. **Editing one sentence of *per-type* prose is a one-file diff with no TypeScript edit.** Stated
   with its measured limit, twice narrowed. Of the ~22 lines in a type file (21 in `backend.md`),
   **18 are shared across all five** and the rest are genuinely per-type. So it holds fully for the
   per-type rules — the text most likely to differentiate a frontend from a backend — and for the root body and the
   design skeleton, which have no per-type axis at all. **A shared-prose edit is a five-file diff**,
   and the drift assertion (§5) forces all five before the suite goes green. That cost is real and is
   the honest price of the layout; see "Why E" below, which no longer rests on this principle.
4. **A malformed resource fails loudly at test time, never silently at render time** — including
   under the dominant damage class, which is not malformed markdown but **valid markdown that
   prettier rewrote**. A guard that only catches syntax errors, or only asserts a placeholder is
   still *present*, does not satisfy this principle: prettier's characteristic damage is to leave
   every token in place and add or move a line beside it.
5. **Byte changes are permitted, but only as a recorded decision.** Measured across the whole corpus
   in its final form: the only change is `*outside*` → `_outside_`, **six lines**. Everything else,
   including the design skeleton, is byte-identical to today.
6. **Never lose bytes outside the markers.** Inherited from `docs/agent-guidance-blocks-plan.md`.

### Decision drivers

- **D1 — Single-file bundle, `files: ["dist"]`.** `scripts/build.js` runs esbuild with `bundle: true`,
  `splitting: true`, publishing only `dist`. A runtime `fs` read would need a `files` entry, path
  resolution surviving code-splitting, and could newly fail at runtime in a consumer repo.
- **D2 — Text is composed, not static.** A body interleaves computed values (`packageName`, `relDir`,
  type) and one conditional bullet (`README.md` iff the file exists).
- **D3 — Prettier formats `.md` and `resources/` is in scope.** `.prettierignore` allows `!*.md`; the
  package script is `prettier **/*`, which under `sh` expands to `*/*`. Top-level `CLAUDE.md` sits at
  depth 1 and **escapes** the gate — which is why **six** generated blocks still read `*outside*`
  while `packages/linter-spec/CLAUDE.md:7` is the lone anomaly that got formatted by some other path
  and reads `_outside_`. `resources/{root,package,design}/` sit at depth ≥2 and **are** checked.
- **D4 — `doctor`'s staleness report is CLI-version-keyed and message-only.** Every CLI release
  already reports every block stale whether or not prose changed. Pre-existing; see Decision (iii).
- **D5 — `splitting: true` is load-bearing.** `scripts/build.js:49` records that splitting keeps React
  out of the eager `cli.js`. Measured: shared `.md` text lands in **one** shared chunk, no
  duplication, no React. Consequence: a bundle guard must search all emitted `.js`, not `cli.js`.

### Decision (i) — How resources reach the bundle

| Option | Verdict |
|---|---|
| A. Runtime `fs` read of a published `resources/` dir | **Rejected.** Violates Principle 1 and D1; converts build errors into consumer runtime errors. Its only advantage — editing text without a rebuild — is void, because a consumer cannot edit files inside a globally-installed npm package. |
| B. Codegen `.md` → `.ts` | **Rejected** — expanded treatment below. |
| **C. `import text from './x.md?raw'`** + `loader: { '.md': 'text' }` + ambient `declare module '*.md?raw'` | **Chosen.** Verified in all three toolchains (§7). Zero runtime cost, single-file bundle preserved. |
| D. Bare `import text from './x.md'` with the same loader | **Rejected — measured broken.** esbuild accepts it; vite/vitest evaluates a bare `.md` import as **JavaScript**, so every resource import throws `ReferenceError` under `vitest`. Principle 2. |

**Option B, evaluated in both variants** (v2 judged only the variant that maximises codegen's costs):

- *Checked-in generated `.ts`* — rejected: a prose diff is reviewed twice, source of truth ambiguous.
- *Gitignored, generated by a `pretest` / `prets-check` / `prebuild` lifecycle hook* — the serious
  variant. It **defeats the first objection outright** (nothing reviewed twice; the `.md` is
  unambiguously the source) and **eliminates this plan's highest-severity risk** — Scenario 1,
  esbuild silently failing to follow a dynamic import, cannot occur when the artifact is an ordinary
  `.ts` module — along with the ambient `.d.ts`, the loader option, and a three-toolchain contract
  that must survive every future vite/vitest/esbuild major.

  **It still loses, on one ground stated honestly as the deciding one:** turbo's `ts-check` and `test`
  tasks are both `{}` today, so the artifact needs `dependsOn` wiring and a generator running before
  the two commands developers invoke most — introducing build ordering into a repo already bitten by
  generated-artifact ordering (`vendor check` is red on HEAD for that class of reason). C's own costs
  are listed in the ADR Consequences rather than omitted; the judgement is that a static import list
  plus one reconciliation test (§5) buys back most of B's safety without a codegen step in front of
  `pnpm run test`.

### Decision (ii) — Resource layout

| Option | Shape | Verdict |
|---|---|---|
| A | Skeleton + two files per type | Rejected: two files per type, and no file shows a whole body. |
| B | Skeleton + one *slot file* per type, parsed by `## ` heading (**v2's choice**) | **Rejected.** Needs a `parseSlots` module (fence-awareness, four throw conditions, its own test file) and the rule "a `## ` heading is a code contract; renaming one throws". And it does not deliver the navigation it claims — the heading, summary, `## Read first` header and `## Checks` block live in `package/body.md` and the shared bullets in `package/bullets.md`, so seeing a frontend body means opening **three** files. Its justification also rested on a factual error (the `DESIGN_TYPES` note below). |
| C | One complete `.md` per type with `{{> partials/checks.md}}` includes | Rejected: a template engine with includes *and* variables. |
| **E** | **One complete `.md` per type** — the entire body verbatim, variables only, no skeleton, no parser | **Chosen.** |
| F | YAML front matter carrying the lists as arrays | Rejected: quoting tax, and prettier mangles `{{ }}` in front matter (§7). |

**Why E — the honest argument.** v3 justified E with Principle 3, and the Architect's measurement
falsified that: **18 of the 22 lines in a type file are shared across all five**, so for the majority
of the corpus E makes an edit a five-file diff while B keeps it a two-file diff. Principle 3 selects
E on 4 lines of 22, not on the whole. **The argument that actually holds is magnitude, not
principle:** the redundancy is **72 lines** (the 18-line shared region × 4 extra copies) across a
~198-line, 7-file corpus — bounded, fully visible, and closed by five ordered-equality assertions
(§5). That costs less than a parser
module, its test file, four throw conditions, and a `## `-heading-as-code-contract rule every future
editor must learn. Navigation and edit-locality are genuinely opposed here and no option gives both;
E buys navigation with a five-way write, B buys edit-locality with a parser and three-file
navigation. At this corpus size E is the better trade — and if the corpus ever grows such that the
shared region dwarfs the per-type region further, reopening B is the correct response.

E also **dissolves** v2's `bullets.md` and the error under it. v2 argued the frontend/mobile
`DESIGN.md` rule "already lives in TypeScript as `DESIGN_TYPES` (`agent-guidance.ts:36`)". Verified
wrong three ways: it is at `:37`; it governs only whether `audit --fix --design` *scaffolds the file*
(sole use `:224`), not which Read-first bullet renders — that rule is `firstReads: [DESIGN_BULLET]` at
`bodies/type-rules.ts:27,65`, which this plan deletes; and it is module-private, so exporting it for
`bodies/package-body.ts` would create a cycle with `agent-guidance.ts:9-10`. **Under E the bullet's
presence in `frontend.md` and `mobile.md` *is* the rule.** No constant, no export, no cycle;
`DESIGN_TYPES` keeps its real job untouched. Note that `buildPackageBody` still takes `type` as
**data**, not merely as a file selector — it feeds the version line (`package-body.ts:27-29`) and the
`{{type}}` variable — so the parameter stays.

```
apps/infra-kit/cli/resources/
  README.md                  # how this tree works (excluded from the reconciliation walk)
  root/
    body.md                  # the root block body (version line is prepended by TS, not stored here)
  package/
    frontend.md              # the COMPLETE frontend body
    backend.md
    lib.md
    e2e.md
    mobile.md
  design/
    skeleton.md              # the DESIGN.md scaffold; front matter stays static
```

Resource files contain **no version line and no marker string** — TypeScript prepends the version
line — so `bodies.test.ts:101` and `:105-109` keep guarding real properties.

**Placeholders — the complete set, each measured prettier-stable in its actual position:**

| File | Placeholders |
|---|---|
| `package/*.md` | `{{packageName}}`, `{{relDir}}`, `{{type}}`, and **`- {{readmeBullet}}`** — the conditional, authored **as a list item with the `- ` marker in the file**, the variable carrying only the bullet *text* |
| `design/skeleton.md` | `{{packageName}}` — in the **H1** (`design-skeleton.ts:47`), not in front matter |
| `root/body.md` | none |

**Why `- {{readmeBullet}}` and not a bare `{{readmeBullet}}` line — measured.** v3 specified the bare
form. A bare placeholder line is a *paragraph*; the `- \`DESIGN.md\`…` line after it opens a *list*;
prettier separates block elements with a blank line and therefore **inserts one, in all five type
files**. Three consequences, all measured, all fatal to v3's own claims: step 4's "the only hunks are
the six `*outside*` lines" becomes false by five more; the rendered body reaches **exactly 25 lines**,
the ceiling `bodies.test.ts:36-38` enforces — the identical failure §3's `trimEnd` was introduced to
avoid, reopened by an *interior* line that `trimEnd` cannot touch; and a package with no `README.md`
renders a **doubled blank line** into its `## Read first` section. The list-item form is measured
byte-identical to today's output and prettier-clean in all five files, at a maximum of 24 lines.

**`design/skeleton.md` injects `packageName` at two points, not one.** v3 named only the front-matter
`name:` line and would have shipped a literal `# Design — TODO` heading into every scaffolded file
(`design-skeleton.ts:47` is the second point). Because front matter cannot hold `{{ }}` (§7), the two
points use two mechanisms deliberately: the front matter keeps a **static `name: TODO`** line that
`buildDesignSkeleton` replaces by exact string match — measured unique, `fontFamily: TODO` does not
collide — and the H1 carries an ordinary `{{packageName}}`. Measured: front matter contains no `{`,
so §5's front-matter assertion passes, and `PLACEHOLDERS['design/skeleton'] = ['{{packageName}}']`,
so the survival guard covers that file rather than being vacuous on it.

TypeScript that remains, all under `src/lib/agent-guidance/`:

- `resources.ts` — the only module with `?raw` imports. A flat, explicit import list (no dynamic
  `import()`, no glob) so esbuild statically inlines every file. Each import is `.trimEnd()`-ed here;
  `buildDesignSkeleton` re-adds its single trailing newline (§3). Also exports
  `PLACEHOLDERS: Record<ResourceKey, readonly string[]>` beside the import record.
- `template.ts` — `renderTemplate(template, vars)`. **Named `template.ts`, not `render.ts`, because
  `src/lib/render/` already exists** (`formatAlignedRows`). Contract:
  - **single-pass** substitution — a successive-`replaceAll` implementation would re-substitute a
    `{{…}}` sequence appearing inside an injected value, and `packageName` comes from a `package.json`
    on disk;
  - throws in **both** directions — a placeholder with no var, and a var the template never uses;
  - **the lone-list-item rule**, exactly one call site (`- {{readmeBullet}}`): a line matching
    `- <single placeholder>` whose placeholder resolves to the empty string is removed, newline
    included. Evaluated on the **template**, never on the result — on the result it would eat the
    intentional blank lines between `## Checks` and its bullets. Deliberately marker-aware rather
    than a general "lone placeholder" primitive, because the general form is the one measured
    prettier-unstable above;
  - multi-line values are permitted only at column 0, asserted by a test.
- `bodies/*.ts` — kept, shrink to composition. Exported signatures unchanged.

`TYPE_RULES` is deleted. Complete reference set, verified: `bodies/type-rules.ts` (definition),
`bodies/package-body.ts:3,8,46,56`, `__tests__/bodies.test.ts:8,45,66`, **and
`src/lib/agent-guidance/index.ts:9-10`, which re-exports both `TYPE_RULES` and the `TypeRules` type.**
Nothing outside `src/lib/agent-guidance/` references it. Its `label` field is redundant (all five
entries equal the type string), so the summary line renders `{{type}}`.

### Decision (iii) — Versioning the text

| Option | Verdict |
|---|---|
| **A. CLI version as the only version axis** | **Chosen.** Editing a `.md` and publishing the CLI already *is* the release; §4 step 13 writes that sequence down. |
| B. A separate `guidanceRevision` in the version line | Rejected here, kept as follow-up (b). It would fix D4, but changes the version-line grammar `inspect.ts` parses and that consumers already carry blocks in. |

### Pre-mortem (deliberate mode)

**Scenario 1 — The build inlines nothing.** Someone refactors `resources.ts` to resolve files
dynamically; esbuild cannot follow it. The specifier survives to runtime and node throws
`ERR_UNKNOWN_FILE_EXTENSION` — a loud crash in a consumer repo, not silent truncation. Still the
highest-severity item, because it is invisible to every test running from `src/`.
**Mitigation** — a hermetic bundle guard rebuilding via the real exported `buildOptions`, asserting a
sentinel from each resource file is in the emitted bytes. Four measured constraints, all requirements:
- esbuild's default `charset: 'ascii'` escapes non-ASCII and **every bullet contains an em dash** —
  so sentinels must be ASCII-only substrings (e.g. `the visual language (colors, typography,
  spacing, components)`). Earlier drafts also offered "or normalize through `escapeNonAscii()`";
  no such helper exists in this repo or in esbuild's API, and the ASCII-only rule is sufficient.
- With `splitting: true` the text lands in a `chunk-*.js`, **not** `cli.js` — concatenate every
  emitted `.js`.
- `buildOptions.outdir` is the real `dist` (`scripts/build.js:42`). Override with
  `mkdtempSync(join(CLI_ROOT, 'node_modules/.cache', prefix))` — **not** the system tmpdir: the
  existing harness (`src/mcp/__tests__/helpers/mcp-harness.ts:54-59`) builds under `node_modules/.cache`
  and its comment explains why (externals resolve by walking up to a `node_modules` above the bundle).
- Budget: a full multi-entry esbuild build inside the unit suite. Measure on first run; if it exceeds
  ~3 s, move it to the `qa:pty`-style opt-in lane rather than deleting it.

**Scenario 2 — A shared-region edit lands in one type file and not the other four.** Under E this is
the *only* silent-drop mode left (there is no parser to mis-split, and a body is the file), and it is
live on 18 lines per file, not the 9 v3 claimed.
**Mitigation — per-file ordered equality against a shared array.** Derive an 18-line `SHARED` array
from `lib.md` (its content minus its `## Rules` bullets), then for each of the five assert that
`lines.filter(l => !PER_TYPE[type].includes(l))` **deep-equals `SHARED`, in order**. Five assertions,
no magic cardinality constant, no heading extraction — so E genuinely carries no
heading-as-code-contract rule.

*Two weaker formulations were measured and rejected.* A **set**-intersection (`new Set(lines)`, the
obvious implementation) has cardinality **12**, not 18 — the seven blank lines dedupe to one — so an
implementer would hit 12, "fix" the constant, and silently drop blank-line coverage. And even under
multiset semantics an intersection is blind in two directions that matter: **adding** a shared line to
`backend.md` alone keeps cardinality at 18 and still equals the anchor (green), and **reordering** two
`## Checks` bullets inside `e2e.md` is likewise green. Adding a shared bullet is the single most
likely form of the edit this scenario is about, so an intersection would miss the common case. Ordered
equality catches additions, deletions, rewrites and reorders, and is anchor-symmetric.

A second assertion keeps the frontend/mobile-only text byte-identical between those two files.
Measured: that is **two** lines, not one — the `DESIGN.md` Read-first bullet *and* the rule
`- Use the tokens in \`DESIGN.md\` …` (`type-rules.ts:31` = `:69`) — and `bodies.test.ts:92-94`
asserts a sentinel for only the first, on `frontend` alone.

**Scenario 3 — Prettier changes valid markdown and every guard still passes.** Three measured
instances, each of which defeated the mitigation written for its predecessor:
- v1: `name: {{packageName}}` → `name: { { packageName } }` — **valid YAML with the expected key**, so
  "assert the front matter parses with the expected key set" passed on the exact bug.
- v2: three mitigations that were **all inert on the only file with front matter** — a convention
  enforced by nothing, a placeholder guard over a file declaring zero placeholders, and a throw
  contract on a code path that file never takes.
- v3: a bare `{{readmeBullet}}` line, where prettier **adds a line beside the placeholder** and the
  placeholder-survival guard goes green because the token is still literally present.

  **This last one is the shape to internalise, and it is why Principle 4 is worded as it is: prettier's
  characteristic damage leaves every token in place.** A guard asserting presence can never catch it.
**Mitigation, v4 — and the primary net is an assertion on the *rendered output*, not on the file.**
The natural candidate for primary — "every resource file is byte-identical to its own prettier
output" — was measured **auto-satisfiable**: `package.json` defines `prettier-fix` (`prettier **/*
--write`) and `fix` runs it before `qa`, so a developer on the normal loop has prettier *write* the
inserted blank line into the resource, after which the file matches its own output and the assertion
goes green while the rendered body has silently gained a line. On v3's actual defect the whole net was
green — `bodies.test.ts:36-38` is `≤ 25` and the defect renders *exactly* 25; the placeholder guard
passes because the token is still present; `prettier-check` passes because the file was just
formatted. Only the §3 snapshot went red, and its documented workflow is a reflex `vitest -u`.
1. **Exact rendered line counts, per type** — replace `bodies.test.ts:36-38`'s
   `toBeLessThanOrEqual(25)` with five literals (`frontend: 24, backend: 23, lib: 24, e2e: 24,
   mobile: 24` with a README; one fewer without). Five numbers, cannot be silenced by `prettier-fix`
   or by `vitest -u`, and it fails loudly on exactly the "prettier added a line" class. **This is the
   primary net**, and it is the assertion that would have caught v3's defect.
2. **Front-matter assertion:** if a file opens with `---`, the region to the closing `---` contains no
   `{`. Enforces "never a placeholder in front matter" mechanically instead of documenting it.
3. **Prettier-identity assertion:** every resource byte-identical to its own prettier output. Fast and
   specific, and it gives a targeted message in the vitest lane — but secondary, for the reason above.
   Note it duplicates `prettier-check`'s coverage rather than adding any.
4. **Placeholder-survival guard:** every entry in `PLACEHOLDERS` still present literally after
   formatting. Cheap and specific; measurably insufficient alone.
5. `renderTemplate` throws in both directions, so a supplied-but-unused var is caught.

---

## 3. Behaviour-preservation baseline, and the byte change we accept

Capture today's rendered output as a **characterization snapshot** — 12 strings:

```
buildRootBody('0.0.0')
buildPackageBody({ version: '0.0.0', type, packageName: '@x/y', relDir: 'a/b',
                   hasReadme: true|false, hasDesign: false })   // 5 types × 2
buildDesignSkeleton('@x/y')
```

**It is a vitest snapshot file, not 12 hand-maintained literals** — the Critic's objection to a
permanent golden fixture was that it makes every prose PR a two-file diff, friction on the exact
operation this plan exists to make easy. A snapshot keeps the enforcement and reduces the update to
`pnpm exec vitest -u`, with the snapshot diff serving as the prose review.

**One byte change is expected and pre-approved.** Measured by running the entire corpus, in its final
`- {{readmeBullet}}` form, through this repo's prettier: **the only change is `*outside*` →
`_outside_`, six lines. Line counts are unchanged in all five type files; `design/skeleton.md` and
`root/body.md` are untouched apart from that one line.** It is emphasis syntax, invisible when
rendered. Consequence to state plainly: the next `init` — which refreshes every block unconditionally
— rewrites that line in every block here **and in both consumer repos**, so it will appear in their
diffs. Step 13 announces it rather than letting it arrive as a surprise.

**Trailing newlines.** Prettier enforces a trailing `\n` in every `.md`. Today `buildPackageBody` and
`buildRootBody` end **without** one and `buildDesignSkeleton` ends **with** one. Because
`buildManagedBlock` is `` `${start}\n${body}\n${end}` `` (`managed-block.ts:100`), an un-normalized body
would insert a blank line before every end marker in every consumer file. So: **`resources.ts`
`.trimEnd()`s every import, and `buildDesignSkeleton` re-adds its single trailing newline** — named
here because a blanket `trimEnd` alone silently changes the design skeleton's contract.

**Line budget headroom.** Post-fix maximum is **24 of the 25** that `bodies.test.ts:36-38` allows
(frontend, backend and mobile with a README). **One line of headroom.** Adding a single line to the
shared region puts three types at the ceiling — and follow-up (a) is a shared-region edit. This is
recorded next to the drift assertion so whoever makes that edit sees it.

---

## 4. Implementation steps

1. Add `src/md.d.ts`: `declare module '*.md?raw' { const content: string; export default content }`.
2. Add `loader: { '.md': 'text' }` to the exported `buildOptions` in `scripts/build.js`, commented
   with why the bare `.md` form is disqualified.
3. **Write the §3 snapshot from today's builders and commit it green.**
4. Create `resources/` per Decision (ii) — placeholders in the measured positions, `- {{readmeBullet}}`
   as a list item, `{{packageName}}` in the skeleton's H1 with `name: TODO` static. Then verify the
   prettier delta *directly on the resource files*, since nothing composes them yet: copy `resources/`
   to `resources.pre-prettier/`, run `prettier --write resources/`, `diff -ru` the two. **The only
   expected hunks are the six `*outside*` lines, and no file changes line count.** Delete the copy.
5. Add `resources.ts` (+ `PLACEHOLDERS`), `template.ts`; rewrite the three builders to compose;
   delete `bodies/type-rules.ts` and its two re-exports at `index.ts:9-10`. The snapshot now goes red
   on exactly the six `_outside_` lines — update with `vitest -u`, commit message citing §3.
6. Update `bodies.test.ts`: `:45` asserts `**${type}**` instead of `TYPE_RULES[type].label`, and
   **delete `:63-69`** (the per-rule `toContain` loop). With `TYPE_RULES` gone its only possible
   source is the same parse the renderer uses, making it trivially true — a false green. The §3
   snapshot is its replacement and is a genuine literal-string contract.
7. Add `template.test.ts`, `resources.test.ts`, the prettier-identity assertion, the front-matter
   assertion, the placeholder-survival guard, and the two drift assertions.
8. Add the Scenario-1 bundle guard, honouring all four constraints.
9. Write `resources/README.md` **here, before the format gates** — it is a `.md` at depth 2 under
   `resources/`, so `prettier-check` covers it, and authoring it after step 12 would leave it past the
   last gate. Contents: the placeholder list and their required positions, the lone-list-item rule,
   that `{{ }}` must never appear in front matter, that `resources.ts` must never become dynamic, that
   a shared-prose edit is a five-file diff the drift assertions enforce, that adding a *type* needs a
   `PackageType` entry plus an import, and that publishing the CLI ships the text.
10. `pnpm run qa` in the CLI package, then at the repo root, **with the shasum guard**
   (`docs/agent-guidance-blocks-plan.md` §9): snapshot manifests before and after with the single
   command §9 defines — `find . -name package.json -not -path '*/node_modules/*' -exec shasum {} \;`,
   which already covers `vendor/**/package.json`, so this is one snapshot and not two. A full `qa`
   rewrites manifests and the vendor mirror (memory `infra-kit-react-catalog-publish-bug`). Root `qa`
   runs `vendor check` first and is already red on HEAD (memory `vendor-source-of-truth`) — confirm
   this change touches no `vendor/` path rather than reading that red as a regression.
11. **Dogfood the rewritten generator against this repo.** Build hermetically into a temp `outdir` and
    run `audit --fix --all` and `audit --fix --root` from that build — never `pnpm exec` (memory
    `dist-reading-tests-are-vacuous`). Confirm the only diff across the **seven** marker-carrying
    `CLAUDE.md` files (six packages + root; `.claude/CLAUDE.md` carries zero `infra-kit:` markers and
    `audit --fix` never touches it) is the `_outside_` lines. **Caveat, from §9 verbatim: this
    exercises one body of five — all six packages here detect as `lib`.** Under E each type is a
    separate resource file, so four of five get no end-to-end coverage and rely on §5's unit lane.
12. **Re-run the §9 closing checks after the dogfood write**: a *second* shasum-gated `qa` (§9 requires
    both, and the second is the only time this repo exercises its own post-adoption
    `infra-kit-check` across all six packages), plus cold `eslint --no-cache ./src`,
    `git status --short` for stray `??` files, `doctor`, and one `audit` run from *inside* a package
    directory — the only exercise of the `findWorkspaceRoot` walk.
13. **Release sequence** — the half of the request earlier drafts ignored ("add text, release a new
    version"). Consumers run a globally-installed `infra-kit` (memory
    `consumer-repos-run-the-global-infra-kit`), so shipping text is: bump → publish → each developer
    `pnpm add -g infra-kit@latest` → re-run `init`. Announce the one-line `_outside_` diff to the
    consumer repos ahead of it.

Steps 1–2 are the only edits outside `src/lib/agent-guidance/` and `resources/`.

---

## 5. Test plan (deliberate mode)

**Unit**
- `template.test.ts` — substitution; throws on unknown placeholder; throws on unused var; single-pass
  (a value containing `{{x}}` is not re-substituted); the lone-list-item line is removed when the
  placeholder is empty and kept when non-empty, evaluated on the template not the result; a non-empty
  inline placeholder never removes its line; multi-line value at column 0 preserved; indented
  placeholder with a multi-line value rejected rather than silently mis-indented.
- `bodies.test.ts` — `:45` updated, `:63-69` deleted (step 6), and `:36-38` tightened from
  `≤ 25` to **exact per-type line counts** (Scenario 3, mitigation 1 — the primary Principle-4 net).
  Everything else unchanged and is the
  behaviour contract: version line first and `extractVersion`-round-tripping, no
  marker string of either pair, package name / relDir / type rendered, README bullet iff `hasReadme`,
  `DESIGN.md` bullet for `frontend`/`mobile` only, `name: @x/y` **and** `# Design — @x/y` in the
  design skeleton (the second is new, and is what would have caught the C2 defect).
- `resources.test.ts`:
  - **reconciliation** — walk `resources/{root,package,design}/**/*.md` (a path-scoped walk, so
    `resources/README.md` is excluded structurally rather than by a name-based skip list that would
    silently swallow a future orphan) and assert the set matches the exported record exactly, and
    that `PLACEHOLDERS` has an entry per key;
  - every `PackageType` has a type file and every type file is a `PackageType`;
  - each resource is **at least 200 bytes and contains its per-file sentinel** — not merely
    "non-empty", which prettier's trailing newline makes near-tautological.
- **Front-matter assertion** — any resource opening with `---` has no `{` before the closing `---`.
- **Prettier-identity assertion** (secondary) — every resource file byte-identical to its own prettier
  output. It **must** call `prettier.resolveConfig(filePath)` and pass `filepath`; with prettier's
  defaults (`printWidth: 80`) the 160-char bullets appear to reflow and the test is permanently red
  for the wrong reason. `prettier` is not a declared dependency of this package — it resolves from the
  workspace root, verified working including both config plugins. Either accept that undeclared
  resolution explicitly or add the devDependency, in which case §4's "steps 1–2 are the only edits
  outside …" no longer holds.
- **Placeholder-survival guard** (secondary) — every entry in `PLACEHOLDERS` still present literally
  after formatting. Documented as insufficient alone.
- **Drift assertions** — (i) for each of the five type files,
  `lines.filter(l => !PER_TYPE[type].includes(l))` deep-equals the 18-line ordered `SHARED` array
  derived from `lib.md`; (ii) the **two** frontend/mobile-only lines are byte-identical between those
  files. A comment here records the one-line budget headroom (§3).
- **§3 snapshot** — 12 strings, permanent, updated by prose PRs via `vitest -u`.

**Integration**
- `agent-guidance.test.ts`, `write-managed-file.test.ts`, `inspect.test.ts`, `adoption.test.ts`,
  `audit-fix.test.ts`, `init-repo-guidance.test.ts` — run **unchanged**. Verified that no test asserts
  `*outside*`, so the accepted byte change does not reach them. Any needing an edit means the move was
  not behaviour-preserving.

**Build / e2e**
- Scenario-1 bundle guard, with its four constraints and a runtime budget.
- `pnpm run qa` at the CLI package and repo root, shasum-gated, **twice** (steps 10 and 12).
- The step-11 dogfood against this repo's seven marker-carrying `CLAUDE.md` files, with the
  one-body-of-five caveat recorded rather than implied.
- Step 12's cold eslint, `git status`, `doctor`, and in-package `audit`.

**Observability**
- Nothing new. The change is compile-time: no new runtime path, no new log line, no new failure mode
  on a consumer's machine that is not already a build failure here.

---

## 6. Scope boundary

**In:** the mechanism — resource tree, loader wiring, composition layer, tests, release sequence.

**Out, deliberately:**
- Content changes beyond §3's accepted normalization. Follow-up (a) is the first prose commit.
- The `guidanceRevision` version axis (Decision (iii) B).
- The audit predicate, adoption inference, `--fix` semantics, backup policy, MCP surface — settled in
  `docs/agent-guidance-blocks-plan.md`. The §3 snapshot is a unit fixture, **not** a body-equality
  *check*, so it does not resurrect that plan's rejected option A.
- `vendor/` — editing it reddens the whole root gate. Relevant because `.prettierignore` is a
  `copy-shared-repos-data.mjs` target (`scripts/copy-shared-repos-data.mjs:73-74`), the concrete
  reason Scenario 3 cannot be solved by adding an ignore entry.
- The `prettier **/*` → `*/*` glob hole exempting top-level `CLAUDE.md` (D3). Real, pre-existing,
  orthogonal. Follow-up (c).

---

## 7. Measurements

Run 2026-09-06 against this repo and toolchain, across the Planner, Architect and Critic passes. The
Critic independently reproduced every load-bearing row from v2 and found none overstated; the rows
marked **(v4)** were produced by the Architect against v3's proposed resource files and are what
forced this revision.

| Question | Result |
|---|---|
| esbuild inlines a bare `.md` import with a text loader? | **Yes** — `var a_default = "hello **md** body\n";` |
| esbuild accepts the `?raw` suffix? | **Yes** — identical output bytes |
| Is the loader entry required for `?raw`? | **Yes** — without it: `No loader is configured for ".md" files` |
| vitest resolves a bare `.md` import? | **No** — evaluated as JS: `ReferenceError: probe is not defined at …/probe.md:1:1` |
| vitest resolves `./x.md?raw`? | **Yes** — value is a `string` |
| `tsc --noEmit` with the ambient wildcard? | **Yes** — exit 0 |
| Prettier formats `.md`, and is `resources/` in scope? | **Yes** to both — `!*.md` allowed; `*/*` covers depth ≥2 and prettier recurses into directory args |
| Prettier's effect on the corpus, final form? | **`*outside*` → `_outside_`, six lines, nothing else; no line-count change in any file** |
| Does `proseWrap` reflow the 180-char bullets? | **No** — commented out in `vendor/configs/prettier-config/index.mjs`, so `preserve` at `printWidth: 120` |
| Prettier vs. `{{x}}` in YAML front matter? | **Destroys it** — `name: {{packageName}}` → `name: { { packageName } }`, still valid YAML with the right key |
| Which front-matter token forms survive? | `'{{x}}'` (leaks quotes into output), `__X__`, `<<x>>` |
| **(v4)** A bare `{{readmeBullet}}` line between a heading and a list? | **Prettier inserts a blank line — 5/5 type files, +1 line each.** Rendered body hits **exactly 25**, the `bodies.test.ts:36-38` ceiling; `hasReadme:false` renders a doubled blank line |
| **(v4)** The `- {{readmeBullet}}` list-item form? | **Prettier-stable, 5/5.** Byte-identical to today; max body **24 lines**, one line of headroom |
| **(v4)** How many lines are shared across all five type files? | **18 of 22** — v3's "9" was wrong by 2×; 7 shared lines were unguarded by v3's assertions |
| **(v4)** How many points inject `packageName` into the design skeleton? | **Two** — `design-skeleton.ts:21` (front matter) and `:47` (H1). v3 named only the first |
| **(v4)** Is `name: TODO` unique in the skeleton? | **Yes** — `fontFamily: TODO` does not collide with an exact-line match |
| Does `splitting: true` duplicate the text or pull in React? | **No** — one shared chunk; sentinel hits 1 there, 0 in both entries; no React |
| Does esbuild emit non-ASCII verbatim? | **No** — default `charset: 'ascii'`; `—` → `—` |
| Does any existing test assert `*outside*`? | **No** — so §5's "integration tests unchanged" holds |
| How many `CLAUDE.md` files does `audit --fix` write here? | **Seven** — six packages + root. `.claude/CLAUDE.md` exists but carries zero `infra-kit:` markers |
| Is `resources/` covered by tsconfig / eslint / prettier / `files` / turbo? | tsconfig: no (harmless — the ambient wildcard resolves the specifier without touching disk). eslint (`./src`): no; `src/md.d.ts` is linted. prettier: **yes**. `files: ["dist"]`: not published — correct, it is inlined. turbo `build` has no `inputs` override, so `$TURBO_DEFAULT$` covers `resources/**` — no cache-invalidation bug. |

Probe files were removed; `git status` was clean afterwards.

---

## 8. ADR

**Decision.** Move the guidance prose into `apps/infra-kit/cli/resources/**/*.md` — **one complete
`.md` per package type**, plus a root body and a design skeleton — imported with `?raw`, inlined into
the esbuild bundle at build time, composed by a single ~40-line `renderTemplate`.

**Drivers.** D1 single-file bundle with `files: ["dist"]`; D2 bodies are composed, not static; D3
prettier owns `.md` bytes in this tree; D4 staleness is CLI-version-keyed and message-only; D5
`splitting: true` must stay benign.

**Alternatives considered.** Runtime `fs` reads (rejected: build errors become consumer runtime
errors, and consumers cannot edit an installed package). Codegen, in **both** variants — checked-in
(rejected: prose reviewed twice, ambiguous source of truth) and gitignored behind a lifecycle hook
(rejected on one honest ground: build ordering in front of `ts-check` and `test`, turbo tasks with no
prerequisites today). Bare `.md` imports (rejected: measured broken under vitest). Skeleton + slot
files (**v2's choice, rejected**: a parser, four throw conditions, and a `## `-heading-as-code-contract
rule, for a layout still needing three files to show one body). Two files per type; include
directives; YAML front-matter arrays.

**Why chosen.** One file shows a body top to bottom; the published artifact stays a single
self-contained bundle; one import syntax is provably correct across esbuild, vitest and tsc; and at
this corpus size 90 duplicated lines cost less than a parser module and the rules it imposes on every
future editor.

**Consequences.**
- A new ambient `.d.ts` and one esbuild option — plus, stated as costs rather than omitted: a
  three-toolchain `?raw` contract that must survive future vite/vitest/esbuild majors, an ambient
  `declare module` that makes the specifier deliberately unresolvable by `tsc`, the Scenario-1 bundle
  guard, and the "`resources.ts` must never become dynamic" rule.
- **A shared-prose edit is a five-file diff**, and the intersection assertion goes red until all five
  are updated. 18 of 22 lines in a type file are shared, so this is the *common* case, not the edge
  case. Principle 3 holds for per-type prose, the root body and the design skeleton — not for the
  shared region.
- Prettier, not the author, owns the final bytes. That costs one accepted normalization (six lines)
  and requires the prettier-identity assertion as the primary Principle-4 net; a
  placeholder-*presence* guard is measurably insufficient.
- **Every placeholder position is load-bearing.** `- {{readmeBullet}}` must stay a list item and
  `{{packageName}}` must stay out of front matter; both are measured, and the guards enforce them.
- With the intersection drift assertion there is **no heading extraction**, so E carries no
  heading-as-code-contract rule — the claim the ADR makes against option B is true as stated.
- Only one line of budget headroom remains (24 of 25).
- Adding a new package *type* remains two code edits plus a file. `TYPE_RULES` is deleted with its
  two re-exports.

**Follow-ups.**
(a) **The first prose commit: de-duplicate the ticket-naming convention.** The requester's own
example, currently written **twice** in this repo's root `CLAUDE.md` — hand-authored at
`CLAUDE.md:5-16` under `## Ticket Naming Convention`, and generated at `CLAUDE.md:38`. Decide which is
canonical and delete the other. **It is a one-file edit to `root/body.md`** (the generated line is
`root-body.ts:39`), so — contrary to what v4 first claimed — it exercises neither the five-file diff
nor the line budget, which `bodies.test.ts` applies only to `PACKAGE_TYPES`. A genuine shared-region
edit is still wanted as the first real exercise of the drift assertions; this follow-up is not it.
(b) `guidanceRevision` as a second version axis, if D4's always-stale message earns it.
(c) The `prettier **/*` → `*/*` glob hole exempting top-level `CLAUDE.md` from the format gate.

---

## 9. Open question for the requester

The request said the injected text is *"визначений для нашого регіону"* — **defined for our region**.
This plan reads that as the **area/domain** convention, consistent with the example that followed
(the `[FE]`/`[BE]`/`[DO]`/`[APP]` ticket prefixes added to the root `CLAUDE.md` at `init`), and the
layout serves that reading fully.

If it instead means a per-organization or per-region **layer** of guidance — different text for
different teams or deployments out of one CLI — this plan has no concept of one, and the layout needs
a fourth axis (something like `resources/regions/<region>/…` overlaid on the base bodies, plus a
selector that cannot be a config key, since `infraKitConfigObject` is `.strict()` and any new key
hard-fails every older CLI — Principle 6 of `docs/agent-guidance-blocks-plan.md`). **That is a
materially different design and should be settled before implementation begins.**
