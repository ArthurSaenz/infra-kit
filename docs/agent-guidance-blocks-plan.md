# [DO] Per-package agent-guidance blocks in CLAUDE.md (validate + inject)

Status: pending approval (ralplan consensus v8 — Architect SOUND, Critic APPROVE; writer = `audit --fix` by user decision)

## 1. Summary

Every workspace package gets a `CLAUDE.md` next to its `README.md`, carrying an infra-kit managed
block whose body is defined in CLI source and selected by package type (frontend / backend / lib /
e2e / mobile). `infra-kit audit` validates the blocks and `infra-kit audit --fix` writes them — a
CLI-only flag on the existing command, unreachable through MCP by construction. Enforcement switches
on by **workspace adoption**, inferred from working-tree state with no new config key anywhere, so no
CLI release can change an unadopted consumer's CI verdict and no committed flag can brick an older
CLI. Package type is detected from directory convention plus package.json signals, with an optional
`type` key in `infra-kit.config.ts` as the override. `init` refreshes the whole repo and `doctor`
reports staleness without gating anything. `DESIGN.md` is referenced by the frontend body and
scaffolded behind `--design`, never required. The repo root keeps its own body under its own markers
and is excluded from the package check.

---

## 2. RALPLAN-DR

### Principles

1. **A CLI upgrade must never change a consumer's CI verdict.** Consumers run a silently
   self-updating global binary; any check whose pass/fail depends on the running CLI's text, or on a
   newly-added rule, violates this.
2. **The MCP surface never mutates.** The MCP boundary auto-confirms every tool call, so a
   state-changing flag must never be one `handler:` away from an agent invoking it. `audit` stays
   `mcpExposed: true, mutating: false`; `--fix` is reachable only from the CLI parser.
3. **Bodies live in code, not in repo config,** and a code edit must have a real propagation channel
   or the single-source-of-truth claim is false.
4. **A check message is an agent's interface.** Name the offending path, the expected value, and the
   exact command that fixes it.
5. **Never lose bytes outside the markers.** Symlink refusal, byte-identical skip, post-write assert,
   and backup where loss would be unrecoverable.
6. **A repo-config change must never brick an older CLI.** Both `infraKitConfigObject`
   (`z.object({…}).strict()`, and `.partial()` preserves strictness) and `packageConfigSchema`
   (`z.strictObject`) *throw* on an unknown key rather than ignoring it, and `loadLayer` parses every
   layer through the former. So any key committed into a repo hard-fails every command on every CLI
   older than the release that added it — the mirror image of Principle 1, and a total outage rather
   than a red check. **This principle is satisfied in two different ways, and only one is absolute.**
   For root config it holds *by construction*: this feature adds no `infraKitConfigObject` key, so
   nothing it commits can reach `loadLayer`'s throw. For the optional `type` key in
   `infra-kit.config.ts` it holds only *by an ordering precondition* a human must follow (Decision (ii),
   §5 step 6) — that key is a committed repo-config change an older CLI rejects.

### Decision drivers

- **D1 — Blast radius of a red audit.** 27 packages in hulyo, 36 in travelist, each running
  `infra-kit audit` as `infra-kit-check` inside `qa`, plus `audit --root` as `infra-kit-check-root`.
  A new failing check is a repo-wide CI outage.
- **D2 — Type is not knowable from config today.** Zero consumer configs declare a type, and adding
  one requires a published `@slip-stream-kit/config` release *and* the matching CLI in use before
  anything works.
- **D3 — Noise budget in consumer repos.** 27–36 new files, plus a potential 27–36 `.backup.<ts>`
  files on every fix run, land in real repos that humans review.

### Decision (i) — When the `agent-guidance` check enforces

The predicate is structural in every option below (file exists, package markers present, well-formed,
non-empty body). What differs is *when a failing structure is allowed to fail*.

