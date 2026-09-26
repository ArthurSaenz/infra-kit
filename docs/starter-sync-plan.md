# Plan: move the starter sync into infra-kit as `ik vendor sync`

**Status: pending approval** · RALPLAN-DR, deliberate mode · 2026-09-23

Consensus: Planner/Architect/Critic approved after 3 iterations on 2026-09-23

## 1. Summary

Replace `starter-workspace/scripts/copy-shared-repos-data.mjs` (568 lines, run by hand as `node scripts/…`) with
one human-only infra-kit command, **`ik vendor sync`**. It runs only inside a repo whose committed
`infra-kit.json` carries a `vendorSource` block. That block is absent (read as `null`) everywhere else, so the
command refuses in every consumer repo. The copy list moves out of the script and into that block, versioned
with the starter itself. The machine-local `~/.infra-kit/vendor.json` keeps what it holds today: where repos are
cloned and which ones are targets.

One invocation, from the starter root, in a real terminal:

```
ik vendor sync            # preview: per-target plan + drift + starter commits since the last sync
ik vendor sync --yes      # execute
```

### Assumptions (the request was a lossy voice transcript, translated)

| # | What was said | How this plan reads it |
|---|---|---|
| A1 | "move the starter-kit system into infra-kit" | A new CLI command replaces the starter script. The starter repo stays the content source; it is not moved. |
| A2 | "only through the CLI, not in the skills" | Human-only: refused under agent mode even with `--yes`, and the apply step requires an interactive terminal. No SKILL.md names it or grants it. |
| A3 | "only when infra-kit has a config for it, default `null`" | A new optional key in `infra-kit.json`, absent or `null` by default. Without it the command refuses with a message naming the key. |
| A4 | "checks that git is clean in the source repo" | Hard refusal when the starter working tree has any tracked change or untracked file. |
| A5 | "very easy to run" | Zero required arguments, preview then `--yes`, same shape as `release create` and `worktrees add`. |
| A6 | "propose cool features" | Section 7 lists ten candidates; three are in scope. |

## 2. Evidence the design rests on

| Fact | Where |
|---|---|
| The script reads targets from `~/.infra-kit/vendor.json`, hard-codes the source name `starter-workspace`, and holds the copy list in code | `starter-workspace/scripts/copy-shared-repos-data.mjs:14-35,96-234` |
| Directories are copied with `rm -rf` then `rsync -a` of the **working tree**, built by string interpolation into `exec` | same file `:262-285` |
| The working-tree copy leaks ignored files today: `.claude/scheduled_tasks.lock` is git-ignored in the starter and is not in `EXCLUDED_PATTERNS`, so every run copies it into six repos | `git status --ignored .claude` in the starter |
| Consumers hold ignored build output under synced directories (`node_modules/`, `dist/`, `.turbo/` under `vendor/configs/*`); `git status --porcelain` never shows them, and losing `eslint-config/dist` breaks consumer lint | Architect finding, hulyo and travelist working trees |
| The starter tracks one symlink under a synced path, `.claude/skills/shadcn` → `../../.agents/skills/shadcn` | `git ls-files -s .claude` mode `120000` |
| The starter tracks 10 executable files under `.claude/`, 7 of them hooks | `git ls-files -s .claude` mode `100755` |
| The starter is on a feature branch (`chore/backend-nodenext-imports`), so a sync right now would stamp an unmerged sha into every manifest | `git status --branch` in the starter |
| infra-kit's own `vendor/` manifest is 5 starter commits behind starter HEAD | `vendor/.sync-manifest.json` commit `b41e55b` |
| `writeManifest` has the shape `vendor check` reads, plus `schemaVersion`; it has zero production callers; it hashes `walkVendorTree` over the working tree | `src/lib/vendor/manifest.ts:118`, `walk.ts:29` |
| `getInfraKitConfig` defaults to `autoMigrate: 'write'`, which may rewrite a layer on disk | `infra-kit-config.ts:521` |
| The catalog test fails any `mutating: true` row that lacks `requiresHumanConfirm` and is not on `LOW_RISK_MUTATING_ALLOWLIST`; `release-deliver` passes only through a vestigial tool object | `command-catalog.test.ts:272-274`, `gh-release-deliver.ts:475` |
| `INFRA_KIT_AGENT=0` suppresses the `CLAUDECODE` heuristic, so only `--agent` or `INFRA_KIT_AGENT=1` mark agent mode for sure | `agent-mode.ts:68-78` |
| `release deliver` refuses agent mode with a `StructuredRefusalError` before any work | `gh-release-deliver.ts:408-414` |
| `confirmOrExit` refuses headless runs without `--yes`, and takes `throwOnDecline` so a decline throws instead of calling `process.exit(0)` | `confirm-or-exit.ts:88-118` |
| A layer-1-only key has a precedent: `mcp` is refused in every non-required layer | `infra-kit-config.ts:774` |
| A global `-C <dir>` option chdirs before every action | `program.ts:421-425` |
| The shared run report has six statuses (`ok changed skipped manual warn fail`) and a pure formatter | `src/lib/render/run-report.ts` |
| infra-kit keeps an older divergent fork of the script with its own hard-coded target list | `infra-kit/scripts/copy-shared-repos-data.mjs:11` |

`infraKitConfigObject` is the schema for the runtime `infra-kit.json`, at
`apps/infra-kit/cli/src/lib/infra-kit-config/infra-kit-config.ts:256`. The audit config (`infra-kit.config.ts`)
is `defineConfig` from the separately published `@slip-stream-kit/config` package.

## 3. Principles

1. **The starter's commit is the content.** What lands in a consumer, and what its manifest records, is exactly
   the git-tracked tree at the sha written into that manifest. Nothing ignored, untracked, or uncommitted can
   travel or be recorded.
2. **Never destroy what git cannot give back.** The sync writes and deletes only paths git tracks, in the source
   or the target. Ignored files in the target, such as `node_modules/`, `dist/` and `.turbo/`, are never touched.
   A tracked target path is only changed when it is clean, so `git restore` is always the rollback.
3. **One source of truth per fact.** The copy list lives with the content it describes, in the starter. Clone
   locations and target names live with the machine, in `vendor.json`. Hash and skip rules stay in `lib/vendor`.
4. **Human-only is enforced as far as a process can tell.** The command refuses when agent mode is declared, and
   the apply step refuses without an interactive terminal on stdin. A process cannot prove a human is present;
   the TTY requirement is the strongest check available, and a test fails if a skill ever names the command.
5. **Preview is the product.** The no-flag run must answer "what will change, where, and since which starter
   commit" before anyone types `--yes`, and it must leave every repo byte-identical.

## 4. Decision drivers

1. **Safety of six consumer repos.** The current script deletes and recopies `.claude/` and `vendor/` without
   looking at the target's git state, and copies ignored junk from the source.
2. **The gate must be impossible to satisfy by accident.** A consumer, or a machine-wide config layer, must never
   become a sync source.
3. **Release-order cost.** The runtime schema is `.strict()`. Whichever config file gains the key, an old global
   CLI will reject it, and the audit package has a history of painful lockstep publishes.

## 5. Options

### Where the config key lives

| Option | Pros | Cons |
|---|---|---|
| **A. `vendorSource` in the source repo's committed `infra-kit.json` (layer 1 only)** | It is what the user asked for: an infra-kit config parameter, null by default. Versioned with the content it describes, so the manifest sha also pins the copy list. Consumers never have it. The layer-1-only refusal has a precedent (`mcp`). Ships inside the CLI package alone. | Adds the first sizeable non-runtime block to the runtime file. The starter's `infra-kit.json` is unreadable by any CLI older than the release that adds the key. |
| B. Key in `infra-kit.config.ts` (audit config) | Typed TS, already committed in every repo | Lives in `@slip-stream-kit/config`, a second published package with a known lockstep and 404 history. It is audit rules, and executing TS to decide a copy list is heavier than JSON. |
| C. Copy list in machine-local `~/.infra-kit/vendor.json` | No schema change in a committed file | The list would drift from the starter commit it describes, so the manifest sha would lie. It cannot express "only the source repo may run this". |
| D. A dedicated committed `vendor-source.json` in the source repo | Keeps the runtime schema free of a non-runtime block; no release-order coupling | Not what the user asked for. They named an infra-kit config parameter that defaults to `null`, and a file whose presence is the gate has no null default. |

**Option B is invalidated** by driver 3. **Option C is invalidated** by driver 2 and principle 3; it survives in
its current, narrower role for `workspaceDir` and `targets`. **Option D is invalidated on user intent**, not on
technical grounds.

### Command name

| Option | Pros | Cons |
|---|---|---|
| **`ik vendor sync`** | Sits next to `vendor check`, which reads the manifest this command writes. The palette group, catalog group and `skip-sets.ts` comment already expect it. | Nested under a group, against the house preference for top-level names. |
| `ik starter-sync` or `ik sync` | Top-level per the house rule | `sync` alone is ambiguous next to `worktrees sync`. A second vendor-adjacent top-level name splits one feature across two menu groups. |

The house rule is against **creating** new `xCmd` groups. The `vendor` group already exists with two members, so
adding a third is consistent with it. Recommend `ik vendor sync`.

## 6. Recommended design

### 6.1 Config: `vendorSource` in `infra-kit.json`

Added to `infraKitConfigObject` as `vendorSourceSchema.nullable().optional()`. No `.default()` anywhere inside it,
because `.partial()` keeps a `ZodDefault` and would inject values through the always-present layer 3.

```jsonc
// starter-workspace/infra-kit.json
"vendorSource": {
  "copy": [
    { "path": ".claude" },
    { "path": ".cursor/mcp.json" },
    { "path": ".mcp.json" },
    { "path": ".cursor/rules" },
    { "path": "vendor/packages/web-toolkit" },
    { "path": ".vscode/extensions.json" },
    { "path": ".vscode/global.code-snippets" },
    { "path": ".vscode/settings.json" },
    { "path": ".prettierrc.mjs" },
    { "path": ".prettierignore" },
    { "path": ".gitignore" },
    { "path": ".editorconfig" },
    { "path": "vitest.config.ts" },
    { "path": "skills-lock.json" },
    { "path": ".agents" },
    { "path": "turbo.json" },
    { "path": "vendor/configs" },
    { "path": "vendor/packages/docs-ui" }
  ],
  "exclude": ["serverless-config"],
  "legacyCleanup": ["packages/web-toolkit", "configs"]
}
```