| Option | Shape | "Must exist in every package" survives? | Verdict |
|---|---|---|---|
| **A** | Compare the block body to the running CLI's body; mismatch fails | Yes | **Rejected.** The shape already rejected for the root block in `docs/infra-kit-slash-commands-plan.md`. Every CLI release reddens both consumers with no repo change — Principle 1. |
| **B** | Structural, enforced from the release that ships it | Yes | **Rejected.** Violates Principle 1 at adoption: the upgrade alone fails all 63 packages, since none has a `CLAUDE.md` today. |
| **C** | Structural, enforced when the repo commits `agentGuidance.enforce: true` to root `infra-kit.json` | Yes | **Rejected (was v1's choice).** Two independent defects. It adds a tenth key to a `.strict()`, throw-on-unknown schema, so the rollout commit bricks *every* infra-kit command on any older CLI — an unmigrated worktree, a release branch, a machine that has not self-updated — which is Principle 6. And a boolean whose only job is "someone flips it later" rots: 28 of 35 hulyo and 37 of 63 travelist `infra-kit.config.ts` files carry a `requiredFiles` override, most marked TEMPORARY, unflipped for months. It also drags in a `CONFIG_KEY_DOCS` edit and two `.shape`-derived test updates. |
| **D** | Presence-based: `CLAUDE.md` absent → pass with advisory; present-but-broken → fail | **No** | Viable fallback. See the delta below. |
| **E** | **Workspace adoption:** *before* adoption every structural state passes with an advisory; *after* adoption every structural failure fails, existence included. Adoption is *inferred* from working-tree state — at least one discovered workspace package already carries a well-formed `<!-- infra-kit:package:begin -->` block | Yes | **Chosen.** |

**One predicate governs everything.** Before adoption, `missing`, `no-block`, `malformed` and
`foreign-block` all report `pass` with an advisory naming the specific state; after adoption, all four
`fail`. Gating only `missing` on adoption — v2's shape — was wrong twice over: a repo whose developers
had hand-written package `CLAUDE.md` files would be classified *not adopted* and yet fail every
package, and a future release that changed `PACKAGE_MARKER_START` would make every existing block
stop matching, evaluate adoption as false, and redden every adopted consumer from a CLI release alone.

**Adoption is working-tree state, not committed state**, because the probe reads the filesystem and
never consults git. Four consequences follow, none of them a reason to reject E, all of them
surprising enough to state:

- `git checkout` between branches changes the audit verdict, with no code and no CLI change. A branch
  that adds the first package block is adopted; `main` is not.
- An uncommitted `audit --fix --all` — or an `init` run, which syncs the whole repo — adopts the
  workspace on that machine before anything is committed.
- One hand-pasted marker pair in a single package adopts the whole workspace and makes the other
  26–35 packages fail. The post-adoption `missing` message names the adopting package for exactly
  this reason (§3.5).
- **`audit --fix` in a single package of an unadopted workspace adopts the whole workspace.** This is
  new with the `--fix` shape: the natural first use of the flag is inside one package, and it writes
  the very block the adoption probe looks for. The run therefore turns enforcement on for 26–35
  packages the user never touched, and the *next* `qa` is where they find out. Mitigated by printing a
  distinct line whenever a fix flips adoption (§3.5), not by suppressing the effect — suppressing it
  would need state the design deliberately does not have.

**Why E dominates.**

- **No new config key anywhere**, so Principle 6's root-config half is satisfied by construction:
  nothing this feature commits can brick an older CLI, and neither `infraKitConfigObject` nor
  `config-templates.ts` is touched.
- **No flag to rot.** The adoption artifact is the `audit --fix --all` commit itself, which is more
  reviewable than a boolean because the diff shows exactly what is being enforced and where.
- **No CLI release can flip an unadopted workspace.** Verified today: 0 of 27 packages in hulyo, 0 of
  36 in travelist, 0 of 6 here carry a package block, so an upgrade alone changes no verdict in the
  state all three repos are in. The guarantee is scoped to that state deliberately: *post*-adoption,
  the package set is whatever `discoverPackages` returns, and that is CLI code. It supports only the
  `*` segment wildcard today, so a future release that added `**` or relaxed the `!`/`vendor` filter
  would discover previously invisible packages, none carrying a `CLAUDE.md`, and redden an adopted
  consumer with no repo change. That residual is real and is the price of enforcing anything at all.
- **A marker change is self-healing** — but as a *consequence of* the all-pass-before-adoption rule
  above, not as an intrinsic property of E. If a release changed `PACKAGE_MARKER_START`, no block
  would match, adoption would evaluate false, and every check would pass with an advisory rather than
  failing. Nobody should "fix" that behaviour without re-reading this paragraph.
- **The rollout commit is the opt-in,** and it is atomic: the same commit that creates the files is
  the one that turns enforcement on.
- **A partial rollout or a newly added package is caught.** A package added six months from now with
  no `CLAUDE.md` fails, which is the user's stated requirement and the thing D loses.
- **Cost is bounded.** Per `audit` invocation: one `pnpm-workspace.yaml` parse, then ≤ 63 `stat`
  calls, reading only the `CLAUDE.md` files that exist and stopping at the first well-formed block.
  Zero reads where no `CLAUDE.md` exists, one read per existing file otherwise — so both consumers pay
  63 stats and no reads today, while a repo whose developers hand-wrote package `CLAUDE.md` files
  reads every one of them before concluding "not adopted". Adopted repos usually pay one read
  (packages are sorted, so the probe short-circuits early).

**Residual, stated plainly.** A per-package `audit` — the cwd-based `infra-kit-check` shape, which
turbo runs 27–36 times in parallel — must now locate the *workspace* root by walking up to
`pnpm-workspace.yaml`, and each of those processes pays the adoption probe independently (adoption is
memoized per process, not across them). That is a new dependency on workspace-wide context inside
what was a single-package check, and it is the honest price of E. When no `pnpm-workspace.yaml` is
found walking up, the workspace is treated as **not adopted**. The repo root is never a target of
this check at all (see §3.5).

Pinned by three tests in `commands/audit/__tests__/audit.test.ts`:
- *pre-adoption* — "workspace with zero well-formed blocks → `allPassed: true`, and every
  `agent-guidance` check passes with an advisory naming its state, including a package whose
  `CLAUDE.md` exists but carries no block";
- *post-adoption* — "one package carries a well-formed block, another has no `CLAUDE.md` → only the
  second fails, and its message names that package's path, the adopting package, and
  `infra-kit audit --fix`";
- *per-package shape* — the same two verdicts reached through `audit` with no flags from inside a
  package directory, which is the only path that exercises `findWorkspaceRoot` and is the shape turbo
  runs 27–36 times as `infra-kit-check`.

**Fallback to D, exact delta.** If E is rejected, D changes exactly two things and nothing else: the
adoption probe and the workspace-root walk are deleted, and the pre/post-adoption columns collapse to
a per-file rule — `missing` passes always, the other three fail always. Everything downstream — the
structural predicate, the five states, the message text, the root exclusion, `--fix`, type detection,
the bodies, the propagation channel — is identical. Note that D reintroduces the marker-change hazard
E's all-pass rule closes: a future `PACKAGE_MARKER_START` change would leave every existing block
matching `no-block`, which D fails unconditionally. The cost of D is that "must exist" is dropped: a
package with no `CLAUDE.md` passes forever, and buying existence back means adding `'CLAUDE.md'` to
each package's own `requiredFiles`, which is 63 hand edits across two repos because
`resolvePackageConfig` replaces that array wholesale and most consumer configs already set
`requiredFiles: []`. That is the same 63-edit cost this plan uses to reject Decision (ii) option A, so
it cannot be treated as free here.

### Decision (ii) — Where package type comes from

| Option | Verdict |
|---|---|
| A. Explicit `type` in `infra-kit.config.ts`, required | **Rejected.** Nothing works until a config release ships *and* 63 files are edited, and the very first `--fix` run would be impossible. |
| B. Detection only (directory convention + package.json signals) | Viable; zero-friction, but a misdetection is unfixable by the consumer. |
| C. Detect by default, explicit `type` overrides | **Chosen.** |

**Why C.** Detection makes the feature work on day one against both consumer repos untouched
(driver D2); the override is the escape hatch for the cases detection gets wrong, and its absence is
never an error.

**Back-compat precondition.** The schema that governs a consumer's `infra-kit.config.ts` is the
**CLI's own pinned** `packageConfigSchema`, imported from `@slip-stream-kit/config/internal` in
`loader/config-loader.ts` — not the consumer's devDependency. It is `z.strictObject`. So a consumer
that commits `type:` and then runs any CLI older than the one that added the key gets
`Invalid infra-kit.config.ts at <path>: Unrecognized key: "type"` from `checkConfig`, and because
`validatePackage` only runs the rule checks when the config loaded, that package's remaining checks
are **skipped** — the failure blinds the audit as well as reddening it. Bumping the consumer's local
`@slip-stream-kit/config` does not help; it only fixes the TypeScript type. **Hard precondition:
`type` may be written in a consumer config only once the CLI carrying it is the CLI in use.**
Repeated in §3.7 and §5.

### Decision (iii) — Writer command shape — **USER DECISION**

**The user decided on 2026-09-05: no new command. The writer is `infra-kit audit --fix`.** This is
recorded as a product decision, not a review finding; the options below are kept so the reasoning
behind the rejected shapes survives.

| Option | Verdict |
|---|---|
| A. A new top-level `infra-kit agent-sync` | **Rejected by user decision.** It was this plan's choice through v5 and it is technically workable, but the user does not want another command in the surface. |
| B. `doctor --fix` | **Rejected.** Wrong domain. `doctor` fixes the *machine* — shell integration, daemon routes, stale portless entries. Package content is not a machine property, and folding it in would make `doctor --fix` write into the repo. |
| C. `init` only | **Rejected.** `init` also rewrites `~/.zshrc` and runs config migrations, so it cannot be the per-package writer: there is no way to fix one package, and no user should have to touch their shell to regenerate a block. `init` still refreshes the whole repo as a side effect (§3.6). |
| D. **`infra-kit audit --fix`** | **Chosen (user decision).** |

**Why D works, and how Principle 2 is kept.** `--fix` is a flag on the command that already knows how
to find the packages, already resolves the three scopes, and already reports the exact defects the
flag repairs. The model is `eslint --fix`: repair what can be repaired, then re-report everything
else as it stands. MCP safety is by construction, mirroring the shape `doctor` already uses for its
own `--fix`:

- `auditInputSchema` stays `{ all, root }` — no `fix`, no `design` key, so the flag is not
  expressible in an MCP call.
- The MCP handler keeps passing only `params.all` / `params.root`.
- The catalog entry stays `{ mcpExposed: true, mutating: false }` and `outputSchema` is unchanged.

Three tests pin it: `auditInputSchema` has no `fix`/`design` key; calling `auditMcpTool.handler`
against a fixture with a missing `CLAUDE.md` creates no file; the `audit` catalog entry is unchanged.

**The barrier is load-bearing and must be defended in a comment, because the CI gate cannot see it
break.** `mutating` is not descriptive metadata: `command-catalog.test.ts` fails closed on any entry
where `mutating && mcpExposed && mcpTool?.requiresHumanConfirm !== true`, outside a named low-risk
allowlist. Keeping `audit` at `mutating: false` is correct — the flag is genuinely unreachable over
MCP — **but only because the handler reconstructs its argument object from two named fields.** The
natural future "simplification" of `handler: audit`, or adding `fix` to `auditInputSchema` for
symmetry, would defeat the barrier while leaving `mutating: false` in place, so the very gate whose
job is to catch a mutating capability on an exposed tool would stay green. `doctor` defends its
identical barrier with a comment directly above its handler; `auditMcpTool` must carry the equivalent,
naming both the reason and `command-catalog.test.ts` as the gate that will *not* catch a regression
here.

### Decision (iv) — N per-package files vs `.claude/rules/` path-scoped rules

| Option | Pros | Cons |
|---|---|---|
| A. One `CLAUDE.md` per package (the request) | Loads on demand only when Claude touches that directory; works when Claude is started *in* the package (Anthropic's own large-codebase guidance); sits next to `README.md` where humans find it; read by any agent tool, not just Claude Code | 27–36 new files per repo; N blocks to keep current |
| B. 5 files in `.claude/rules/` with `paths:` frontmatter | 5 files instead of 36; one place to edit | Claude Code-only — Codex/Gemini/Cursor read none of it; invisible from the package directory; the `paths:` globs must encode the same type mapping centrally, so D2 is relocated rather than solved; and it is not what was asked for |

**Chosen: A.** The "N blocks to sync" cost is not manual — one `audit --fix --all` regenerates them
from a single code-side registry, the same maintenance cost as B. B remains available as a purely
additive follow-up: the same registry can emit `.claude/rules/<type>.md` later without changing type
detection or the marker contract.

### Decision (v) — DESIGN.md

| Option | Verdict |
|---|---|
| A. Required file for frontend packages (audit-fail when missing) | **Rejected for v1.** Neither consumer has a single `DESIGN.md`; this fails 6+ packages on adoption, and infra-kit cannot author brand content, so it would force meaningless stubs to go green. |
| B. Referenced by the frontend body only | Zero new failures; zero help getting one written. |
| C. Referenced + scaffolded on demand (`audit --fix --design`), never overwriting | **Chosen (B + C).** |

**Why B+C.** The frontend body names `DESIGN.md` as the design source of truth and tells the agent
what to do when it is absent (ask, do not invent). `--design` writes a skeleton in the Google Labs
`design.md` shape — YAML front matter keys (`name`, `description`, `colors`, `typography`, `rounded`,
`spacing`, `components`) and the prose sections in spec order (Overview, Colors, Typography, Layout,
Elevation & Depth, Shapes, Components, Do's and Don'ts) — with placeholder values a human replaces.
It applies to `frontend`/`mobile` packages only and is skipped for any package that already has the
file. **That spec is self-declared alpha**, so the skeleton is a starting point we may have to
revise, not a contract; the plan does not build anything that parses it. Making `DESIGN.md` required
is a follow-up for once the consumers have real content.

### Decision (vi) — Backup policy

| Option | Verdict |
|---|---|
| A. Always write `<file>.backup.<ts>`, for every file | **Rejected as the package-file default.** Up to 36 backup files per fix run per repo (D3). |
| B. Never back up; rely on git | **Rejected.** Untracked or dirty files are unrecoverable; drops a stated safety rail. |
| C. Git-aware for package files (back up only when the target is untracked, dirty, or outside a git repo); **root keeps today's always-backup** | **Chosen.** |

**Why C, and why the asymmetry is deliberate rather than incidental.** Driver D3 is a *volume*
problem: it exists because a fix run touches 27–36 files, and it does not exist for the root file,
which is one file written by a command a human runs deliberately. `writeManaged` always backs up
before overwriting today, and that is a shipped rail; weakening it for the root would be an
unrequested change that buys nothing, since one backup file per `init` was never the noise anyone
complained about. So the git-aware policy is scoped to package files only, where it keeps the rail
exactly where it matters — a backup is written precisely when git cannot recover the file — and
produces zero backup files in the normal case of a committed `CLAUDE.md`. One `git ls-files -z` plus
one `git status --porcelain -z` per run classifies every target, so the cost is two subprocesses, not
N. **The policy is not user-selectable**: there is no `--backup` / `--no-backup` flag, because
`audit`'s flag surface should stay small and nothing in the rollout needs to override it.

---

## 3. Design

### 3.1 Module layout

New directory `apps/infra-kit/cli/src/lib/agent-guidance/`:

| File | Contents |
|---|---|
| `markers.ts` | `ROOT_MARKER_START/END`, `ROOT_VERSION_PREFIX` (moved from `commands/init/agent-files.ts`), plus `PACKAGE_MARKER_START/END`, `PACKAGE_VERSION_PREFIX`. |
| `package-type.ts` | `PackageType` union, `PACKAGE_TYPES`, `detectPackageType`. |
| `bodies/root-body.ts` | `buildRootBody(version)` — today's `buildAgentsBody`, moved plus the added lines. |
| `bodies/package-body.ts` | `buildPackageBody({ version, type, packageName, relDir, hasReadme, hasDesign })`. |
| `bodies/type-rules.ts` | `TYPE_RULES: Record<PackageType, {label, firstReads, rules}>` — the per-type text registry. |
| `bodies/design-skeleton.ts` | `buildDesignSkeleton(packageName)`. |
| `inspect.ts` | `GuidanceState`, `inspectPackageGuidance(content: string \| null)` — pure, shared by the audit check, the `--fix` path and `doctor`. |
| `adoption.ts` | `findWorkspaceRoot(start)` (walk up to `pnpm-workspace.yaml`, `null` when absent) and `resolveAdoption(workspaceRoot): { adopted: true, workspaceRoot, evidencePath } \| { adopted: false, workspaceRoot }`, memoized per process. **It returns the adopting package's `CLAUDE.md` path, not a boolean** — the probe already holds that path when it short-circuits on the first well-formed block, and it is the only way the post-adoption `missing` message can name what switched enforcement on (§3.5). `workspaceRoot` rides in **both** variants so the check can relativize that evidence path. **`discoverPackages` is wrapped in try/catch here**, and is imported from the deep path `src/lib/package-validator/loader`, **not** from the `package-validator` barrel: that barrel re-exports it too, and taking the obvious path closes a real runtime cycle (`package-validator/index → package-validator.ts → checks/index → agent-guidance-check → agent-guidance/index → adoption.ts → package-validator/index`). The guard matters because `discoverPackages` reads the workspace file with an unguarded `fs.readFile` + `yaml.parse`, so `findWorkspaceRoot` proving the file *exists* does not prove it *parses*. Any throw degrades to the unadopted variant — never a crash in a command that has never read that file. |
| `write-managed-file.ts` | `assertNotSymlink`, `writeManaged`, `classifyGitState`, `assertBlockPresent`, `assertOutsideMarkersUnchanged`. |
| `agent-guidance.ts` | `syncPackageGuidance`, `syncRootGuidance` — the shared sync entry points, called by `audit --fix` and directly by `init`. |
| `index.ts` | Barrel. |

`commands/init/agent-files.ts` keeps `writeAgentFiles` as a thin wrapper over `syncRootGuidance` and
re-exports `AGENTS_MARKER_START/END` from `markers.ts`, so `doctor` and the existing tests keep
resolving.

**No new command directory.** The writer lives inside `commands/audit/` as a `--fix` branch over the
shared `lib/agent-guidance` functions; `init` calls those same functions directly rather than
shelling out to `audit`.

**Two corrections to the moved write rails, both real defects in the code being moved:**

- `assertNotSymlink` currently gates on `fs.existsSync`, which *follows* symlinks. A **dangling**
  symlink returns `false`, the `lstatSync` branch is never reached, and the write goes *through* the
  link, creating a file outside the repo. Replace with `lstatSync` inside a try/catch, refusing on
  any `isSymbolicLink()` and proceeding only on `ENOENT`.
- `assertOutsideMarkersUnchanged` **must exempt first insertion.** `upsertManagedBlock`'s
  non-replace path runs `stripped.replace(/\n+$/, '')` and then appends `\n`, which changes bytes
  outside the markers in two ways: a file ending in blank lines has that trailing whitespace
  collapsed, and a file with no trailing newline gains one. The assert therefore runs only on the
  replace-in-place path, where exact byte-identity outside the markers is true today and worth
  pinning.

**File-API note:** the code being moved uses the **synchronous default** `import fs from 'node:fs'`
(`existsSync`, `lstatSync`, `copyFileSync`, `readFileSync`, `mkdirSync`, `writeFileSync`, `rmSync`).
The move keeps it synchronous. Converting to `node:fs/promises` is a rewrite of `writeManaged`,
`readOr`, `assertBlockPresent` and `migrateLegacyAgentsFile` plus every call site, is not in scope,
and would buy nothing on the spy axis — the recorded hazard concerns *named* `fs` imports, and a
default import is already spy-able. Tests use real temp directories regardless.

### 3.2 Package type detection

`PackageType = 'frontend' | 'backend' | 'lib' | 'e2e' | 'mobile'` (the root has its own body and is
not a `PackageType`).

Precedence, first match wins:

| # | Signal | Type |
|---|---|---|
| 1 | `config.type` present in `infra-kit.config.ts` | as declared |
| 2 | dir matches `apps/*/ui` | `frontend` |
| 2 | dir matches `apps/*/api` | `backend` |
| 2 | dir matches `apps/*/tests` | `e2e` |
| 2 | dir basename is `mobile-app` | `mobile` |
| 3 | dependency `@playwright/test` | `e2e` |
| 3 | dependency `@capacitor/core` or `@capacitor/cli` | `mobile` |
| 3 | dependency `serverless` (a lambda dependency alone is NOT a signal — see the note below) | `backend` |
| 3 | dependency `vite` **and** `react` **and** a `dev` script | `frontend` |
| 4 | anything else | `lib` |

Notes on the table:
- **Directory beats dependencies** because `apps/<app>/{ui,api}` is already load-bearing inside
  infra-kit (`devServersPresets` keys must be `<app>/api` or `<app>/ui`), so it is the repo's own
  declared semantics, not a heuristic.
- **`react` alone never means frontend.** `packages/ui-kit`, `design-system`, `*-widget`,
  `analytics` and `react-date-range` all carry react and are libraries; `vite` plus a `dev` script is
  what separates an app from a component library.
- **There is no `unknown`.** The fallback is `lib`, the least opinionated body. An unknown type must
  never produce a failing check or an empty block.
- Dependencies are read from `dependencies`, `devDependencies` and `peerDependencies` merged.
  `readPackageJson` currently narrows to `{name?, scripts?}` and must be widened.
- Row 1 is inert until the precondition in Decision (ii) is met; detection carries the feature until
  then.

### 3.3 Markers and version line

Package files use a **distinct marker pair**:

```
<!-- infra-kit:package:begin -->
<!-- infra-kit:package:version 0.4.0 frontend -->
… body …
<!-- infra-kit:package:end -->
```

Distinct rather than reusing the root pair, for three reasons: `hasManagedBlock`/`removeManagedBlock`
match by `indexOf`, and neither marker string contains the other, so the two pairs cannot
false-positive on each other; the audit check can therefore *detect and report* a root block pasted
into a package directory as its own failure state instead of silently accepting it; and a
single-package repo where root and package are the same directory can host both blocks without
collision.

The version line carries the CLI version first and the resolved type second, so
`extractVersion(content, PACKAGE_VERSION_PREFIX)` returns the version unchanged (its regex reads to
the first whitespace or `>`) and a separate one-line parse reads the type.

### 3.4 Body text, v1

**Root** — `buildRootBody` keeps today's text and gains exactly three lines: `- \`ik audit --fix\` —
regenerate this repo's infra-kit guidance blocks (\`--all\` for every package, \`--root\` for this
file).` and `- \`ik init\` — re-runs shell integration **and** refreshes every guidance block in the
repo.` in the Commands list, and under Conventions: `Every workspace package has its own CLAUDE.md
with package-scoped rules — read it before editing that package.`

**Package** — one shared skeleton plus a per-type Rules section. Rendered example for
`apps/client/ui` (23 lines, well inside the < 200-line per-file target):

```markdown
<!-- infra-kit:package:version 0.4.0 frontend -->

# @hulyo/client-ui

Workspace package at `apps/client/ui` — type: **frontend**.
This block is generated by `infra-kit audit --fix` — edit text *outside* the markers, never inside.

## Read first

- `README.md` — what this package is and how to run it.
- `DESIGN.md` — the visual language (colors, typography, spacing, components). It is the source of
  truth for UI decisions; if it is absent, ask before inventing one.
- `infra-kit.config.ts` — the audit rules this package must satisfy.

## Checks

- `infra-kit audit` — validate this package against its infra-kit rules.
- `pnpm run ts-check && pnpm run eslint-check && pnpm run test` — this package only.
- `pnpm run qa` at the repo root — the full gate; run it before claiming completion.

## Rules

- Start the app with `infra-kit dev`, never a bare `vite` — dev URLs are proxied and port-free.
- Backend calls go through the path prefixes declared in `dev.proxy` in `infra-kit.config.ts`.
  Never hardcode an API base URL or a port.
- Use the tokens in `DESIGN.md` rather than ad-hoc colors, spacing, or type scales.
```

**The `README.md` bullet is conditional on the file existing** (`hasReadme`), and the `DESIGN.md`
bullet on the type being `frontend`/`mobile`. Four real packages across the two consumers have no
`README.md`; generating an instruction to read a file that is not there is exactly the Principle 4
failure the check messages exist to prevent, applied to the body. infra-kit does not create the
missing READMEs (§11).

Per-type Rules sections (`TYPE_RULES`), 3–4 bullets each:

- **frontend** — as above.
- **backend** — module-scope state belongs in the handler entry file, which is what re-evaluates on
  reload; env vars come from Doppler via `ik env-load` and are never committed; the route prefix this
  service answers is declared in the consuming UI's `dev.proxy`, so changing a path is a two-package
  change.
- **lib** — the public surface is the `exports` map in `package.json`; changing it is a breaking
  change for every dependent package; run `pnpm run build` before a dependent can see a change; no
  app-specific logic belongs here.
- **e2e** — Playwright; every spec cleans up what it creates in teardown; selectors live in Page
  Objects, never inline in specs; never point a run at a production environment.
- **mobile** — Capacitor; native shell settings live in `capacitor.config.*`; the web build feeds the
  native shell, so a device run needs a rebuild first.

### 3.5 Audit check

One check per package, name `agent-guidance`, produced by a new
`cli/src/lib/package-validator/checks/agent-guidance-check.ts`.

**The repo root is never a target.** `audit({root: true})` routes the repo root through the same
`validatePackage` with `ROOT_DEFAULT_RULES`, and the root `CLAUDE.md` carries the *root* marker pair,
so an unguarded check would resolve it to `no-block`/`foreign-block` and fail every consumer's
`infra-kit-check-root` inside `qa`. `validatePackage` therefore gains an explicit
`{ isRoot?: boolean }` option, set by `resolveTargets` for the `--root` target, and the check is
skipped entirely when it is set. A regression test pins this.

Otherwise the check runs **outside** the `if (rules)` branch, so it still reports when
`infra-kit.config.ts` fails to load. It is deliberately *not* implemented by adding `CLAUDE.md` to
`DEFAULT_RULES.requiredFiles`: both consumers override `requiredFiles: []` wholesale, which would
make the rule silently inert.

`inspectPackageGuidance` states → check output, by adoption state (Decision (i) option E):

| State | Before adoption | After adoption | Message (the state-naming half is identical in both) |
|---|---|---|---|
| `ok` | pass | pass | `present (block from infra-kit 0.3.15, type frontend)` |
| `missing` | **pass** | **fail** | `CLAUDE.md missing — run: infra-kit audit --fix` |
| `no-block` | **pass** | **fail** | `CLAUDE.md has no infra-kit block (expected <!-- infra-kit:package:begin --> … <!-- infra-kit:package:end -->) — run: infra-kit audit --fix` |
| `malformed` | **pass** | **fail** | `CLAUDE.md block is malformed (end marker precedes start, or body is empty) — run: infra-kit audit --fix` |
| `foreign-block` | **pass** | **fail** | `CLAUDE.md carries the ROOT infra-kit block (<!-- infra-kit:begin -->); a package needs the package block — run: infra-kit audit --fix` |

**Messages are package-relative; identity comes from the printer.** `checkAgentGuidance` receives an
absolute `packageDir` and has no repo-relative frame of its own, and relativizing against
`process.cwd()` is not a fallback — under turbo the cwd *is* the package directory, so every path
would collapse to `CLAUDE.md` anyway. The house style already solves this: `files-check.ts` emits
`missing file: readme.md` and `scripts-check.ts` emits `missing "build" in package.json scripts`, with
the package identity supplied by `logResults`'s `[FAIL] ${result.packageName} …` prefix and by the
enclosing `packages[]` entry in `structuredContent`.

The one path that *must* be repo-relative is the adopting evidence, because it points at a **different**
package than the one being reported. `AdoptionState` therefore carries `workspaceRoot` in **both**
variants — not only the adopted one — so the check can relativize `evidencePath` against it without
inventing a frame.

Before adoption every non-`ok` message is prefixed `not yet adopted — ` and carries `status: 'pass'`.
The prefix is the only difference: the **specific state is always named**, so a malformed block stays
diagnosable through the JSON/MCP payload and through `doctor` (see below) in a workspace that has not
adopted. After adoption the `missing` message additionally appends the adopting evidence — e.g.
`(workspace adopted: packages/lib-a/CLAUDE.md carries a package block)` — because a developer who
pasted one marker pair by hand, or who ran `--fix` in one package, has no other path from the message
to the cause. That path is carried end to end: `resolveAdoption` returns `evidencePath`,
`validatePackage` takes the whole `AdoptionState` rather than a boolean, and `checkAgentGuidance`
renders it. Keep the parenthetical on one line.

**When a `--fix` run flips adoption, say so.** A fix in an unadopted workspace that writes the first
well-formed block turns enforcement on for every other package, and nothing in the fixed package's own
output would reveal that. So after a `--fix` run, if the workspace was unadopted before and is adopted
after, print a distinct line:

```
workspace adopted — every other package now needs a CLAUDE.md: run infra-kit audit --fix --all
```

It is printed once per run, after the fix and before the check output. A test pins it: a `--fix` in
one package of a four-package unadopted fixture prints the line, and a `--fix --all` on the same
fixture does not (nothing is left needing it).

**Where the pre-adoption advisories are actually visible.** `logResults` prints a line only for a
check whose status is not `pass`, so a `not yet adopted — …` advisory reaches `structuredContent` and
the MCP payload but never the terminal in a default CLI run. Pre-adoption diagnosis therefore happens
through the JSON/MCP output and through `doctor`, not through `infra-kit audit`'s console output. This
is a real trade the all-pass rule makes: the CLI goes from loudly reporting a malformed package block
to saying nothing about it until the workspace adopts. Principle 1 wins that trade, but the claim
should not be overstated.

A malformed block never counts as adoption evidence, since the probe requires a well-formed one. So
the only unguarded window is a workspace with zero well-formed blocks anywhere, which is exactly the
definition of "has not adopted". The gate is as tight as it should be.

`infra-kit` and `ik` both resolve on PATH from the global pnpm install, `pnpm exec infra-kit` resolves
in both consumer repos with no local install, and `doctor` already prints a bare `Run: infra-kit init`
as a check message — so the bare command in these messages is runnable, and matches the existing
precedent.

**No config key of any kind is added.** Under option E there is no `infraKitConfigObject` change, so
`lib/config-templates/config-templates.ts` (`CONFIG_KEY_DOCS`), its nine-key test assertion, and the
`.shape`-derived assertion in `seed-user-global-config.test.ts` are all untouched. Recorded for any
future edit: `z.strict` is `undefined` in the installed zod — the idioms are `z.object({…}).strict()`
or `z.strictObject({…})`.

### 3.6 CLI / MCP surface, and the propagation channel

```
infra-kit audit [--all] [--root] [--fix] [--design]
```

`--all` and `--root` are unchanged. The two new flags are **CLI-only**:

- `--fix` — write the guidance blocks for the resolved scope, then run the normal checks.
- `--design` — with `--fix`, additionally scaffold `DESIGN.md` for `frontend`/`mobile` packages that
  lack one, never overwriting. **`--design` without `--fix` is an error**, not a warning and not a
  silent no-op: the action validates the combination by hand (Commander expresses no flag dependency
  natively), prints one line — `--design requires --fix (it scaffolds DESIGN.md; there is nothing to
  scaffold without a fix run)` — and exits non-zero without running the audit. Erroring rather than
  warning is deliberate: a user who typed `--design` asked for a file to be written, and a warning
  buried above a green audit reads as success.

**Scope mirrors `audit` exactly, which removes the old asymmetry.** No flag = the package resolved by
walking up from cwd (`findPackageRoot`). `--all` = every discovered package, **packages only, no
root** — the same set `audit --all` already checks. `--root` = the root block only. Earlier drafts
had a separate writer whose `--all` included the root while `audit --all` did not; that trap is gone,
at the cost of the rollout needing two commands (§3.7).

**Order and exit code follow the `eslint --fix` model.** `--fix` runs the sync **first**, then the
normal checks, and the reported result is the post-fix state: a `missing` block that the run just
created reports `ok`, and everything the fix cannot repair — a missing `build` script, an absent
`turbo.json` task — is re-reported as it stands. The exit code is non-zero when the post-fix audit
fails **or** when any fix write failed. That second clause matters: pre-adoption, a failed write
leaves the file `missing`, which the check *passes*, so without it a fix run could fail silently at
exit 0.

**The exit code is set in `program.ts`, never in `audit()`.** `audit()`'s standing invariant is that
it never touches `process.exit`/`process.exitCode`, so the MCP tool can reuse it; that invariant is
documented on the function today and this plan keeps it. So `audit()` only *reports* — `allPassed` as
now, plus `fixed[]` entries carrying `action: 'failed'` — and the `audit` action in `program.ts` is
the sole carrier, widening its existing `allPassed`-only gate to:

```ts
const { allPassed, fixed } = result.structuredContent

if (!allPassed || (fixed ?? []).some((entry) => entry.action === 'failed')) {
  process.exitCode = 1
}
```

The rejected alternative is folding fix failures into `allPassed`. It would work on the CLI path and
can never be observed on the MCP path, but it silently redefines a field the MCP `outputSchema`
documents as "whether every audited package passed all checks". Keeping the two signals separate
leaves that field meaning exactly what it says.

**Per-file failure policy: continue and report.** A per-file error — the hardened dangling-symlink
refusal, an `EACCES`, a read-only file — is recorded against that path and the run proceeds to the
next package. Aborting would be worse than it looks: a half-written run can leave one well-formed
block, which **adopts the workspace** and makes every package the run never reached start failing.
Continue-and-report keeps a single bad file from both stopping the fix and switching enforcement on
over an incomplete result.

**MCP safety by construction.** `auditInputSchema` stays `{ all, root }`; the MCP handler keeps
passing only `params.all` / `params.root`; the catalog entry stays `mcpExposed: true, mutating: false`;
`outputSchema` is unchanged. A `fixed: [{path, action, type}]` array is added to `structuredContent`
**only when `fix` is set**, so an MCP payload never carries it and `outputSchema` stays accurate for
every response an MCP client can elicit. This mirrors the comment already sitting above `doctor`'s MCP
handler, which keeps `--fix` off that tool for the same reason.

Logging for a fix run: one line per changed file (`  created   apps/client/ui/CLAUDE.md (frontend)`),
unchanged files counted not listed, then
`Agent guidance synced — 34 unchanged, 2 created (infra-kit 0.4.0)`, then the adoption-flip line if it
applies, then the ordinary audit output.

**Dropped from earlier drafts:** `--check`, `--dry-run`, `--backup`, `--no-backup`. The backup
*policy* is unchanged (git-aware for package files, always for the root); it is simply not
user-selectable. A `--check`-style drift gate for infra-kit's own CI is recorded as a follow-up
(§10), not shipped, because it would put a body-drift signal one flag away from the command consumers
run in `qa`.

**Propagation channel (Principle 3).** Bodies live in code, so a `TYPE_RULES` edit must be able to
reach committed files, and the *check* must never be that channel. Two mechanisms, neither touching
CI:

1. **`init` is the repo-wide refresh path, and is itself an adoption event.** It calls the shared
   `lib/agent-guidance` sync directly — root **and** every package, in one pass — rather than shelling
   out to `audit`. Every consumer already re-runs `init` after a CLI upgrade for the zshrc block, so
   refreshing all 63 blocks becomes the command they already run rather than a new one to remember.
   **That write is unconditional** — `init` does not ask, and does not skip when the workspace is
   unadopted — so a user who runs `init` to fix their zshrc gets a 27–36 file working-tree diff and
   switches enforcement on locally, before any commit. That is a deliberate trade for having one
   refresh command, and it is the reason §3.7 puts the rollout behind an explicit `audit --fix --all`
   on a branch rather than behind `init`.
   **`init` reports per-file sync failures and does not fail on them.** `init.ts` discards
   `writeAgentFiles`'s result today, so replacing that call decides a new failure mode by accident:
   swallow the failure silently, or start exiting non-zero because one package file is unwritable.
   Neither is acceptable unstated. The choice: `init` logs each failed path, continues its remaining
   steps, and leaves `process.exitCode` untouched — its contract is shell setup, and the sync is a
   side effect that must not turn a machine-setup command red. A user who wants the failure to be an
   error runs `audit --fix --all`, which does exit non-zero. Because exit 0 makes the log the only
   signal a partial sync happened, `init` must print a **distinct summary line** naming the count and
   the fix, not just per-path lines buried in its other output:
   `2 package guidance files could not be written — run: infra-kit audit --fix --all`. Pinned by an
   `init` test asserting the summary line, the failed path, and an exit code of 0.
2. **`doctor` reports staleness; the audit check does not.** `doctor` already inspects the root
   `CLAUDE.md` with `hasManagedBlock` and emits a check named `CLAUDE.md block`. **Extend that
   check's message — do not add a second check name.** A new name would have to be added to
   `SECTION_MEMBERS`, both hard-coded `24` literals in `report.test.ts` would become `25`, and the
   real-`doctor()` inventory fixture would have to emit it; extending the existing message costs none
   of that, and `'CLAUDE.md block'` is already sectioned. The message gains, when packages are behind:
   `N package guidance blocks were generated by an older infra-kit (oldest 0.3.15, current 0.4.0) — run: infra-kit audit --fix --all`.
   Two constraints on that extension. **The staleness dimension never changes the check's status**:
   `CheckResult.status` is `'pass' | 'fail'` with no warn state, so staleness rides entirely in
   `message`, and the check's existing pass/fail — which **fails today when the root block is absent**,
   printing `Run: infra-kit init` — is preserved exactly as it ships. And `discoverPackages` must be
   wrapped in try/catch here too, degrading to "no packages": the doctor inventory fixture is a temp
   directory holding only `infra-kit.json` and `CLAUDE.md`, with no `pnpm-workspace.yaml`, so an
   unguarded call rejects with `ENOENT`, propagates out of `doctor()`, and crashes the command in
   every single-package repo. `doctor` is human-run, `mcpExposed: false`, and absent from consumer
   `qa`, so this makes drift **visible** without making it **fatal**. The new work must be explicitly
   read-only: `doctor` is `mutating: true` in the catalog, and this check must not inherit that
   posture. One trade recorded: `CLAUDE.md block` lives in the **Shell** section, an odd home for
   per-package staleness. Moving it later costs three test edits.

### 3.7 Consumer rollout (hulyo, travelist)

1. Publish `@slip-stream-kit/config` with `type`; re-pin the CLI's dependency; publish the CLI.
   **Precondition for step 3:** the `type` key may not be written in any consumer config until the
   CLI carrying it is the CLI in use in that repo, because the CLI's own pinned `strictObject`
   governs and an older CLI fails that package's config check and suppresses its remaining checks.
2. In each consumer, on a branch, run **two** commands — `--all` covers packages only, so the root
   block needs its own pass:

   ```bash
   node <abs path to dist/cli.js> audit --fix --all
   node <abs path to dist/cli.js> audit --fix --root
   ```

   Or simply `infra-kit init`, which does both plus the zshrc block. Prefer the absolute path form for
   the rollout — not because a bare `infra-kit` fails to resolve (it resolves fine in both repos, on
   PATH and through `pnpm exec`), but because a run that writes 36 files should pin *which build*
   wrote them, per the recorded practice of verifying via `dist/cli.js` by absolute path.
3. Review the diff. Correct any misdetected type — only if step 1's precondition is met — by adding
   `type: '…'` to that package's `infra-kit.config.ts`, then re-run `audit --fix --all`.
4. Commit the generated files. **The write in step 2 already adopted the workspace in the working
   tree**; this commit is what makes that true for everyone else and on every later checkout. From
   here on, a package with no `CLAUDE.md` fails `audit`. There is no flag to set and no root-config
   change. Ticket: `[ROOT] add infra-kit agent guidance blocks`. Do the rollout with the explicit
   commands above rather than by running `init` casually, since `init` writes the same files
   unconditionally as a side effect of machine setup (§3.6).
5. `.gitignore`: add `*.backup.*`. With the git-aware policy a tracked `CLAUDE.md` produces no backup,
   so this covers only the first, untracked run.
6. Four packages across the two repos have no `README.md` (`apps/julyo/api` and
   `packages/serverless-config` in hulyo; `packages/redis-query-gate` and `packages/serverless-config`
   in travelist). The body's `README.md` bullet is conditional, so they simply do not get that line;
   infra-kit does not create the file. Flag it in the rollout PR description.

---

## 4. File-by-file change list

### `apps/infra-kit/config/src` (published package)

| Path | Change |
|---|---|
| `lib/package-config/package-config.ts` | Add `export type InfraKitPackageType = 'frontend' \| 'backend' \| 'lib' \| 'e2e' \| 'mobile'` and an optional `type?: InfraKitPackageType` field on `InfraKitPackageConfig`, with a JSDoc `@example` and the older-CLI precondition in the doc comment. |
| `lib/package-config/package-config-schema.ts` | Add `type: z.enum([...]).optional()` to `packageConfigSchema`. No `.default()`. |

### `apps/infra-kit/cli/src` — new

| Path | Change |
|---|---|
| `lib/agent-guidance/markers.ts` | Both marker pairs + both version prefixes. |
| `lib/agent-guidance/package-type.ts` | `PackageType`, `PACKAGE_TYPES`, `detectPackageType({packageDir, repoRoot, pkgJson, declaredType})`. Split into `fromDirectory` / `fromDependencies` helpers to keep cognitive complexity ≤ 15. |
| `lib/agent-guidance/bodies/type-rules.ts` | `TYPE_RULES` registry. |
| `lib/agent-guidance/bodies/package-body.ts` | `buildPackageBody`, with conditional `README.md` / `DESIGN.md` bullets. |
| `lib/agent-guidance/bodies/root-body.ts` | `buildRootBody` (moved, plus the three new lines). |
| `lib/agent-guidance/bodies/design-skeleton.ts` | `buildDesignSkeleton`. |
| `lib/agent-guidance/inspect.ts` | `GuidanceState`, `inspectPackageGuidance`. |
| `lib/agent-guidance/adoption.ts` | `findWorkspaceRoot`, `AdoptionState = { adopted: true, workspaceRoot: string, evidencePath: string } \| { adopted: false, workspaceRoot: string \| null }`, and `resolveAdoption` (memoized per process; `null` workspace root → not adopted; `discoverPackages` in try/catch → not adopted). Returns the adopting package's path, never a bare boolean. Imports `discoverPackages` from `src/lib/package-validator/loader`, never from the `package-validator` barrel (runtime cycle — see §3.1). |
| `lib/agent-guidance/write-managed-file.ts` | `assertNotSymlink` (`lstat` in try/catch), `writeManaged`, `classifyGitState`, `assertBlockPresent`, `assertOutsideMarkersUnchanged` (replace-path only). Synchronous default `node:fs`, as moved. |
| `lib/agent-guidance/agent-guidance.ts` | `syncPackageGuidance`, `syncRootGuidance` — shared by `audit --fix` and `init`. |
| `lib/agent-guidance/index.ts` | Barrel. |
| `commands/audit/fix.ts` | The `--fix` branch: resolve scope, run the sync over it, return `{fixed, adoptionFlipped}` for `audit.ts` to fold into its result. Contains no MCP surface of its own. |
| `lib/package-validator/checks/agent-guidance-check.ts` | `checkAgentGuidance(packageDir, adoption: AdoptionState)` — messages are package-relative in the house style; renders `evidencePath` relativized against `adoption.workspaceRoot` into the post-adoption `missing` message. Use `import type { AdoptionState }` so the type reference adds no runtime edge. |

### `apps/infra-kit/cli/src` — modified

| Path | Change |
|---|---|
| `commands/init/agent-files.ts` | Body, markers and write rails move out; `writeAgentFiles` becomes a wrapper over `syncRootGuidance`; marker constants re-exported for `doctor` and tests. Root keeps always-backup. **Widen `WriteAction` from `'created' \| 'updated' \| 'unchanged' \| 'removed'` to include `'failed'`**, which flows through `AgentFileWrite` and `WriteAgentFilesResult` — the continue-and-report policy has no other way to report a per-file error. |
| `commands/init/init.ts` | Call the shared `lib/agent-guidance` sync for the root **and** every package (not `audit`), and stop discarding the result: log any `action: 'failed'` paths, print the distinct summary line, leave `process.exitCode` untouched, and continue the remaining init steps (§3.6). |
| `commands/audit/audit.ts` | Accept CLI-only `fix`/`design` options; when `fix` is set, run `commands/audit/fix.ts` **before** `resolveTargets`' checks and add `fixed[]` to `structuredContent` (each entry `{path, action, type}`, `action: 'failed'` for a write that failed); print the adoption-flip line when applicable. Declare **`fixed?: Array<{path: string; action: WriteAction; type?: PackageType}>` as an optional property on the return type** — the field is only populated on a fix run, so a conditional spread alone would infer a type with no `fixed` property and `program.ts`'s destructure would not compile; the `(fixed ?? [])` guard covers the runtime, the optional declaration covers the type. `resolveTargets` marks the `--root` target `isRoot`; compute adoption once per invocation via `findWorkspaceRoot` + `resolveAdoption` (re-computed after a fix, so the flip is detectable) and thread the whole `AdoptionState` into `validatePackage`. **Sets no exit code** — the standing "never calls `process.exit` so the MCP tool can reuse it" invariant is preserved verbatim; the exit code is `program.ts`'s job. **`auditInputSchema`, the MCP handler's argument list, `outputSchema` and the catalog entry are all unchanged**, and a `doctor`-style comment goes directly above `auditMcpTool`'s handler recording that `--fix` is deliberately unreachable, that `mutating: false` stays accurate **only** while the handler forwards `params.all`/`params.root` by field, and that `command-catalog.test.ts`'s fail-closed ungated-mutating gate would stay green if a future `handler: audit` defeated the barrier. |
| `lib/package-validator/package-validator.ts` | New options argument `{adoption?: AdoptionState, isRoot?: boolean}`; add the `agent-guidance` check outside the `if (rules)` branch, skipped when `isRoot`. Carries `AdoptionState` through rather than a boolean, so the evidence path reaches the check. **An absent `adoption` option means `{ adopted: false, workspaceRoot: null }`** — `package-validator.test.ts` has eight `validatePackage(` call sites and none passes options, so that default is what keeps them green. Import the type with `import type`. |
| `lib/package-validator/checks/index.ts` | Export `checkAgentGuidance`. |
| `lib/package-validator/loader/config-loader.ts` | Widen `PackageJsonShape` with `dependencies`/`devDependencies`/`peerDependencies`; surface the parsed `type` alongside the resolved rules. |
| `commands/doctor/doctor.ts` | Extend the **existing** `CLAUDE.md block` check's message into a read-only per-package staleness report (§3.6). No new check name. Staleness never changes the status; the existing root-block-absent `fail` and its `Run: infra-kit init` text are preserved. `discoverPackages` in try/catch. Must not acquire any mutating behaviour, and do not `padEnd` a coloured string. |
| `lib/program/program.ts` | Add `.option('--fix', …)` and `.option('--design', …)` to the existing `audit` command and pass them through. **Widen the action's exit-code gate** from `if (!result.structuredContent.allPassed)` to also fire when `(structuredContent.fixed ?? []).some((entry) => entry.action === 'failed')` — this action is the only carrier for the fix-write-failure signal, since `audit()` sets no exit code (§3.6). No new command, no `AUTO_LOAD_EXCLUDED` change. |
| `cli/readme.md`, `docs/` | Document `--fix`/`--design`, adoption semantics, and `init` as the refresh path. |

**Not touched, by design:** `lib/command-catalog/command-catalog.ts` (the `audit` entry keeps
`mcpExposed: true, mutating: false`), `lib/infra-kit-config/infra-kit-config.ts`,
`lib/config-templates/config-templates.ts` and its nine-key test,
`commands/init/__tests__/seed-user-global-config.test.ts`, `commands/doctor/report.ts`, its two
hard-coded `24` check-count literals, and the real-`doctor()` inventory fixture. Option E adds no
`infraKitConfigObject` key and the doctor change adds no check name, so none of these needs an edit.

### Tests

| Test file | Cases |
|---|---|
| `lib/agent-guidance/__tests__/package-type.test.ts` (new) | Table-driven per row of §3.2; explicit `type` beats directory; directory beats dependencies; react-without-`dev`-script → `lib`; `apps/x/tests` → `e2e`; empty package.json → `lib`. |
| `lib/agent-guidance/__tests__/bodies.test.ts` (new) | Per type: body ≤ 25 lines; contains the package name, relative dir and type; version line parses via `extractVersion`; body contains neither marker string; `DESIGN.md` bullet only for `frontend`/`mobile`; `README.md` bullet omitted when the file is absent. |
| `lib/agent-guidance/__tests__/inspect.test.ts` (new) | All five states, including reversed markers, empty body, and a root block in a package file. |
| `lib/agent-guidance/__tests__/adoption.test.ts` (new) | Zero blocks → not adopted; one well-formed block → adopted **and `evidencePath` names that package's `CLAUDE.md`**; a malformed block alone → not adopted; no `pnpm-workspace.yaml` walking up → not adopted; **a malformed `pnpm-workspace.yaml` → not adopted, no throw**; memoization does not leak across roots. |
| `lib/agent-guidance/__tests__/write-managed-file.test.ts` (new) | Real temp git repo: package file tracked+clean → no backup; dirty → backup; untracked → backup; non-git dir → backup; root file → always backup; symlink refused; **dangling symlink refused** (the case `existsSync` misses); byte-identical → `unchanged`; bytes outside the markers byte-identical after an **update**; first insertion into a file ending in blank lines succeeds and normalizes the trailing newline. |
| `commands/audit/__tests__/audit-fix.test.ts` (new) | Temp workspace fixture (`pnpm-workspace.yaml`, `infra-kit.json`, `apps/demo/ui`, `apps/demo/api`, `apps/demo/tests`, `packages/lib-a`): `--fix --all` creates 4 files with 4 different bodies; re-run all `unchanged`; hand-authored prose preserved above and below the block; `--fix --root` touches only the root file and `--fix --all` does not; `--fix` with no scope flag touches only the cwd package; `--fix --design` creates `DESIGN.md` for the ui package only and never overwrites; **`--design` without `--fix` errors with the one-line message, exits non-zero, runs no audit and writes nothing**; the fix runs **before** the checks, so a package whose block was just created reports `ok` in the same invocation; a per-file failure mid-run does not stop the run and is reported as `action: 'failed'` while `allPassed` stays true — asserted on `structuredContent`, since `audit()` sets no exit code; **a `--fix` in one package of an unadopted fixture prints the adoption-flip line, and `--fix --all` on the same fixture does not**. |
| `lib/program/__tests__/*` (modify or new) | The `audit` action's exit-code gate: `allPassed: false` → `process.exitCode = 1` (unchanged behaviour); `allPassed: true` with a `fixed[]` entry whose `action` is `'failed'` → `process.exitCode = 1`; `allPassed: true` with no failed entry → exit code untouched. This is the only place the fix-write-failure signal becomes an exit code, so it is tested where it lives rather than through `audit()`. |
| `commands/audit/__tests__/audit.test.ts` (modify) | **Pre-adoption:** zero well-formed blocks → `allPassed: true`, and every state — `missing`, `no-block`, `malformed`, `foreign-block` — passes with an advisory that names *that* state. **Post-adoption:** one package has a well-formed block, another has none → only the second fails, message names its path, the adopting package, and `infra-kit audit --fix`; a malformed sibling fails too. **Per-package shape:** both verdicts reached via `audit` with no flags from inside a package directory. **Root regression:** `audit --root` emits no `agent-guidance` check in either adoption state. Check still emitted when `infra-kit.config.ts` fails to load. **MCP safety:** `auditInputSchema` has no `fix` or `design` key; `auditMcpTool.handler` run against a fixture with a missing `CLAUDE.md` creates no file; the `audit` catalog entry still reads `mcpExposed: true, mutating: false`; `structuredContent` carries no `fixed` field on a non-fix run. |
| `commands/init/__tests__/agent-files.test.ts` (modify) | Existing cases kept green through the module move, including the always-backup case for the root file. **New:** `init` syncs the root and every package in one pass; over a workspace with one unwritable package file it logs that path, prints the distinct `N package guidance files could not be written — run: infra-kit audit --fix --all` summary line, leaves the exit code at 0, and still runs its other steps. |
| `commands/doctor/__tests__/*` (modify) | Staleness rides in the existing `CLAUDE.md block` check's message; the check count stays 24 and no `SECTION_MEMBERS` entry is added; a stale workspace does not change the status; the pre-existing root-block-absent `fail` still fails with `Run: infra-kit init`; a temp dir with no `pnpm-workspace.yaml` does not throw; the check performs no writes. |
| `lib/package-validator/checks/__tests__/checks.test.ts` (modify) | `checkAgentGuidance` unit rows for both adoption states. |

---

## 5. Release sequencing

1. **Config package first.** Bump `@slip-stream-kit/config` (in-tree `0.4.0`) with the `type` key;
   publish. Nothing may be re-pinned before this lands on npm.
2. **Re-pin the CLI.** Its dependency is `^0.3.15`; move it to the newly published version.
   Re-pinning *before* publishing wedges every `pnpm` command in this repo, so the order is strict.
3. **Publish the CLI** with `audit --fix`, the audit check, the adoption probe, and the `doctor`
   staleness report. Because no consumer package carries a block, this release changes no consumer
   verdict by construction.
4. **This repo adopts it.** `audit --fix --all` then `audit --fix --root` here; commit the generated
   files. That commit is the adoption event. No config change accompanies it.
5. **Consumers adopt it**, per §3.7, one repo at a time, each in a single reviewed commit.
6. **Only after step 5,** and only in a repo where the CLI from step 3 is the CLI in use, may a
   `type:` key be added to any `infra-kit.config.ts`. Writing it earlier fails that package's config
   check on the older CLI and suppresses its remaining checks. Consumers should also bump their local
   `@slip-stream-kit/config` devDependency for the TypeScript type.

---

## 6. Pre-mortem

**Scenario 1 — a CLI release reddens 63 packages.** *Trigger:* the `agent-guidance` check enforces
from the release that ships it; a consumer's silent global self-update lands mid-sprint; no package
has a `CLAUDE.md`; `infra-kit-check` fails everywhere and `qa` is red repo-wide. *Impact:* CI outage
in two production repos from a release with no corresponding repo change. *Mitigation:* enforcement
is inferred from working-tree state — at least one package already carrying a well-formed block — and
zero packages do today, so the upgrade alone cannot enforce anything. The rule that *every* state
passes before adoption is what closes the two side doors: a repo whose developers hand-wrote package
`CLAUDE.md` files is not adopted and does not fail, and a release that changed the marker constant
un-adopts every repo rather than reddening it. Pinned by the pre-adoption `audit.test.ts` case, which
asserts `allPassed: true` across all four non-`ok` states.

**Scenario 2 — an agent writes 36 files through MCP.** *Trigger:* `--fix` is added to the command
that is already an MCP tool. The MCP boundary auto-confirms every call, so if `fix` were expressible
in the tool's input schema, any agent asking for an audit could rewrite a repo. *Impact:* unrequested
writes across a consumer repo, with no confirmation step anywhere in the path. *Mitigation:* three
independent barriers, all pinned by tests — `auditInputSchema` has no `fix` key, so the flag is not
expressible; the handler passes only `params.all`/`params.root`, so it could not be forwarded even if
it were; and the catalog entry stays `mutating: false`. The `handler` for `doctor` carries the same
comment for the same reason, and this follows it deliberately rather than inventing a new pattern.

**Scenario 3 — `audit --root` fails inside the rollout commit.** *Trigger:* the new check is wired
into `validatePackage`, and `audit({root: true})` routes the repo root through that same function; the
root `CLAUDE.md` carries the root marker pair, so the check resolves it to `no-block` or
`foreign-block`. Both consumers run `audit --root` as `infra-kit-check-root` inside `qa`, and so does
this repo. *Impact:* the adoption commit — the one that was supposed to turn the feature on cleanly —
breaks `qa` at the root, in a way no package-level test would catch. *Mitigation:* `validatePackage`
takes an explicit `isRoot` flag set by `resolveTargets`, and the check is skipped for that target;
the `audit --root` regression case in §4 asserts no `agent-guidance` check is emitted for the root.

**Scenario 4 — one `--fix` in one package silently arms the whole workspace.** *Trigger:* a developer
in an unadopted repo hits the failing-looking advisory in the JSON output for their package, runs
`infra-kit audit --fix` there, and commits. That single block satisfies the adoption probe, so the
next `qa` fails 26–35 packages nobody touched. *Impact:* a repo-wide red from a one-package change,
with the cause invisible in the diff. *Mitigation:* the fix path re-evaluates adoption after writing
and, when it flipped, prints
`workspace adopted — every other package now needs a CLAUDE.md: run infra-kit audit --fix --all`; the
post-adoption `missing` message on every other package names the adopting file, so the cause is one
line away in the failure output. Pinned by the adoption-flip case in `audit-fix.test.ts`. The effect
itself is not suppressed — doing so would require persistent state the design deliberately avoids.

**Scenario 5 — a committed key meets an older CLI.** *Trigger:* a consumer commits a `type:` key
after step 5 but before step 6, or checks out a release branch where the global CLI is older. The
CLI's own pinned `z.strictObject` rejects the key, `checkConfig` fails, and `validatePackage` skips
that package's remaining checks. *Impact:* a red *and blinded* audit for that package, arriving from
a git operation rather than a code change. Under v1's rejected flag this was strictly worse — a
`.strict()` root-config key would have thrown on *every* command, not one check. *Mitigation:* the
feature adds no root-config key at all (Principle 6), the `type` key is optional and never required,
and §3.7/§5 carry the precondition as a hard ordering constraint rather than a footnote.

**Scenario 6 — a misdetected type ships wrong guidance into 30 files.** *Trigger:*
`packages/ui-kit` carries react, is classified `frontend`, and every future agent session there is
told to run `infra-kit dev` and follow a `DESIGN.md` that will never exist. *Impact:* silently wrong
instructions, at scale, discovered only by a confused agent. *Mitigation:* the resolved type is
written into the version line, echoed in the audit check message, and printed per file by the fix
run, so the rollout diff shows every path→type pairing before it is committed; explicit `type` always
wins; the fallback is `lib`, the body that claims the least. The `react`-without-`dev`-script row of
the detection test exists for exactly this package shape. Note that dropping `--check` removed the
dry-run table, so **the review gate is now the git diff of the rollout branch** — which is why §3.7
step 3 reviews before committing.

**Scenario 7 — 63 blocks go stale against a `TYPE_RULES` edit.** *Trigger:* the bodies live in code
and the blocks are committed files, so a text edit reaches zero repos until someone re-runs the
command, and by design drift can never fail a check. Precedent: travelist's root `CLAUDE.md` still
records infra-kit `0.1.127` against a `0.3.15` CLI — one file at the top of a repo, drifted unnoticed
for a hundred versions. *Impact:* 63 files confidently instructing agents with superseded rules,
which is Scenario 6's harm arriving through a wider door. *Mitigation:* the propagation channel of
§3.6 — `init` refreshes every block and is the command consumers already run after an upgrade, and
`doctor` reports the oldest block version non-fatally with the fix command. The block's own version
line makes staleness readable from the file itself.

**Scenario 8 — a hand-authored CLAUDE.md is clobbered.** *Trigger:* a package already carries hand-
written notes; a placement bug, a dangling symlink, or a partial write replaces the file instead of
upserting the block; the file was untracked, so git cannot restore it. *Impact:* unrecoverable loss
of human-written content, the one outcome that would end trust in the command. *Mitigation:* four
rails — `upsertManagedBlock` in `replace-in-place` mode; `assertNotSymlink` hardened to `lstat` in a
try/catch so a *dangling* link is refused rather than written through; git-aware backup, which fires
precisely in the untracked/dirty case; and `assertOutsideMarkersUnchanged` on the replace path,
scoped to exclude first insertion because `upsertManagedBlock` legitimately normalizes trailing
newlines there. Covered by the hand-authored, dangling-symlink, and update-identity cases.

**Scenario 9 — a half-finished `--fix --all` adopts a workspace it did not finish writing.**
*Trigger:* an `EACCES`, a read-only file, or the hardened dangling-symlink refusal interrupts the run
after a handful of packages. One well-formed block now exists, so the workspace is adopted, and every
package the run never reached starts failing. The path is reachable casually, because `init` syncs
the whole repo unconditionally. *Impact:* a machine-setup command leaves the repo in the
adopted-and-failing state, with the cause several steps removed from the symptom. *Mitigation:* the
continue-and-report policy in §3.6 — a per-file error never stops the run, so the sync reaches every
package it can and only genuinely unwritable paths are left behind, each named in the output; the run
exits non-zero even when the post-fix audit passes, and `init` prints its distinct failed-file
summary line. Pinned by the mid-run-failure case in `audit-fix.test.ts` and the `init` failure case.

---

## 7. Expanded test plan

**Unit** (pure, no filesystem): `detectPackageType` truth table; `buildPackageBody` / `buildRootBody`
shape, length and conditional bullets; `inspectPackageGuidance` state machine; `checkAgentGuidance`
message text for all five states in both adoption states. Assert on the *message strings* — each
failing message must contain the state and the literal `infra-kit audit --fix`; each pre-adoption
advisory must name its own state and carry `status: 'pass'`; and the post-adoption `missing` message
must name the package whose block adopted the workspace.

**Integration** (real temp directories via `fs.mkdtemp`, plus `git init` where backup policy is under
test): `audit --fix` at all three scopes against a fixture workspace, including a mid-run per-file
failure and the adoption flip; `audit` against the same fixture before and after adoption, with
`--root`, and **from inside a package directory with no flags**; the three MCP-safety assertions;
`init`'s whole-repo sync and its failure path; `doctor`'s staleness report, including a fixture with
no `pnpm-workspace.yaml`.

**E2E** (built artefact): build the CLI in-test with the esbuild options from `build.js` rather than
reading a pre-existing `dist/` — `qa` has no build step, turbo's `test` depends on `^build`
(dependencies, not self), and `**/dist` is gitignored, so a test that reads `dist/` is vacuous.
Fixture repo: `pnpm-workspace.yaml` with `apps/*/*` and `packages/*`, a root `infra-kit.json`, four
packages of distinct types each with an `infra-kit.config.ts`, plus `git init` and an initial commit.
Sequence: `audit --all` on the untouched fixture → exit 0 (pre-adoption); `audit --fix --all` → 4
files created, bodies differ per type, exit 0, and **no adoption-flip line** — that run writes all
four packages and leaves none behind; `audit --all` → exit 0; `audit --root` → exit 0; delete one
`CLAUDE.md` → `audit --all` exits 1 and names that path (post-adoption); `audit --fix --all` → exit 0
and the file is back. The flip line is exercised separately, by the scoped-fix case in
`audit-fix.test.ts`.

**Observability**: per-file log lines follow the existing `  ${action.padEnd(9)} ${relPath}` shape
with a ` (${type})` suffix; the fix summary names the CLI version; the adoption-flip line is printed
once per run, and only when a scoped fix flips an otherwise-unadopted workspace; `structuredContent`
carries `fixed[]` with `path`/`action`/`type` **only** on a fix run; `doctor`'s staleness line names
the oldest block version, the current version, and the fix command; the `audit` action in `program.ts`
sets a non-zero exit code when `allPassed` is false or any `fixed[]` entry has `action: 'failed'`,
while `audit()` itself sets none.

---

## 8. Acceptance criteria

1. In a fixture workspace, `audit --fix --all` creates a `CLAUDE.md` in every discovered package and
   leaves the root untouched; `audit --fix --root` writes the root block and no package file.
   *Verified by* the two scope cases in `audit-fix.test.ts`.
2. Re-running `audit --fix --all` with no source change reports every file `unchanged` and writes no
   bytes. *Verified by* the idempotency case + an mtime assertion.
3. A `frontend`, a `backend`, an `e2e` and a `lib` package receive four different Rules sections, each
   ≤ 25 lines. *Verified by* `bodies.test.ts`.
4. On every **update** of an existing block, bytes outside the markers are byte-identical. On **first
   insertion**, they are identical modulo trailing-newline normalization, which is what
   `upsertManagedBlock` does today. *Verified by* the two `write-managed-file.test.ts` cases.
5. In a workspace where no package carries a well-formed block, `audit --all` returns
   `allPassed: true` — for a missing `CLAUDE.md`, a `CLAUDE.md` with no block, a malformed block, and
   a root block pasted into a package alike — and each passing message names its own state.
   *Verified by* the pre-adoption `audit.test.ts` case. **This is the criterion that proves a CLI
   upgrade cannot redden consumer CI, including on a future marker change.**
6. Once at least one package carries a well-formed block, a package with no `CLAUDE.md` fails; the
   check message names the state package-relative, the enclosing result carries the package name, and
   the message contains the adopting package's repo-relative `CLAUDE.md` path (from
   `AdoptionState.evidencePath` relativized against `workspaceRoot`) and `infra-kit audit --fix`.
   *Verified by* the post-adoption case plus the `adoption.test.ts` evidence-path assertion.