Schema rules, all `.strict()`:

- `copy[]`: `{ path: string, target?: string }`, min 1. Every entry in today's script has `target === source`,
  so `target` is optional and resolved at the read site. An entry is **vendored** when its target starts with
  `vendor/`, which replaces the `vendored` flag. Paths must be relative, must not contain `..`, and must not be
  `.git` or start with it.
- `exclude[]`: path-segment names dropped from **both** sides of the diff (6.4). It shrinks from 14 entries to 1,
  because `node_modules`, `dist`, `.turbo` and the rest are never tracked.
- `legacyCleanup[]`: tracked target paths removed before copying, only when clean.
- Absent and `null` mean the same thing: this repo is not a source.

The key is **layer-1 only**. `loadLayer` refuses it in every non-required layer, meaning
`~/.infra-kit/infra-kit.json` and `~/.infra-kit/projects/<repo>/infra-kit.json`, beside the existing `mcp` check
at `infra-kit-config.ts:774`. A machine-wide layer carrying it would turn every repo on the machine into a source.

No migration is needed, because nothing is renamed or retired. The generated config templates do not emit the
key: absent already means `null` (open question Q3).

### 6.2 Argv

```
ik vendor sync [targets...] [--yes] [--check] [--commit] [--manifest-only]
```

| Argument | Meaning | Replaces |
|---|---|---|
| `[targets...]` | Narrow to these target names from `vendor.json`. An unknown name is a refusal listing the valid names, not a warning. | `--repos=a,b` |
| `--yes` | Execute the previewed plan. Requires a TTY on stdin (6.3 step 7). | new |
| `--check` | Preview only, exit 1 if any target would change. For scripts; the plain preview exits 0. | `--check`, now covering every copy entry |
| `--commit` | After a target syncs, commit exactly the synced paths in that target (7.2) | new |
| `--manifest-only` | Rewrite `vendor/.sync-manifest.json` and `vendor/README.md` from the target's tracked `vendor/` files, no copy. Still preview-then-`--yes`. | `--manifest-only` |

`--no-clean` is dropped: emptying `legacyCleanup` in the starter does the same thing. `-C <dir>` already works
globally, so `ik -C ~/projects/starter-workspace vendor sync` runs from anywhere.

### 6.3 Execution order

1. **Agent refusal.** `isAgentMode()` throws a `StructuredRefusalError` with `status: 'refused'`, exit 2, before
   reading any config. This is the `release deliver` code path. It catches `--agent`, `INFRA_KIT_AGENT=1`, and a
   Claude Code shell with non-TTY stdin. It does **not** catch `INFRA_KIT_AGENT=0` from an agent's Bash, which
   clears the heuristic (`agent-mode.ts:68-78`); step 7 closes that path for the apply.
2. **Source preflight, before any config read.** Against the source repo root (`getProjectRoot()`):
   - `git status --porcelain --untracked-files=normal` must be empty. Otherwise refuse and list the first 20
     paths. Ignored files do not count, because they never travel (6.4).
   - `warn` row when HEAD is not reachable from any `origin/*` ref: consumers will record a sha nobody else can
     resolve.
   - `warn` row when HEAD is not on the origin default branch, which is the starter's current state.
3. **Config gate.** Read the merged config with `getInfraKitConfig({ autoMigrate: 'off' })`. The default `'write'`
   mode can rewrite the tracked `infra-kit.json` during a migration, which would dirty the source after the clean
   check passed. With `'off'`, a config that needs migrating fails as it does today and the user runs
   `ik setup` first. If `vendorSource` is absent or `null`, fail with: this repo is not a vendor source; the
   command runs only in a repo whose `infra-kit.json` has a `vendorSource` block. Exit 1.
4. **Factory config.** `loadFactoryConfig()`; its existing error already points at `vendor config --init`.
5. **Per-target plan**, a pure function over probed facts. Each target lands in one row:
   - `skipped`: not checked out under `workspaceDir`, or it resolves to the source repo itself.
   - `fail` (blocked): not a git repo, or any **tracked** path under a copy entry or legacy path has changes, or
     an untracked, non-ignored file sits there. The row's notes list the paths and the `git status` argv.
   - `ok`: the diff (6.4) is empty.
   - `changed`: will be written. The row shows added, modified and removed file counts per copy entry, and the
     starter commits since the target's manifest sha (7.3).
6. **Confirm gate.** `confirmOrExit(options.yes, …, { plan, throwOnDecline: true })`. The plan is the structured
   per-target object, so `--json` gets it too. `throwOnDecline` keeps a decline from calling `process.exit(0)`,
   which would skip every `finally`. `--check` returns before this step.
7. **TTY gate for the apply.** Before writing anything, require `process.stdin.isTTY`. Otherwise refuse, exit 2:
   run `ik vendor sync --yes` from a real terminal. Claude Code's `!` prefix is non-TTY, so it is refused too. The
   preview stays available without a TTY, because it writes nothing.