7. Both verdicts hold for `audit` run with no flags from inside a package directory, not only for
   `--all`. *Verified by* the per-package-shape case.
8. `audit --root` emits no `agent-guidance` check and is unaffected in both adoption states.
   *Verified by* the root regression case.
9. `--fix` repairs before it reports: a package whose block was missing at invocation reports `ok` in
   the same run, while an unrelated failing check (a missing script) still fails. *Verified by* the
   fix-then-check case.
10. A `--fix` run that flips the workspace from unadopted to adopted prints
    `workspace adopted — every other package now needs a CLAUDE.md: run infra-kit audit --fix --all`;
    a `--fix --all` run on the same fixture does not. *Verified by* the adoption-flip case.
11. `fix` is unreachable from MCP: `auditInputSchema` has no `fix` or `design` key, `auditMcpTool.handler`
    against a fixture with a missing `CLAUDE.md` creates no file, the `audit` catalog entry still reads
    `mcpExposed: true, mutating: false`, and `structuredContent` carries no `fixed` field on a non-fix
    run. *Verified by* the three MCP-safety cases.
12. A malformed or missing `pnpm-workspace.yaml` yields "not adopted" and never throws, in both the
    audit probe and the doctor check. *Verified by* `adoption.test.ts` and the doctor fixture case.
13. `audit --fix --all` continues past a per-file failure, writes every other package, and reports the
    failed path as a `fixed[]` entry with `action: 'failed'` while `allPassed` stays true; the `audit`
    action in `program.ts` turns that entry into a non-zero exit code **even though the post-fix audit
    passed**, and `audit()` itself still sets no exit code. *Verified by* the mid-run-failure case on
    `structuredContent` plus the program-level exit-code cases, and end to end by the `--fix` steps of
    the e2e sequence.
14. Detection assigns `lib` (not `frontend`) to a react package with no `dev` script, and
    `config.type` overrides detection. *Verified by* `package-type.test.ts`.
15. A tracked, clean **package** `CLAUDE.md` produces no `.backup.` file; an untracked one does; the
    **root** file is always backed up. *Verified by* `write-managed-file.test.ts`.
16. A dangling symlink at a target path is refused, not written through. *Verified by* the dangling
    case.
17. `--design` creates a `DESIGN.md` skeleton only for `frontend`/`mobile` packages and never
    overwrites an existing file; `--design` without `--fix` errors with a one-line message, exits
    non-zero, and neither audits nor writes. *Verified by* the two `--design` cases.
18. `init` syncs the root and every package in one pass, and on a per-file failure logs the path,
    prints the distinct summary line, and still exits 0. *Verified by* the `init` cases.