8. **Apply**, target by target, skipping blocked ones:
   1. **Before writing anything to this target**, print its recovery argv to stderr (below). A Ctrl-C mid-apply
      then leaves the fix on screen, although there is no SIGINT handler (follow-up F7).
   2. Remove the tracked legacy paths.
   3. Diff-apply each copy entry (6.4).
   4. If any vendored entry exists, write `vendor/README.md` with text naming `ik vendor sync`. Then write the
      manifest over the source set plus the target's tracked `vendor/` paths minus the apply's delete set,
      hashed from disk (6.4). `source` is the basename of `getMainRepoRoot()` of the source, so a
      run under `-C` from a linked starter worktree still records `starter-workspace`. `commit` is the source
      HEAD sha.
   5. With `--commit`, commit per 7.2.
9. **Report.** One `printRunReport` with a section per target, then exit 1 if any row is `fail`.

A failure in step 8 for one target marks that row `fail`, repeats the recovery argv as notes, and moves on to the
next target. Recovery is always possible because step 5 proved every tracked path it touches was clean, and the
apply never touches ignored files. The recovery argv restores tracked paths only:

```
git -C <target> --literal-pathspecs checkout HEAD -- <tracked paths the plan will write or delete>
```

It recovers every modified or deleted tracked file. A file the sync newly created stays behind as an untracked
file; `git status` shows it, and the user removes it by hand. The CLI never prints or runs `git clean`. The
consumer's own untracked files can sit under a synced directory outside the paths the preflight guards, and a
`git clean` deletes them unrecoverably, while a checkout loses nothing.

### 6.4 How files are copied: diff-apply over tracked sets

For each copy entry, two sets of relative paths are computed:

- **Source set**: `git ls-files -z -- <path>` in the source repo, minus any path with an `exclude` segment.
- **Target set**: `git ls-files -z -- <target path>` in the target repo, minus any path with an `exclude`
  segment.

Excludes apply on both sides. Otherwise a consumer's own tracked `packages/serverless-config`, which lives under
a synced directory, would be deleted as stale.

The apply then does three things:

1. **Write** each source-set file whose bytes, mode or link target differ from the target's file. Files already
   identical are not touched, so their mtimes stay and watchers do not fire.
2. **Delete** each target-set path absent from the source set. Only tracked files can be deleted this way.
3. **Never touch** anything else. Ignored and untracked files under the target directory survive, including
   `node_modules/`, `dist/` and `.turbo/`.

Since the source tree is clean, each source file's working-tree bytes equal its bytes at HEAD, so the manifest
sha is truthful. Ignored source files such as `scheduled_tasks.lock` never enter the source set.

The copy is done in Node with `fs` calls, not a shell `rsync`. The file list is already exact, and the script's
string-built `exec` calls break on paths with quotes. Details:

- **Modes.** Mode `100755` in `git ls-files -s` is written with `0o755`, everything else `0o644`.
- **Symlinks.** Mode `120000` is recreated with `fs.symlink(readlink(source))`, the link text unchanged. The link
  is copied as a link and never followed, so the result does not depend on whether `.agents` is written before
  `.claude`. A target file where a link should be, or the reverse, is replaced.
- **Directories left empty** by a delete are removed only when git tracks nothing in them and the filesystem
  holds nothing else, including ignored files.

**The manifest covers every tracked file under the target's `vendor/`, not a working-tree walk.** After the
apply, its path set is the union of two sets, filtered through `isSkippedPath`:

- the source-set paths of every vendored entry, rebased under `vendor/`, plus `README.md`;
- the target's surviving tracked `vendor/` paths: `git --literal-pathspecs ls-files -z -- vendor` **minus the
  apply's delete set**. These are files the consumer owns, such as a tracked `vendor/configs/serverless-config`,
  which the exclude rule protects from deletion. The subtraction is required because `ls-files` reads the index.
  Without `--commit`, a path the apply just deleted is still listed there, so hashing it would throw on the
  missing file, and a fresh clone would report it as `removed`.

The consumer-owned half is required. `compareToManifest` (`manifest.ts:133`) walks the whole target `vendor/`
and reports any file missing from the manifest as `added`, and `vendor check` treats `added` as drift. A
manifest holding only the source set would turn consumer CI red for every consumer-owned tracked file.

Every entry is hashed **from disk after the apply**, not from written bytes, because diff-apply skips identical
files. Hashing uses `sha256` from `hash.ts`, which reads through `readFileSync` and so follows symlinks, the same
way the read path hashes. `writeManifest` gains an optional `paths` parameter that replaces its working-tree walk.
`--manifest-only` passes the same union, which for it is just the target's `git ls-files vendor`.

A working-tree walk records whatever ignored file happens to sit in `vendor/`, and a fresh clone reads that entry
as "removed". `MANIFEST_SKIP_DIRS` already skips `.omc`, `node_modules`, `dist` and `.turbo`, so those are not
today's leak. Any other ignored path is, for example `coverage/`, `.env.local` or `storybook-static/`. Building
the manifest from tracked paths closes the whole class instead of growing the skip list.

**Pathspecs are literal.** Every git call that takes a path runs with `--literal-pathspecs`, and `add` and
`commit` receive their paths through `--pathspec-from-file=- --pathspec-file-nul` on stdin. A name such as
`routes/[id].tsx` would otherwise be read as a glob, and a large `.claude` diff would otherwise risk the argv
length limit.