19. `doctor` reports stale blocks in the existing `CLAUDE.md block` check's message without changing
    its status and without writing, and the doctor check count stays at 24. *Verified by* the doctor
    cases.
20. `pnpm run qa` passes at the repo root with zero new lint findings, including sonarjs
    cognitive-complexity ≤ 15 on `detectPackageType` and the `--fix` branch.

## 9. Verification steps (executor runs these at the end)

```bash
cd /Users/arthur/projects/infra-kit

# Targeted suites first — rtk/turbo filtering can swallow a non-zero code, so gate explicitly.
pnpm --filter infra-kit exec vitest run src/lib/agent-guidance src/commands/audit src/commands/init src/commands/doctor src/lib/package-validator ; echo EXIT=$?

# Full gate. NOTE: a full `qa` run rewrites package manifests and the vendor mirror —
# shasum the manifests before and after and diff before committing.
find . -name package.json -not -path '*/node_modules/*' -exec shasum {} \; | sort > /tmp/pkg-before.txt
pnpm run qa ; echo EXIT=$?
find . -name package.json -not -path '*/node_modules/*' -exec shasum {} \; | sort > /tmp/pkg-after.txt
diff /tmp/pkg-before.txt /tmp/pkg-after.txt ; echo DIFF_EXIT=$?

# Cold lint. `./src` matches the package's own gate (`eslint --cache --quiet ... ./src`);
# linting the package root instead would check a different tree.
pnpm --filter infra-kit exec eslint --no-cache ./src ; echo EXIT=$?
git status --short   # no stray '??' files

# Dogfood against this repo, from a built CLI.
pnpm --filter infra-kit run build ; echo EXIT=$?
node apps/infra-kit/cli/dist/cli.js audit --all ; echo EXIT=$?              # pre-adoption, expect 0
# NO adoption-flip line here: all six packages are unadopted, so `--fix --all` writes every one
# and leaves none behind. That line is for a SCOPED fix that flips an otherwise-unadopted workspace.
node apps/infra-kit/cli/dist/cli.js audit --fix --all ; echo EXIT=$?        # expect 0, six files created
node apps/infra-kit/cli/dist/cli.js audit --fix --root ; echo EXIT=$?
node apps/infra-kit/cli/dist/cli.js audit --all ; echo EXIT=$?              # post-adoption, expect 0
node apps/infra-kit/cli/dist/cli.js audit --root ; echo EXIT=$?             # expect 0
node apps/infra-kit/cli/dist/cli.js doctor ; echo EXIT=$?
# Review every generated file. `git diff --stat` shows NOTHING here — the files are untracked.
git status --short
git diff

# The per-package shape, from inside a package — the path turbo runs as `infra-kit-check`,
# and the only one that exercises the findWorkspaceRoot walk.
(cd apps/infra-kit/config && node ../../../apps/infra-kit/cli/dist/cli.js audit) ; echo EXIT=$?

# Re-run the full gate AFTER the dogfood write: this is the only way this repo exercises its
# own post-adoption `infra-kit-check` across all six packages. Same shasum guard as the first
# run — a full `qa` rewrites manifests and the vendor mirror, and the earlier "after" snapshot
# was taken before this run existed.
find . -name package.json -not -path '*/node_modules/*' -exec shasum {} \; | sort > /tmp/pkg-before-2.txt
pnpm run qa ; echo EXIT=$?
find . -name package.json -not -path '*/node_modules/*' -exec shasum {} \; | sort > /tmp/pkg-after-2.txt
diff /tmp/pkg-before-2.txt /tmp/pkg-after-2.txt ; echo DIFF_EXIT=$?
```

That final `qa` is meaningful only because `node_modules/infra-kit` is a symlink to
`apps/infra-kit/cli`, so `pnpm exec infra-kit` inside this repo resolves to the workspace build rather
than the global CLI — which means it exercises the new code **only if the build step above ran first**.

**The dogfood run exercises one body of five.** This repo's six discovered packages are
`apps/infra-kit/{cli,config,eslint-plugin,vite}` and `packages/{linter-spec,serverless-config}`. None
matches `apps/*/ui`, `apps/*/api`, `apps/*/tests`, or a `mobile-app` basename, so **all six detect as
`lib`**. Type selection across the other four bodies is covered only by fixtures. With `--check` gone
there is no dry-run table, so in a consumer the confidence gate is the git diff of the rollout branch:
run `--fix --all` on a branch, read every path→type pairing in the fix output, and only then commit.

Two notes for whoever runs this: each `pnpm exec` in the consumer repos pays a roughly 10-second
lockfile verify-deps preamble, so a slow step is not a hang. And `lock.test` and
`portless-driver.test` flake under full-suite load and pass in isolation — re-run a failing file
alone before calling it a regression.

## 10. ADR

**Decision.** Per-package `CLAUDE.md` files carrying a distinctly-marked, type-selected managed block
generated from a CLI-side registry; written by `infra-kit audit --fix` (a CLI-only flag, unreachable
from MCP by construction), refreshed repo-wide by `init`, reported on by `doctor`, and validated by a
structural `audit` check that passes every state with an advisory until the workspace has adopted the
feature and fails every structural defect afterwards — adoption inferred from working-tree state, with
no config key anywhere. The repo root is excluded from that check.