### 6.5 Catalog, program wiring, guidance

- `program.ts`: `configureVendorSync(vendorCmd.command('sync'))`, next to `check` and `config`. The group
  description becomes "Mirror and verify the vendored starter files".
- **New catalog field `humanOnly?: true`.** The destructive-op invariant in `command-catalog.test.ts:272-274`
  accepts a mutating row when it has `requiresHumanConfirm`, **or `humanOnly: true`**, or sits on
  `LOW_RISK_MUTATING_ALLOWLIST`. The field's doc says it means "refused under agent mode even with `--yes`".
- Catalog row: `cliName: 'vendor-sync'`, `menuGroup: 'vendor'`, `mcpTool: null`, `mcpExposed: false`,
  `mutating: true`, `humanOnly: true`, `groupPath: ['vendor', 'sync']`. There is no allowlist entry and no
  vestigial tool object.
- `release-deliver` also gets `humanOnly: true`, so the new test covers the command that inspired the field. Its
  vestigial `defineMcpTool` stays for now; removing it is follow-up F4.
- **New test:** it enumerates `commandCatalog.filter((entry) => entry.humanOnly)`, not a hand-written list. Each
  row runs in-process with `--agent --yes` plus every argument it needs to get past argument resolution, such as
  `--version` for `release deliver`. The test asserts the refusal payload: `status: 'refused'` and the human-only
  reason, not exit 2 alone. `release-deliver` resolves its arguments before its agent check
  (`gh-release-deliver.ts:382-408`), so without a version it exits 2 through `argument_required`. An exit-code
  assertion would then pass for the wrong reason.
- Palette: a bare pick runs the preview, which is safe. The confirm prompt and the TTY gate follow.
- Skills: no SKILL.md mentions it. A new test scans `plugins/infra-kit/skills/**/SKILL.md` for `vendor sync` and
  fails on any hit.
- The generated root CLAUDE.md block leaves it out of the command list. The sentence "`release deliver` is
  human-only and is refused under agent mode" is extended to name `vendor sync`.

### 6.6 What happens to the scripts

- `starter-workspace/scripts/copy-shared-repos-data.mjs` is deleted in the same starter commit that adds
  `vendorSource`. The starter gains `"vendor:sync": "infra-kit vendor sync"` in `package.json`.
- `infra-kit/scripts/copy-shared-repos-data.mjs`, the stale fork, is deleted in its own `[ROOT]` commit. It is
  referenced only by `vendor/README.md`, which the next sync rewrites, and by an archived plan.

### 6.7 Release order

The strict schema forces this order. A starter commit adding `vendorSource` before the global CLI knows the key
would make every `ik` command in the starter fail with "Unrecognized key".

1. Land and publish the CLI release, with `plugin.json` bumped alongside as every release does.
2. Install it with an exact version, `pnpm add -g infra-kit@<x.y.z>`, because `@latest` can be served from a
   stale metadata cache.
3. Commit the starter change: add `vendorSource`, delete the script, add the package script.
4. First real run with one target, `ik vendor sync sandbox-workspace --yes`, then the rest.
5. Regenerate each consumer's root CLAUDE.md block with `ik audit --fix --root`, or it keeps the old human-only
   sentence.

## 7. Extra features

| # | Feature | Value | Cost | Status |
|---|---|---|---|---|
| 7.1 | **Blocked-target preflight** | Consumer edits under synced paths are never silently destroyed, and git is always the rollback | S: one `git status --porcelain -- <paths>` per target | **IN** |
| 7.2 | **`--commit` per target** | One command leaves six repos committed with a message carrying the starter sha | S, specified below | **IN** |
| 7.3 | **Starter changelog in the preview** | Each `changed` row shows `git log --oneline <manifestSha>..HEAD -- <copy paths>`, so the preview says why a target changes | S: the manifest sha is already on disk; an unknown sha becomes a `warn` note | **IN** |
| 7.4 | Drift preview replaces `--check` | The default run is the drift report for every entry, not only vendored ones | Falls out of the plan builder | IN, core design |
| 7.5 | Run-report output | Same look as setup and doctor, with `--json` for free | S: reuse `printRunReport` | IN, core design |
| 7.6 | Consumer-owned `preserve` list, for example `.claude/settings.local.json` | Consumer allowlist lines survive a sync | M: needs a JSON merge rule, and it contradicts today's "allowlist lives in starter" policy | Follow-up, see Q1 |
| 7.7 | `vendor check` reports "behind starter by N commits" | Staleness visible in the consumer | M: consumer CI has no starter checkout, so it only works locally via `vendor.json` | Follow-up |
| 7.8 | Doctor row for factory config and per-target staleness | One place to see that a target has not been synced in weeks | S+: new row plus a `SECTION_MEMBERS` edit in `doctor/report.ts` | Follow-up |
| 7.9 | Manifest coverage for `.claude/` and root files | `vendor check` would catch consumer edits to synced config, not only `vendor/` | M: changes manifest scope and reds every consumer with local `.claude` edits | Follow-up, needs 7.6 first |
| 7.10 | Run from any cwd without `-C` | Type `ik vendor sync` in a consumer and have it find the starter | S, but it weakens the "only the source repo runs this" gate | Rejected; `-C` already covers it |