**Drivers.** (1) A silently self-updating global CLI must never change a consumer's CI verdict.
(2) The MCP boundary auto-confirms every call, so a mutating flag must be unreachable from it.
(3) No consumer declares a package type today and none can until both a config release and a CLI
release are in use. (4) 27–36 new files plus potential backups per repo is a real review-noise cost.

**Alternatives considered.** *For the writer:* a new top-level `agent-sync` command — **rejected by
user decision** (2026-09-05); it was this plan's choice through v5 and worked, but the user does not
want another command in the surface. `doctor --fix` — rejected, wrong domain: `doctor` fixes the
machine, not the repo's package content. `init` only — rejected: it also rewrites `~/.zshrc` and runs
config migrations, so there would be no way to fix a single package. *For enforcement:* body-equality
and always-on structural checks (rejected: both redden consumer CI from a release); an
`agentGuidance.enforce` key in root `infra-kit.json` (rejected: a `.strict()`, throw-on-unknown schema
means the rollout commit bricks every command on any older CLI, and a "flip it later" boolean rots
exactly as the TEMPORARY `requiredFiles: []` overrides did); a purely presence-based predicate (kept
as the documented fallback: it drops the user's "must exist" requirement and buying it back costs 63
hand edits). *For the file layout:* `.claude/rules/` with `paths:` frontmatter (rejected for v1:
Claude Code-only, invisible from the package directory, and it relocates the type problem — kept as an
additive follow-up). *For type:* a required `type` key (rejected: nothing works until 63 files are
edited). *For backups:* always-backup for package files (rejected on noise) and never-backup
(rejected on safety).

**Why chosen.** It is the only combination where the feature works against both consumer repos
untouched, adoption is a single reviewed commit rather than a surprise from an auto-update, nothing
committed can brick an older CLI, the user's "must exist in every package" requirement survives, and
the writer adds no command to a surface the user wants to keep small.

**Consequences.** Two marker pairs to maintain. A per-package `audit` now consults workspace-wide
state (one workspace-file parse, a `readdir` fan-out, then ≤ 63 stats per invocation, paid once per
turbo task; unmeasurable against the ~10 s `pnpm exec` preamble). Adoption is working-tree state, so
`git checkout` can change the verdict, an uncommitted fix adopts locally, one hand-pasted marker pair
adopts the whole workspace, and **a `--fix` in one package adopts it too** — mitigated by a printed
line, not suppressed. The Principle 1 guarantee is absolute only while unadopted: post-adoption, a
release that widened `discoverPackages` would redden an adopted consumer. A marker change is
self-healing, but only because every state passes before adoption — that rule is load-bearing and
must not be "simplified" away. A body-text change does not propagate until `init` or `audit --fix`
runs, so blocks will drift — visibly, through `doctor` and the version line, never as a CI failure.
The `type` key adds a field to a published package's public API, cannot be removed casually, and
carries a hard ordering precondition, which is the one place Principle 6 rests on process rather than
construction. `init` now writes up to 37 files instead of one, and that write is itself an adoption
event. `audit` gains two flags and a conditional `structuredContent` field, and its MCP contract is
now defended by tests rather than by the absence of a mutating code path.

**Follow-ups.** A `--check`-style drift gate for infra-kit's own CI — deliberately not shipped here,
because a body-drift signal one flag away from the command consumers run in `qa` is the exact hazard
Principle 1 exists to prevent; if it lands, it should be a separate non-MCP command or an env-gated
mode. Optional `.claude/rules/<type>.md` emission from the same registry. `DESIGN.md` required for
frontend packages once consumers have real content. A per-package opt-out if one is ever needed. Fix
the `readme.md` vs `README.md` case mismatch in `DEFAULT_RULES` before any consumer stops overriding
`requiredFiles` on a case-sensitive CI filesystem.

## 11. Out of scope

- Authoring real `DESIGN.md` content — brand-specific and human-owned; only the skeleton is generated.
- **Creating missing `README.md` files.** The user's "CLAUDE.md together with README.md" is read as
  *co-located with*, not *co-created with*: infra-kit can no more author a package README than it can
  author its DESIGN.md. The body's README bullet is conditional so no generated text ever points at a
  file that is not there.
- Changing `audit`'s MCP input or output schema, its catalog entry, or adding a severity/warn status.
- A dry-run or drift-check mode (`--check`, `--dry-run`) — recorded as a follow-up in §10.
- **`vendor/` directories.** `discoverPackages` filters patterns by `!pattern.startsWith('vendor')`,
  so `vendor/packages/*` and `vendor/configs/*` are never expanded and `audit --fix --all` cannot
  write into the frozen mirrors. Correct by construction today, and load-bearing: a write there would
  redden `vendor check` in both consumers.