**7.2 specification.** `<paths>` are the files written or deleted in that target, fed NUL-separated on stdin as
literal pathspecs. First, `git --literal-pathspecs add -A --pathspec-from-file=- --pathspec-file-nul` stages new
and deleted files so the commit can see them. Then `git --literal-pathspecs commit --only -m "[ROOT] vendor: sync
from <source>@<sha7>" --pathspec-from-file=- --pathspec-file-nul` commits them. `--only` commits exactly those paths and leaves any other
pre-staged entry staged and out of the commit. The preview row names the branch the commit will land on. A
target whose commit-msg hook rejects the message gets a `fail` row with the hook output; its files stay written.

## 8. Pre-mortem

1. **The starter commit lands before the CLI release.** Every `ik` command in the starter fails on the strict
   schema, including `vendor check` in its `qa`. *Forces:* the release order in 6.7, stated in the starter
   commit message, and a step that verifies the global `infra-kit --version` before that commit.
2. **The sync destroys ignored build output in a consumer.** Deleting and recopying `vendor/configs` would wipe
   `eslint-config/dist`, which `git status` never showed, and consumer lint breaks. *Forces:* diff-apply over
   tracked sets (6.4), so the apply never touches an ignored file, and the integration test that plants
   `node_modules/`, `dist/` and `.omc/` in a target and asserts they survive.
3. **A copy fails halfway through a target**, for example a permission error inside `.claude/hooks`. *Forces:*
   the blocked-target preflight, so every touched tracked path is clean; per-target isolation; and a `fail` row
   whose notes carry the exact restore argv.
4. **An ignored or local-only file travels to six repos**, as `scheduled_tasks.lock` does today. *Forces:* the
   tracked-set source (6.4), an integration test that plants an ignored file in a synced source directory and
   asserts it never arrives, and a unit test that an untracked file in the source refuses the run.
5. **Reading the config dirties the source.** A migration under the default `autoMigrate: 'write'` rewrites the
   tracked `infra-kit.json` after the clean check. *Forces:* the clean check runs before the config read, the
   read uses `autoMigrate: 'off'`, and a test asserts the source's `git status --porcelain` is byte-identical
   before and after a preview.
6. **An agent runs it anyway.** `--agent` is refused, but `INFRA_KIT_AGENT=0 infra-kit vendor sync --yes` from an
   agent's Bash clears the heuristic. *Forces:* the TTY gate before the apply (6.3 step 7), and a test that
   non-TTY stdin plus `INFRA_KIT_AGENT=0` plus `--yes` writes nothing and exits 2. The same hole in
   `release deliver` is follow-up F3.
7. **Consumer CI goes red after a clean sync.** A manifest holding only the source set lists nothing the consumer
   owns under `vendor/`. `compareToManifest` walks the whole `vendor/` and reports those files as `added`. *Forces:*
   the manifest covers the source set plus the target's tracked `vendor/` paths, hashed from disk (6.4), and the
   fresh-clone round-trip test runs on a target with a consumer-owned tracked file.

## 9. Test plan

### Unit

- Schema: absent, `null` and a valid block all parse. An unknown key inside `vendorSource` or a `copy` entry is
  refused. `..`, absolute and `.git` paths are refused. The block in layer 2 or layer 3 is refused with the
  layer-specific message. The merged config never gains a value the layers did not carry.
- Plan builder, pure: missing checkout gives `skipped`; the source itself gives `skipped`; a dirty tracked path
  gives `fail` with the paths in notes; empty diff gives `ok`; add, modify and remove counts are right.
- Diff computation: an `exclude` segment drops a path from both sides, so a target-only tracked
  `serverless-config` file is never in the delete set.
- Vendored inference: `vendor/configs` is vendored and `.claude` is not.
- Manifest after a delete: the source drops a vendored file and the sync runs without `--commit`. The target's
  index still lists the file, but the manifest does not contain it, and writing the manifest does not throw.
- Agent mode: `--agent` and `--agent --yes` both throw with `status: 'refused'` and exit 2, before any fs or git
  call.
- TTY gate: non-TTY stdin with `INFRA_KIT_AGENT=0` and `--yes` refuses with exit 2 and writes nothing. Non-TTY
  stdin without `--yes` still previews.
- Decline: a declined confirm throws rather than exiting, so cleanup runs.
- Config gate: no `vendorSource` produces the refusal naming the key.
- Unknown positional target names produce a refusal listing valid names.
- Catalog: the invariant accepts `humanOnly`. Every row from `commandCatalog.filter((e) => e.humanOnly)`,
  given its required arguments, refuses `--agent --yes` with `status: 'refused'` and the human-only reason (6.5).
  The `vendor-sync` row has the expected flags; `program.test.ts` finds every backticked `infra-kit vendor sync`
  spelling registered.
- Skills: no `plugins/infra-kit/skills/**/SKILL.md` contains `vendor sync`.

### Integration (real git, real files, no injected executor)

An injected fake can hide the bug, so these tests build real repos in a temp dir and run the real copy code.