- **`.claude/CLAUDE.md`.** Both consumers have one, carrying an OMC block. `discoverPackages` cannot
  reach `.claude/`, and neither the fix path nor the audit check ever considers it.
- `.claude/rules/`, `.claude/skills/`, and agent files for tools other than CLAUDE.md.
- Adding infra-kit to consumer `devDependencies` — global/ambient resolution is the chosen model.
- Retrofitting the consumer repos' guidance content beyond the generated block.

## Revision log

- v2: Decision (i) now tables five options with the "must exist" consequence stated per option; option E (workspace adoption) chosen, C rejected, D kept as the fallback with an exact delta paragraph (Critic #1 / Architect #1, orchestrator ruling).
- v2: Added Principle 6 — a repo-config change must never brick an older CLI — and applied it to the rejection of C (Critic #5 / Architect A.1).
- v2: The repo root is excluded from the `agent-guidance` check via an explicit `isRoot` flag, with an `audit --root` regression test, because `resolveTargets` routes the root through the same `validatePackage` (Critic #2 / Architect #2).
- v2: Dropped the `agentGuidance` schema snippet entirely; recorded that `z.strict` is `undefined` in the installed zod, and stated that no `infraKitConfigObject` or `config-templates.ts` edit is needed under option E (Critic #3 and #11 / Architect #3 and #9).
- v2: Corrected the `type` back-compat claim — the CLI's own pinned `strictObject` governs, so an older CLI fails and blinds that package's checks — and added the ordering precondition to §3.7 and §5 (Critic #4 / Architect #4).
- v2: Pre-mortem expanded from three scenarios to six, adding the `audit --root` collision, a committed key meeting an older CLI, and 63 blocks going stale (Critic #6).
- v2: AC 4 restated as exact byte-identity on updates and trailing-newline normalization on first insertion, and `assertOutsideMarkersUnchanged` scoped to the replace path (Critic #7 / Architect #6).
- v2: `assertNotSymlink` hardened to `lstat` in a try/catch, with an explicit dangling-symlink test case (Critic #8 / Architect #7).
- v2: Deleted the false claim that `pnpm exec` would not resolve infra-kit in the consumer repos; kept the bare command in check messages and rejustified the rollout's absolute path on verification determinism (Critic #9 / Architect #8 ACCEPT-MODIFIED).
- v2: Added the propagation channel — `init` as the repo-wide refresh path and a read-only per-package staleness report in `doctor` (Critic #10 / Architect #10).
- v2: Corrected the fs-import note to the synchronous default `node:fs` and priced the promises rewrite out of scope (Critic #12 / Architect #11).
- v2: Made the body's `README.md` bullet conditional on the file existing and stated in §11 that infra-kit does not create missing READMEs (Critic #13).
- v2: Justified scoping git-aware backups to package files while the root keeps always-backup (Critic #14 / Architect #5).
- v2: Stated the `--all` scope asymmetry, single-sourced root resolution, noted that all six of this repo's packages detect as `lib`, corrected the cold-eslint path to `./src`, added the `pnpm exec` preamble note, and recorded `vendor/` and `.claude/CLAUDE.md` as out of scope (Critic #15 / Architect #12, E.7, E.9).
- v2: Added the alpha-spec caveat to the DESIGN.md decision and the `--check`-is-non-mutating note to the writer decision (Critic §2.4).
- v3: **Decision-level.** Before adoption every non-`ok` state now passes with an advisory naming that specific state; only after adoption do they fail. v2 failed three of them pre-adoption, which reddened a repo with hand-written package CLAUDE.md files and would have reddened every adopted consumer on a future marker change — Principle 1 violated outright (Critic #1).
- v3: Recorded self-healing on a marker change as a *consequence of* that rule rather than an intrinsic property of option E, and bounded "no CLI release can flip it" to the unadopted state, naming the `discoverPackages`-widening residual (Critic #6 / Architect #5 ACCEPT-MODIFIED).
- v3: "Working-tree state" replaces "committed repo state" throughout, with its consequences stated (Critic #5 / Architect #4).
- v3: Doctor staleness now extends the **existing** `CLAUDE.md block` check's message — no new check name, check count stays 24, the staleness dimension never changes status, and the shipped root-block-absent `fail` is preserved (Critic #2 and #4 / Architect #1 and #3).
- v3: `discoverPackages` wrapped in try/catch at both call sites so a missing or malformed `pnpm-workspace.yaml` degrades to "not adopted" instead of crashing `doctor()` (Critic #3 / Architect #2).
- v3: Per-file failure policy specified as continue-and-report, with a dedicated scenario and a mid-run-failure test (Critic #7 / Architect #6).
- v3: The post-adoption `missing` message appends the adopting evidence (Critic #8 / Architect #7).
- v3: `init` stated as an adoption event writing 27–36 files unconditionally, reconciled against Decision (iii) (Critic #9 / Architect #8).
- v3: Added the per-package cwd-shaped `audit` coverage in both adoption states, plus a post-dogfood `pnpm run qa` re-run in §9 (Critic #10).
- v3: Principle 6 now states that it holds by construction for root config and only by an ordering precondition for the `type` key (Critic #11 / Architect #9).
- v4: The adoption probe returns `AdoptionState` instead of a boolean, carried through `validatePackage` into `checkAgentGuidance`, so the post-adoption `missing` message can actually name the adopting package (Architect v3 #1).
- v4: `init`'s handling of per-file sync failures decided and written down — it logs the failed paths, leaves the exit code at 0, and continues its remaining steps (Architect v3 #2).
- v4: Recorded the `WriteAction` widening to include `'failed'` (Architect v3 #3).
- v4: Scoped the pre-adoption diagnosability claim — `logResults` prints only non-passing checks, so advisories surface in JSON/MCP output and through `doctor`, never in default CLI output (Architect v3 #4).
- v4: Fixed the "zero reads" cost bullet and switched §9's dogfood review to `git status --short` + `git diff` (Architect v3 #5).
- v5: The exit-code line now says 0 only for a run with no per-file failures (Critic v4 #1).
- v5: Check messages switched to package-relative in the house style; `AdoptionState` carries `workspaceRoot` in both variants so the adopting-evidence path is producible (Critic v4 #2).
- v5: An absent `adoption` option means the unadopted variant, which keeps the eight existing no-options `validatePackage` call sites green (Critic v4 #3).
- v5: Named the deep import path `src/lib/package-validator/loader` for `discoverPackages` and made `AdoptionState` an `import type`, avoiding a runtime cycle through the checks barrel (Critic v4 #4).
- v5: Wrapped §9's second `pnpm run qa` in its own manifest-shasum guard, and recorded the `node_modules/infra-kit` symlink (Critic v4 #5).
- v5: `init` must print a distinct failed-file summary line (Critic v4 #6).
- v6: **USER DECISION (2026-09-05) — no new command.** The writer is now `infra-kit audit --fix`, a CLI-only flag on the existing command. `commands/agent-sync/` is gone from §3.1 and §4; its tests move to `commands/audit/__tests__/audit-fix.test.ts`; `lib/agent-guidance/` is unchanged. Decision (iii) is rewritten around the user's choice, with `doctor --fix` and `init`-only recorded as the rejected alternatives and the `agent-sync` command marked rejected-by-user.
- v6: MCP safety is now by construction rather than by the absence of a mutating path — `auditInputSchema` stays `{all, root}`, the handler forwards only those, the catalog entry stays `mutating: false`, `outputSchema` is unchanged, and `fixed[]` is added to `structuredContent` only on a fix run. Three tests pin it; Principle 2 is restated as "the MCP surface never mutates"; a new pre-mortem scenario covers it.
- v6: `--fix` runs the sync before the checks and the exit code reflects the post-fix audit, plus a non-zero exit whenever a fix write failed — without that second clause a pre-adoption write failure would exit 0, since `missing` passes before adoption.
- v6: The `--all` asymmetry is **removed**: `--fix --all` covers packages only, exactly like `audit --all`, so the rollout needs `--fix --all` and `--fix --root` (or `init`). §3.7, §5 step 4 and §9 updated.
- v6: New consequence recorded in Decision (i), §3.5, pre-mortem scenario 4 and the ADR — a `--fix` in one package of an unadopted workspace adopts the whole workspace, so a flipping run prints `workspace adopted — every other package now needs a CLAUDE.md: run infra-kit audit --fix --all`, pinned by its own test.
- v6: Dropped `--check`, `--dry-run`, `--backup` and `--no-backup`. The backup policy is unchanged but no longer user-selectable; a drift gate for infra-kit's own CI is recorded as a follow-up, and §9 plus scenario 6 now name the rollout git diff as the detection-review gate that `--check` used to provide.
- v6: `init` calls the shared `lib/agent-guidance` sync directly rather than shelling to `audit`; all check messages, the doctor staleness message and the root body's Commands line updated to `infra-kit audit --fix` (doctor's root-block failure keeps `Run: infra-kit init`).
- v7: Named the carrier for the fix-write-failure exit code. `audit()` keeps its "never sets an exit code so the MCP tool can reuse it" invariant and only reports `fixed[]` entries with `action: 'failed'`; the `audit` action in `program.ts` widens its `allPassed`-only gate to fire on those entries too. §3.6 gains the snippet and the rejected alternative (folding failures into `allPassed`, which would redefine a field the MCP `outputSchema` documents), the `audit.ts` and `program.ts` rows are corrected, AC 13 is restated, the fix test now asserts on `structuredContent`, and a program-level exit-code test is added (Architect v6 #1).
- v7: Corrected §9's dogfood comment on the `--fix --all` step. This repo's six packages are all unadopted, so a full `--all` run leaves none behind and prints **no** adoption-flip line — that line is for a scoped fix that flips an otherwise-unadopted workspace, which is what §3.5, AC 10 and the fix test already say. The observability paragraph is scoped the same way (Architect v6 #2).
- v8: §7's e2e sequence no longer expects an adoption-flip line on the `--fix --all` fixture step — that run writes all four packages and leaves none behind, which is the case §3.5, AC 10, the fix test and §9 already said does not print it. The flip line is exercised by the scoped-fix case instead (Critic v7 #1).
- v8: Required a `doctor`-style comment above `auditMcpTool`'s handler, and recorded in §4's `audit.ts` row and Decision (iii) that the catalog's `mutating: false` stays accurate **only** while the handler forwards `params.all`/`params.root` by field. `mutating` feeds `command-catalog.test.ts`'s fail-closed ungated-mutating gate, so a future `handler: audit` or a `fix` key in the input schema would defeat the barrier while that gate stayed green (Critic v7 #2).
- v8: `fixed` is declared optional on `audit()`'s return type (`fixed?: Array<{path, action, type}>`), since it is only populated on a fix run and `program.ts`'s destructure would otherwise not compile; the `(fixed ?? [])` guard covers only the runtime (Critic v7 #3).
- v8: `--design` without `--fix` is now specified as an **error** — one line, non-zero exit, no audit, no writes — rather than "the parser says so", since Commander has no native flag dependency and a warning above a green audit reads as success. Added as the second `--design` test case, giving AC 17's "only with `--fix`" clause a verifier (Critic v7 #4).
- v9 (execution, dogfood finding): **`aws-lambda` / `@types/aws-lambda` dropped from the backend dependency signals; only `serverless` remains.** Measured on both consumers during the dogfood step: every consumer backend lives at `apps/<app>/api` (row 2 fires first) and carries only `@types/aws-lambda`; the only packages the lambda signals actually caught were libraries — `packages/lib-core` in hulyo (`aws-lambda` + types) and travelist (types), and this repo's `apps/infra-kit/cli` (types), which the first dogfood run classified `backend`. So the signal added zero coverage and three misdetections. Same principle as "`react` alone never means frontend". §3.2 table updated; `package-type.test.ts` now pins `aws-lambda alone → lib` and `@types/aws-lambda alone → lib`.