- **Content.** One source repo and two target repos. The source has tracked files, a git-ignored file inside a
  synced directory, an excluded `serverless-config` directory, three executable hooks and the relative symlink
  `.claude/skills/shadcn` → `../../.agents/skills/shadcn`. After `--yes`: tracked files arrive byte-identical;
  the ignored file and the excluded directory do not; mode `0o755` survives on the hooks; the link is still a
  link with the same text; a file deleted in the source is gone from the target.
- **Ignored target files survive.** Before the sync, plant ignored `node_modules/`, `dist/`, `.omc/` and
  `coverage/` under `vendor/configs/<pkg>` in a target, and a tracked `serverless-config` file. After the sync all of them are
  byte-identical.
- **Round trip, CI shape.** Run this on the target that holds the consumer-owned tracked
  `vendor/configs/serverless-config` file and the planted ignored `.omc/` and `coverage/` directories. After the
  sync, commit the target, `git clone` it to a fresh dir, and run `vendorCheck({ cwd: clone })`. It returns
  `status: 'clean'` with empty `added`, `modified` and `removed`. This proves the manifest holds the consumer's
  tracked files and none of its ignored ones.
- **Unchanged files are hashed.** Sync twice with no source change between runs. The second run writes no copied
  file, and its manifest still lists every file with the same hashes as the first.
- **Literal pathspecs.** The source tracks `vendor/packages/docs-ui/src/routes/[id].tsx` and a sibling `routes/i.tsx`.
  Editing only `[id].tsx` in the source writes, commits and restores only that file.
- **Recovery argv comes first.** Make one target's write fail partway through. The recovery argv appears on
  stderr before the first write to that target, and running it restores every modified tracked file.
- **Preview leaves no trace.** `git status --porcelain` of the source and every target is byte-identical before
  and after a preview, including when the source config would need a migration.
- Dirty source refuses and writes nothing.
- One dirty target is reported `fail` and untouched, while the other target syncs, and the process exits 1.
- **`--commit` isolation.** Pre-stage an unrelated file in a target, then sync with `--commit`. The sync commit
  holds only synced paths, and the unrelated file is still staged afterward.

### End to end, manual, before the starter commit

`qa` has no build step, so a test that reads `dist` proves nothing. This is a manual step instead, run in a real
terminal.

```
pnpm --filter infra-kit build
node apps/infra-kit/cli/dist/entry/cli.js -C ~/projects/starter-workspace vendor sync; echo "exit=$?"
node apps/infra-kit/cli/dist/entry/cli.js -C ~/projects/starter-workspace vendor sync sandbox-workspace --yes; echo "exit=$?"
git -C ~/projects/sandbox-workspace status --short
pnpm -C ~/projects/sandbox-workspace run vendor:check; echo "exit=$?"
```

Expected: the first run previews with a `warn` row while the starter sits on a feature branch and exits 0. The
second exits 0. `status` shows only synced paths. `vendor:check` exits 0.

### Observability

- Every outcome is a report row, and `--json` carries the same plan and results as a structured payload.
- The report goes to stderr under `--json`, matching `setup`.
- Recovery argv is printed as row notes, never executed.

## 10. Implementation steps

Each step is one commit to `main`. Verification commands run from `apps/infra-kit/cli` unless noted. The `echo`
matters because a filtered runner can report exit 0 on failure.

1. **[BE] Config key.** Add `vendorSourceSchema` and the layer-1-only refusal in
   `src/lib/infra-kit-config/infra-kit-config.ts`, with tests in its `__tests__`.
   *AC:* `pnpm exec vitest run src/lib/infra-kit-config; echo exit=$?` prints `exit=0`.
   `rg -n "\.default\(" src/lib/infra-kit-config/infra-kit-config.ts` shows no new hit inside
   `vendorSourceSchema`.
2. **[BE] Sync library.** Add `src/lib/vendor/sync/` with `tracked-files.ts` (`git ls-files -s`, excludes on
   both sides), `plan.ts` (pure plan builder), `apply.ts` (diff-apply, modes, links, legacy cleanup, README),
   `commit.ts` (`--only`, literal pathspecs on stdin). Give `writeManifest` in `src/lib/vendor/manifest.ts` an
   optional `paths` list that replaces its walk: the rebased source set plus the target's tracked `vendor/`
   paths minus the apply's delete set. Hashing stays `sha256` from disk. Export
   the write path from a separate barrel so `vendor check` keeps its subprocess-free import graph.
   *AC:* `pnpm exec vitest run src/lib/vendor; echo exit=$?` prints `exit=0`, including every integration test in
   section 9.
3. **[BE] Command and catalog.** Add `src/commands/vendor-sync/` with the agent refusal, clean check, config
   gate with `autoMigrate: 'off'`, confirm gate with `throwOnDecline`, TTY gate and run report. Wire it in
   `src/lib/program/program.ts`. Add `humanOnly` to `CommandCatalogEntry` and the `vendor-sync` row in
   `src/lib/command-catalog/command-catalog.ts`; set `humanOnly` on `release-deliver`. Update in the same commit
   the fixtures that go red:
   - `src/lib/command-catalog/__tests__/command-catalog.test.ts:456`, the `groupPaths('vendor')` expectation;
   - `src/lib/command-catalog/__tests__/palette.test.ts:58`;
   - `frame-height.test.tsx:156-158`, whose palette row count grows by one.
   *AC:* `pnpm exec vitest run src/commands/vendor-sync src/lib/command-catalog src/lib/program; echo exit=$?`
   prints `exit=0`.
4. **[ROOT] Guidance and stale script.** Extend the human-only sentence in the root guidance body `.md` resource
   and update `bodies.test.ts` and `bodies-snapshot.test.ts.snap` in the same commit. Regenerate this repo's block
   with `ik audit --fix --root`. Delete `scripts/copy-shared-repos-data.mjs`.
   *AC:* `pnpm run qa; echo exit=$?` prints `exit=0`. From the repo root, `rg -n "vendor sync"
   plugins/infra-kit/skills; echo exit=$?` prints no match and `exit=1`. `rg -l copy-shared-repos-data
   --glob '!docs/**'` lists only `vendor/README.md`.
5. **Release.** Publish per the release procedure with `plugin.json` aligned, then install the exact version
   globally.
   *AC:* `infra-kit vendor sync --help; echo exit=$?` prints `exit=0` from `~`.
6. **[ROOT] Starter, then consumers.** In the starter, add `vendorSource` to `infra-kit.json`, delete the script,
   and add the `vendor:sync` package script. Run the manual end-to-end check in section 9, then sync every
   target. In each consumer, run `ik audit --fix --root` so its generated CLAUDE.md names `vendor sync` as
   human-only.
   *AC:* the section 9 end-to-end commands give the expected exits. `infra-kit -C ~/projects/hulyo-monorepo vendor
   sync; echo exit=$?` prints the not-a-source refusal and `exit=1`. `pnpm run vendor:check; echo exit=$?` in
   each synced consumer prints `exit=0`.

## 11. ADR

- **Decision:** a human-only `ik vendor sync`, gated on a layer-1-only `vendorSource` key in the source repo's
  `infra-kit.json`. It diff-applies the source's git-tracked tree onto each target's tracked tree, never touches
  ignored files, refuses dirty target paths, and writes a manifest built from the tracked set.
- **Drivers:** consumer-repo safety, a gate no consumer or machine layer can satisfy, and a release that ships in
  one package.
- **Alternatives considered:**
  - The audit config (`infra-kit.config.ts`), rejected for the second-package publish cost and for being audit
    rules.
  - A copy list in `vendor.json`, rejected because it drifts from the commit it describes and cannot gate by
    repo.
  - A dedicated `vendor-source.json`, rejected on user intent: the user asked for an infra-kit config parameter
    that defaults to `null`.
  - Delete-then-recopy, as the script does, rejected because it destroys ignored build output that git cannot
    restore.
  - A top-level `ik starter-sync`, rejected because the `vendor` group already exists and holds the manifest's
    reader.
- **Why chosen:** it reuses `lib/vendor` (hash, skip sets, `writeManifest`), the confirm gate, the agent refusal
  and the run report. It fixes three live defects as a side effect: the ignored-file leak, the unguarded
  `rm -rf`, and working-tree entries in the manifest.
- **Consequences:**
  - The starter's `infra-kit.json` needs a CLI at or above the release version.
  - The `rsync` dependency and 13 of 14 exclude patterns disappear.
  - Consumer-local edits under synced paths now block a sync instead of vanishing, a change the user will
    notice on the first run.
  - The apply cannot run from Claude Code's `!` prefix or any piped stdin.
  - The catalog gains a `humanOnly` field that the destructive-op invariant accepts.
- **Follow-ups:**
  - F1: 7.6 preserve list.
  - F2: 7.7 behind-by-N in `vendor check`, and 7.8 doctor row.
  - F3: give `release deliver` the same TTY gate. `INFRA_KIT_AGENT=0 infra-kit release deliver --yes` from an
    agent's Bash passes its agent check today.
  - F4: delete `release-deliver`'s vestigial `defineMcpTool` now that `humanOnly` carries the gate.
  - F5: `vendor check` walks the working tree, so an ignored file in a local `vendor/` outside the skip set
    reads as "added" on that machine. Switching the read path to `git ls-files` would match the write path.
  - F6: 7.9 wider manifest coverage.
  - F7: a SIGINT handler for the apply. Today a Ctrl-C mid-apply relies on the recovery argv printed before each
    target's first write (6.3 step 8.1).
  - F8: a source-tracked path that the target gitignores stays out of the target's dirty check. When the bytes
    are identical it is skipped yet listed in the manifest, so a fresh clone fails `vendor check`. When they
    differ, `git add -A` refuses the ignored path under `--commit`.

## 12. Open questions

- **Q1. `.claude/settings.local.json` in consumers.** Keep today's policy, where the starter owns the file and
  consumer lines are overwritten, or build the `preserve` feature now? The blocked-target preflight already
  stops a sync from silently wiping an uncommitted local line.
- **Q2. A blocked target.** This plan skips it, syncs the rest and exits 1. The alternative is to refuse the
  whole run when any target is dirty.
- **Q3. Explicit `null`.** Should generated configs show `"vendorSource": null` so the option is visible, or
  stay silent, which this plan recommends?
