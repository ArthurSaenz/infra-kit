# `/infra-kit:setup` — the session half of `infra-kit init`

Status: pending approval

Revision 3 — final. Incorporates both rounds of the architect review
(`docs/infra-kit-setup-skill-plan.architect-review.md`) and the critic review
(`docs/infra-kit-setup-skill-plan.critic-review.md`). Round-1 verdicts were "no rethink" (Option A, the
`.mcp.json` writer and the gate split all survived unchanged in shape); round 2 closed the loop —
architect **APPROVE-FOR-CRITIC**, critic **APPROVE**, conditional only on three commit-1 code defects
being written into this text before commit 1 is authored. All three are folded in: the
`resolveGitRoot()` blank-output contract (§Gate split, pre-mortem 3, criteria 2.8/2.9), the top-level
`cliVersion` payload field (§`cliVersion`), and the re-ordered gate-alignment rationale.

Ticket prefix: `[DO]`.

Reference being mirrored: OMC's `omc-setup` skill at
`/Users/arthur/.claude/plugins/cache/omc/oh-my-claudecode/4.15.7/skills/omc-setup/`.
Sibling precedent in this repo: `/infra-kit:doctor` (`plugins/infra-kit/skills/doctor/SKILL.md`,
landed in `bd4566d`).

Evidence base: working tree at `969bbe0` (main, dirty — ~30 modified CLI files).

---

## Settled decisions (owner)

Not open questions. Recorded here so they are not re-litigated, with their consequences developed
below rather than assumed away.

1. **The skill MAY run `infra-kit init`.** Run-with-consent is approved. Consequences: §Grant, §Naming
   step 2, and the non-interactive rule in §Skill body.
2. **`init` DOES create `.mcp.json` when absent.** Owner's reason: *"it will be in the repo at any
   cost."* There is no abstention to preserve, so the `missing-file → pass` carve-out's stated
   rationale is retired — but the verdict itself stays reachable and stays `pass`; see §Writer and
   §Doctor's `missing-file`.
3. **The `infra-kit.json` gate must not gate the plugin and MCP steps.** Split it: guidance stays on
   `<git-root>/infra-kit.json`; pointer, install and the `.mcp.json` writer gate on being inside a git
   repo that is not `$HOME`. Mechanism in §Gate split. (`getMainRepoRoot` was proposed and is
   **rejected** — it converges worktrees onto the main root, which is the wrong location for files
   Claude Code resolves from the session cwd, and it throws rather than returning `null` while the
   surrounding catch logs only at `debug`.)
4. **No `setupCompleted` marker in any file, anywhere.** Reasons in §No marker.

---

## RALPLAN-DR summary

### Principles

1. **The CLI mutates; the session asks.** `infra-kit init` already owns every write. The skill's
   unique capabilities are asking a human, reading the live session, and naming what infra-kit is
   forbidden to do itself (root, third-party auth, tool installs).
2. **Never hold a second copy of a list this skill does not own.** The doctor skill's founding rule
   (U16, `manifest.test.mjs:487-508`). The inventory of "what must be installed" is doctor's rows, and
   the skill must *derive from* them, never restate them.
3. **State is derived, never recorded.** `infra-kit doctor` computes "is this set up" from observed
   state. A marker file records what someone once did. Known gap: the derivation cannot distinguish
   *declined* from *missing* — stated as a limitation in §Known limitations rather than engineered
   around.
4. **A standing grant is made safe by additivity, not by flaglessness.** Revised from revision 1,
   which had this backwards. Fencing a command in a SKILL.md obliges an `allowed-tools` rule (U6
   clause 2), and a rule runs without a prompt. What makes `Bash(infra-kit init)` acceptable is that
   **every writer `init` drives is additive-and-never-overwrite by construction**
   (`plugin-pointer.ts:18-19`; the zshrc block is a managed block; layer 3 is reseeded regardless).
   Flaglessness is a revocable property of one commit and was never the security property.
5. **Prefer deleting scope.** Four of OMC's eight setup concerns have no infra-kit analogue, and five
   further items were cut during review (§Cut).

### Decision drivers (top 3)

1. **`.mcp.json` is the only genuinely unowned item.** Verified repo-wide: every
   `writeFileSync(… '.mcp.json' …)` in the tree is a test fixture
   (`plugin-pointer/__tests__/install-state.test.ts:185,193`,
   `doctor/__tests__/claude-plugin-checks.test.ts:176`); production code only reads
   (`install-state.ts:222`) or reports (`doctor.ts:1026-1065`). `apps/infra-kit/cli/readme.md:19`
   instructs a *human* to add it by hand. Without the `infra-kit` server key, every
   `mcp__infra-kit__*` tool a skill or command names resolves to nothing, silently.
2. **The plugin packaging contract is the tightest constraint in the repo, and it is not the CI
   gate.** `manifest.test.mjs` enforces the skill inventory (U3, `:324`), frontmatter identity (U2,
   `:328`), banned keys (U4, `:344`), no project-relative paths (U5, `:380`), `allowed-tools` ↔
   fenced-corpus equality in **both** directions (U6, clause 2 `:188-197`, clause 3 `:199-207`), and no
   MCP tool names in a skill (T1, `:579`). Separately: a **skill is exempt from the version-floor
   semantics** of `scripts/check-workflow-resource-published.mjs`, which binds `commands/` only — but
   **not** from the job that runs it. See §CI reality.
3. **Interactivity belongs in the session.** The `dev` wizard is TTY-only and non-TTY runs skip it
   silently, so a CLI-side wizard is vacuous wherever `init` is scripted. And `AskUserQuestion` is a
   strictly better affordance for onboarding than inquirer.

### Viable options

#### Option A — thin skill over `init`, one narrow CLI addition (**chosen**)

The skill runs `infra-kit doctor --json` as its state-derived pre-check, asks once, runs
`infra-kit init`, offers `doctor --fix`, and echoes the remaining failing rows' own messages. The CLI
gains a merge-safe `.mcp.json` writer, a `fixable` field on the payload, and the gate split.

- **Pros.** Mirrors the doctor split the owner asked to parallel. One new CLI seam with an existing
  template to copy (`ensurePluginPointer`). No new command — matching the owner's recorded preference
  that the guidance-block writer is `audit --fix`, *not* a new command. The skill restates nothing.
- **Cons.** The skill must fence `infra-kit init`, the plugin's first standing prompt-free grant for a
  mutating command. It cannot land as one commit (§Landing sequence). It requires the packaging edits.

#### Option B — fat skill with its own scripts (the literal OMC shape)

- **Invalidated.** It reimplements `init` in bash — the second copy principle 2 forbids — and the copy
  would need to know four config migrations, the managed-block writer, the layer-3 seeder and the
  plugin installer. It also multiplies the U5/U12 surface (each script needs `${CLAUDE_PLUGIN_ROOT}`
  rooting and a self-location allow-list entry) for a flow whose steps are individually idempotent.

#### Option C — CLI-only: `infra-kit init --interactive`

- **Invalidated.** TTY-only wizards are vacuous non-interactively (the recorded `dev`-wizard
  landmine). It also delivers nothing the owner asked for: the request was for a *session* flow.
  (Revision 1 supported this with two further arguments that are false of this command; both deleted —
  see §Corrections W4.)

#### Option D — a plugin **command** instead of a skill

- **Invalidated, on corrected grounds.** A command needs both a published-CLI version floor **and** a
  served `infra-kit://workflow/<name>` resource (`publish-gate.test.mjs:22-23,79-87`), and U14 pins the
  body to **exactly** three non-empty lines — `assert.equal(bodyLines.length, 3)` at
  `manifest.test.mjs:637`, an equality, not a cap. Revision 1's stated reason ("`publish-gate.test.mjs`
  is red on main") was wrong and is corrected in §CI reality.

#### Option E — `infra-kit setup` prints an ordered checklist (raised in review)

- **Invalidated, and its rejection is stronger than "Option A is smaller".** `doctor --json` already
  delivers everything a printed checklist would, from a command that ships today, at zero new surface.
  A printed checklist would be a **third** rendering of the same rows — beside `printDoctorReport` and
  beside each check's own `message` — i.e. a principle-2 violation moved *into the code*, which is
  worse than one in a doc.

---

## Deliberate mode: pre-mortem

### Scenario 1 — the `.mcp.json` writer clobbers `linear-server`

**What breaks.** The writer is implemented as a whole-file serialize rather than an additive merge.
This repo's own `.mcp.json` carries a second, unrelated `linear-server` entry.

**Observable symptom.** Linear MCP tools disappear after a routine `infra-kit init`. No error anywhere.
Worse: doctor's `MCP server key` row reports **pass**, because `inspectMcpRegistration:232` is
`if (MARKETPLACE_NAME in servers) return { kind: 'ok' }` — key presence alone, value never inspected.
So the health report actively certifies the damaged file.

**Guards.** (a) Byte-identity and key-order assertions over a two-server fixture — the assertions
`plugin-pointer.test.ts` already makes for `.claude/settings.json`. (b) The three replacement
assertions in §Writer tests, which are what actually pin writer↔reader agreement; revision 1 cited a
round-trip `kind === 'ok'` criterion here, and that criterion is **vacuous** (it passes on
`{"mcpServers":{"infra-kit":null}}`), so it is no longer counted as a guard. (c) The unit tests pin the
*writer*; a perfect writer handed `<root>/.claude/.mcp.json` produces the same user-visible outcome, so
criterion 2.2's **absolute-path** assertion closes the caller side.

### Scenario 2 — the standing grant widens through the fallback fence

Re-narrated. Revision 1 narrated this as "someone adds a flag to `init`", which is the least likely
path and is not the widening this plan actively invites.

**What breaks.** Step 1 tells the skill to fall back to `node <repo>/apps/infra-kit/cli/dist/cli.js`
when `infra-kit` is not on `PATH`. That line lives in **prose**. Someone moves it into a fence — the
obvious tidy-up, since the other invocations are fenced. U6 clause 2 then demands a matching rule, and
the natural rule is `Bash(node <abs>/cli.js *)`. Its first token is `node`, so any guard scoped to
`infra-kit`-headed rules never looks at it. `doctor/SKILL.md:4` already ships a `node … *` rule as
precedent, so this is the next edit someone makes.

**Observable symptom.** *None.* U6 goes green, the skill works, the tests pass — and the plugin now
carries a standing, prompt-free grant for **every** infra-kit subcommand, including `local-deploy`,
`release deliver`, `env-token-set` and `worktrees remove`.

**Guard.** The three-part replacement in §Grant guard. Part (1) — a per-skill **allow-list of literal
`Bash(...)` rule strings**, pinned by `deepEqual` — is head-agnostic, so it catches this and every
other unpredicted spelling. Measured against the suite's own predicate, revision 1's proposed U18 (no
`*` in an `infra-kit`-headed rule) passed **four of six** widening shapes, including this one.

### Scenario 3 — `init` writes three tracked files into an unrelated git repo

Replaces revision 1's scenario 3 entirely. That scenario's evidence was wrong (`agent-files.ts:43,49`
already log on both null paths) **and** its symptom was impossible: `resolveCheckedRepoRoot`
(`doctor.ts:919-927`) returns `null` without `<toplevel>/infra-kit.json`, and `doctor.ts:1464` omits the
MCP row entirely on `null` — so the "two contradictory rows" it described can never render. This
replacement is a direct consequence of decisions 1-3 and is the only one of the three whose blast radius
reaches outside this repo.

**What breaks.** After the gate split, pointer, install and the writer gate on `getProjectRoot()` plus
`!== os.homedir()`. A user — or an agent running `/infra-kit:setup` — invokes it with cwd inside some
unrelated project. The `$HOME` guard passes, because it is not `$HOME`. `init` then (i) creates or edits
that repo's `.claude/settings.json` with `extraKnownMarketplaces["infra-kit"]` and
`enabledPlugins["infra-kit@infra-kit"]`, (ii) creates its `.mcp.json`, and (iii) spawns
`claude plugin install --scope project` **for that repo** (`install-plugin.ts:46-47`; project scope
always). Three tracked-file writes in a repo whose owner never adopted infra-kit.

**Observable symptom: none at the time.** `init` prints its success line and exits 0. The damage
surfaces later as an unexplained diff — or never surfaces, because the next `git add -A` carries
infra-kit's marketplace pointer and MCP server into a stranger's repository.

**Guards.**
1. The writer emits a **`warn`** — not `debug`, not `info` — naming the absolute root and the files it
   is about to touch, in the one state where the two gates disagree: git root resolved,
   `infra-kit.json` absent. Asserted by message, in `logPointerResult`'s style. This is the only
   CLI-side signal available.

   **This guard is only as truthful as `resolveGitRoot()`'s blank-output contract, which makes that
   contract a blocking commit-1 defect rather than hygiene.** `getProjectRoot` returns `''` on blank
   `git rev-parse` stdout and `'' !== os.homedir()`, so a blank root would enter *this very branch* and
   the warn would **announce the wrong path while the writer writes cwd-relative files**. See §Gate
   split for the contract and criterion 2.8 for the assertion that pins it.
2. The skill states the resolved root **and that the two gates differ** before the consent question,
   and the consent question names the absolute path — not "this repo".
3. **There is no mechanical prevention, and this is a real cost of principle 4 rather than an
   oversight.** `init` takes no flags, so it cannot offer an `--allow-outside-infra-kit` confirmation;
   and it must not prompt, because non-TTY runs skip prompts silently. So the CLI can only *announce*.
   This plan accepts the announcement as sufficient for the approved scope, and does **not** reopen
   principle 4 — that is the owner's call, not the planner's. If the announcement later proves
   insufficient, a flag is the fix and it costs the rule-string allow-list one reviewed line. Recorded
   here so the trade is visible rather than discovered.

---

## What must be installed: check ownership

> **Dated snapshot** of `SECTION_MEMBERS` (`apps/infra-kit/cli/src/commands/doctor/report.ts:60-85`)
> at commit `969bbe0`: **30 rows**. `report.ts` is the only live authority; this table exists to answer
> the owner's opening question at planning time and is superseded once Phase 1 lands.
>
> Two caveats a later reader needs. **Row 21's name is computed, not a literal** — `report.ts:80`
> builds it from `DEFAULT_DEV_PROXY_PORT`, so the string below is a rendering. And **the "Fix owner"
> column is this plan's own judgement, recorded in no code anywhere.**
>
> **None of this table may migrate into `plugins/infra-kit/skills/setup/SKILL.md` or
> `plugins/infra-kit/README.md`.** The exemption that lets it live here is *not auto-loaded, dated,
> non-instructional* — a SKILL.md fails all three, which is exactly why the same table there would be
> a principle-2 violation.
>
> **The 30 is a maximum, not a constant.** Two rows are conditionally omitted
> (`doctor.ts:1455-1464`), so no consumer may assume a fixed row count.

| # | Check | Section | Fix owner | Note |
|---|---|---|---|---|
| 1 | `gh installed` | Tools | **human** | doctor prints the URL (`doctor.ts:1391`). |
| 2 | `gh authenticated` | Tools | **human** | `gh auth login` is an interactive browser flow (`:1397`). |
| 3 | `doppler installed` | Tools | **human** | URL only (`:1403`). |
| 4 | `aws installed` | Tools | **human** | URL only (`:1409`). |
| 5 | `package manager installed` | Tools | **human** | URL only (`:1415`). Also the bootstrap for #20. |
| 6 | `typescript-language-server installed` | Tools | **human** | URL only (`:1421`). |
| 7 | `terminal installed` (cmux) | Tools | **human** | Optional; URL only (`:1427`). |
| 8 | `ide installed` | Tools | **human** | Optional; URL only (`:727,732`). |
| 9 | `zshrc init block` | Shell | **`init`** — already | Its own fix hint *is* `infra-kit init` (`:91,102,113`). |
| 10 | `warm cache` | Shell | **nobody** | Every branch returns `pass` (`:127-161`). Can never be the thing to fix. |
| 11 | `pnpm enableGlobalVirtualStore` | Shell | **human** | A line in the repo's tracked `pnpm-workspace.yaml` (`:164-195`). Report only. |
| 12 | `CLAUDE.md block` | Shell | **`init`** — already | Fix hint is `infra-kit init` (`:903`). Conditionally omitted outside an infra-kit repo. |
| 13 | `infra-kit config valid` | Config | **human** | A hand edit. `init`'s four migrations cover every *legacy shape*. |
| 14 | `user override path` | Config | **`init`** — already | Layer 3 auto-seeded; `reseedUserProjectConfig` (`init.ts:179`). |
| 15 | `legacy user-global config` | Config | **`init`** — already | `migrateUserGlobalConfigFilename`. |
| 16 | `tokens.json present` | Tokens | **human** | Needs a Doppler service token: `infra-kit env-token-set <env>` (`program.ts:688`). |
| 17 | `env tokens configured` | Tokens | **human** | Same. |
| 18 | `env token valid` | Tokens | **human** | Validity is Doppler's answer. |
| 19 | `tokens.json perms` | Tokens | **`doctor --fix`** | In `FIXABLE_NAMES` (`report.ts:118`). Its message names the flag (`doctor.ts:605`). |
| 20 | `portless installed` | Proxy | **human** | A `node_modules` dependency; fix is `pnpm install`. Never on `PATH`. |
| 21 | `portless serving TLS on :443` | Proxy | **human, ROOT** | Printed, never run (`:1119`, via `formatPortlessCommand`). Sudo re-exec needs a TTY. |
| 22 | `portless CA chain valid` | Proxy | **derived** | Skipped with no daemon (`:1302`); resolves when #21 does. |
| 23 | `portless CA trusted` | Proxy | **human** | `trustCmd(bin)`, no sudo (`:1209`) — still a keychain change. |
| 24 | `portless routes` | Proxy | **`doctor --fix`** | In `FIXABLE_NAMES`. **Its message names a *manual* command** (`:1249`), not the flag — see §`fixable`. |
| 25 | `claude CLI` | Plugin | **human** | Prerequisite of #26/#27; `init` prints the two manual commands (`init.ts:261`). |
| 26 | `marketplace registered` | Plugin | **`init`** — already | `syncPluginPointer` → `installPluginForProject`. |
| 27 | `plugin installed` | Plugin | **`init`** — already | The one row that makes doctor exit 1 (`program.ts:567-571`). |
| 28 | `plugin version` | Plugin | **session** | Marketplace auto-update + `/reload-plugins` or restart. The doctor skill's probe already reports the drift. |
| 29 | `CLI version` | Plugin | **informational** | Always `pass` (`doctor.ts:1022`), message `` `infra-kit CLI ${version}` ``. Used as the floor check in §Landing sequence. |
| 30 | `MCP server key` | Plugin | **NEW CLI code** | **The gap.** Conditionally omitted today; §Gate split changes that predicate. |

**Tally.** `init` already owns 6 (#9, #12, #14, #15, #26, #27). `doctor --fix` owns 2 (#19, #24). New
CLI code owns 1 (#30). The session owns 1 (#28). 2 are inert (#10, #29). **18 are human actions** —
which is why the skill's job is an ordered, consented, *derived* reading of the report plus one missing
writer, and why Option A is small.

---

## The `.mcp.json` writer

### Where it lives

`apps/infra-kit/cli/src/lib/plugin-pointer/mcp-registration.ts`, beside its reader
(`inspectMcpRegistration`, `install-state.ts:220-241`), exported through `lib/plugin-pointer/index.ts`.
Called from `syncPluginPointer` (`init.ts:315`), under the gate defined in §Gate split.

### Template

`lib/plugin-pointer/plugin-pointer.ts` in full — additive-only, never-overwrite (`:16-22`),
indent-detecting (`detectIndent`, `:88`), trailing-newline preserving (`:183-184`), and on an
unparseable file warn-and-leave-untouched (`:167-177`). Reuse `MARKETPLACE_NAME` (`:26`) for the key;
never a fresh literal. Direct precedent for decision 2: `createSettingsFile` (`:138-147`) is called
when the file is absent, so **`init` already creates a tracked file it did not find.**

### The contract — writer-side parse, not the reader's verdict

Revision 1 keyed the writer off `inspectMcpRegistration`'s five verdicts. That is wrong, because
`:228` returns `unparseable` when `parsed` is not a plain object **or** `parsed.mcpServers` is not a
plain object — so a perfectly valid `{"$schema": "…"}` reads as `unparseable`. Under refuse-and-leave-
alone the writer would permanently strand a repairable file while `doctor.ts:1030` says *"Could not
read mcpServers from .mcp.json — fix the JSON"* about JSON that is fine. Decision 2 makes that
untenable: *"it will be in the repo at any cost"* cannot coexist with permanently stranding it.

So the writer keys off **its own parse**, in three outcomes:

| Writer-side outcome | Behaviour | Why |
|---|---|---|
| Bytes fail `JSON.parse` | **refuse**, `warn`, leave byte-for-byte alone | `ensurePluginPointer`'s exact behaviour (`:167-177`). Also the correct handling of a JSONC file with comments: fail-safe, not fail-open. |
| Parses to a plain object, no usable `mcpServers` | **add the container additively** | Exactly what `addMissingKey` already does for a missing container (`plugin-pointer.ts:101-115`). Every existing top-level key preserved, in place. |
| Parses with `mcpServers` present | the four key-level paths below | |

Key-level paths, once `mcpServers` exists:

| State | Behaviour | Why |
|---|---|---|
| `infra-kit` key present | no write, `debug` only | The steady state of every configured machine. `logInstallOutcome`'s recorded rule: a setup command that reports its no-ops is one people stop reading. Note this also covers a *deliberately different* `infra-kit` entry (absolute path, wrapper, `--cwd`), which is correctly never touched. |
| key absent, no misfiled sibling | **add** it; every sibling server byte-identical, key order, indent and trailing newline preserved | The normal repair. |
| key absent, a misfiled sibling looks like infra-kit's server | **refuse**; `warn` with the exact hand-fix | Renaming a key is a semantic edit of a decision a human deliberately typed, inside a `try/catch` that swallows to `debug`. And *adding alongside* would run **two** infra-kit servers while doctor certifies `ok`, because `:232` short-circuits before `:235`. doctor already emits the exact rename instruction (`:1057`), so refusing costs the user only a read. |
| file absent | **create** with only the `infra-kit` server | Decision 2. |

**No reader change.** Once the writer creates the container, `inspectMcpRegistration` re-reads and
returns `ok`, so doctor's verdict vocabulary is untouched. Narrowing the reader's `unparseable` into a
fifth kind would change doctor's message set and test surface for no behavioural gain — a follow-up,
not a dependency.

### The value written

```json
{ "type": "stdio", "command": "infra-kit", "args": ["mcp"] }
```

Identical to this repo's committed entry. `command: "infra-kit"` (not an absolute path) is correct
because consumer repos run the global install.

### The key is not negotiable

It must literally be `infra-kit`. Claude Code namespaces tools as `mcp__<key>__<tool>`; a correct
server under the wrong key resolves nothing, silently.

---

## The gate split

Today `resolveRepoRoot` (`agent-files.ts:37-55`) returns `null` unless `<toplevel>/infra-kit.json`
exists, and **all four** steps hang off that one value (`init.ts:94,98`). So a fresh repo without
`infra-kit.json` cannot be set up at all: `init` writes the zshrc block, migrates and reseeds config,
prints *"Run `source ~/.zshrc`…"*, exits 0, and does none of the plugin, install or MCP work. Those
three steps have **no dependency on `infra-kit.json`** — they write `.claude/settings.json`, drive
`claude plugin install --scope project`, and write `.mcp.json`. Gating them on a config file they never
read is incidental coupling.

**Restructure, don't duplicate.** Split `resolveRepoRoot` into two functions, the second built on the
first:

- **`resolveGitRoot()`** — `getProjectRoot()` (one `git rev-parse --show-toplevel`, worktree-local,
  already called on the guidance path via `getInfraKitConfigPaths`, `infra-kit-config.ts:421`), wrapped
  so a throw becomes a **logged skip** rather than a `debug` swallow, plus **`!== os.homedir()`**.
  Gates pointer, install and the writer.
- **`resolveInfraKitRoot()`** — that root, plus `infra-kit.json` present. Gates guidance, exactly as
  today.

Four things this must state rather than assume:

- **Blank output is a failed resolve. This is a contract, not an implementation detail.**
  `getProjectRoot` is `return result.stdout.trim()` (`git-utils.ts:143-157`) and throws **only** when
  `$` itself fails — so blank stdout yields `''`. An empty string is not merely an invalid root, it is a
  **cwd-relative** one: every `path.join('', x)` silently resolves against `process.cwd()` (the shape of
  the recorded `dev-context $HOME fallback` landmine), and `'' !== os.homedir()` means the `$HOME` guard
  **passes**. `resolveGitRoot()` must therefore treat blank as a failed resolve, logged as a skip
  exactly like a throw. Pinned directly by criterion 2.8.

  **Why this is blocking for commit 1 rather than hygiene:** carry a blank root into pre-mortem 3.
  Guard 1 is the `warn` that fires in the one state where the two gates disagree, and guard 3 concedes
  that announcement is the **only** protection that exists there. With `''` accepted as resolved, that
  branch is entered with root `''` — so the sole guard **announces the wrong path while writing
  cwd-relative files.** The blank check is what makes pre-mortem 3's only guard truthful.

  **The check goes in the new wrapper only — not in `getProjectRoot`.** Rejecting blank in the shared
  primitive is the tempting fix (a blank root is never valid for any caller), but the blast radius was
  measured: **34 suites under `apps/infra-kit/cli/src` mock `zx`, and 23 of them return `stdout: ''`**,
  including all four `git-utils` suites and two shared mock helpers
  (`git-utils/__tests__/zx-command-mock.ts`, `lib/vendor/__tests__/zx-mock.ts`). That is a separate
  landing, recorded in §Cut and deferred with the number so nobody "tidies" it into `getProjectRoot`
  mid-commit-1.
- **The `$HOME` guard is load-bearing.** "Inside a git repo" does not protect `$HOME`: users who
  git-manage their dotfiles have a repo there. One comparison, no extra shell-out, and it preserves the
  protection the `infra-kit.json` gate was giving incidentally — `init.ts:306-308`'s own recorded
  reason for the gate is *"outside an infra-kit repo it does nothing rather than writing a `.claude/`
  directory into whatever the cwd happens to be."* Tested (criterion 2.4) — but that criterion is only
  trustworthy once 2.8 pins the blank case, because a test that controls `git rev-parse` with the
  prevailing blank-stdout `zx` idiom would bypass the guard and still pass.
- **Worktree-local is correct for these files, not a compromise.** Claude Code resolves `.mcp.json`
  and `.claude/settings.json` from the session's cwd, and sessions do run in worktrees (the whole
  `ik worktrees add` / `reopen` flow). `getMainRepoRoot` would write config a worktree session never
  reads. The branch-dirt concern is bounded: the writer is additive and a no-op when the key is
  present, and the file is committed at the same path on every branch, so only a branch predating the
  file sees a diff — a one-time cost, stated rather than engineered around.
- **The pointer↔installation invariant survives.** `syncPluginPointer`'s doc comment (`init.ts:303-310`)
  binds *pointer ↔ installation*, both driven from **one** `root` so `--scope project` records what the
  pointer names. It is not *guidance ↔ pointer*. Splitting guidance onto a different predicate is fine
  as long as pointer, install and the writer keep sharing one root — which they do.

### The consequence the reviews caught: writer reach now exceeds reader reach

After the split the writer can write in any git toplevel that is not `$HOME`, while
`resolveCheckedRepoRoot` (`doctor.ts:919-927`) still requires `<toplevel>/infra-kit.json` and
`doctor.ts:1464` omits the `MCP server key` row without it. In a git repo with no `infra-kit.json`,
`init` would write `.mcp.json` and doctor would have **no row for it** — so the skill (whose steps 1, 3
and 4 are all payload-derived) could never confirm the write it just caused, nor surface a misfiled key
there. Revision 1's claim that the `MCP server key` row is "the standing monitor for #30, with no new
check to add" would be false in exactly the repos decision 3 exists to serve.

**Resolution: align the reader's gate with the writer's, in the same commit.** `doctor.ts:1464`'s
predicate for that one row becomes `resolveGitRoot()` rather than `resolveCheckedRepoRoot()`.

**The reason is correctness, and it stands alone.** Leaving doctor unchanged ships a **writer with no
monitor** in exactly the repos decision 3 exists to serve. The skill's steps 1, 3 and 4 are now
*entirely* payload-derived, so with no row in the payload the skill can neither confirm the write it
just caused nor surface a misfiled key there — and the alternative artefact is a "this step is
unverifiable here" caveat in the SKILL.md, which is strictly worse than a one-line predicate change.

Marginal-cost note, deliberately last: `resolveGitRoot()` is being built in this commit anyway, and the
`missing-file` message and comment are being rewritten in it too (§Doctor's `missing-file`), so the two
edits share a reviewer read. That is a convenience, not a justification — leading with it is what makes
a correctness decision read as scope creep.

State the resulting shape plainly, because it breaks a comment: `doctor.ts:1456-1457` currently says
the MCP row is omitted *"the same way the guidance check is."* After the split that parallel is gone,
and correctly so — **the row set follows the writer's gate, per writer.** The guidance row keeps the
`infra-kit.json` predicate because the guidance writer does; the MCP row takes the git-root predicate
because its writer does. Update that comment to say so.

**The real cost is four things, not "one call site".** That earlier phrasing understated it: the call
site, **plus** the blank-output contract above, **plus** a mock in a suite this plan must now list,
**plus** criterion 2.8.

- **`report-inventory.test.ts` is the affected suite, and it is not one that asserts the omission.** No
  test asserts the MCP row's absence — both reviewers searched, and Phase 2's own file list names only
  `init-plugin-pointer.test.ts` and `claude-plugin-checks.test.ts`, neither of which asserts absence.
  (An earlier draft implied such tests exist; a reader would hunt for them and find nothing.) What
  actually breaks is `report-inventory.test.ts`, the reconciliation half of the section-map drift guard:
  `:148` asserts the names from a **real `doctor()` run** equal all 30 `DOCTOR_CHECK_NAMES`. It mocks
  every external seam — a total mock of `src/lib/infra-kit-config` (`:73`) and `zx` returning
  `stdout: ''` for every invocation (`:130-136`) — but it does **not** mock `src/lib/git-utils`. So after
  the alignment the git seam becomes load-bearing for the row set while being mocked only *by accident*,
  which is precisely what that suite's own comment ("every external seam is mocked so the set is
  deterministic rather than machine-dependent") denies.
- **Fix: add a deliberate `src/lib/git-utils` mock returning `ensureFixture()`**, matching the
  deliberate total mock of `src/lib/infra-kit-config` already there. Do **not** make the `zx` mock
  command-aware — that means string-matching template literals and it perturbs every other `$` consumer
  inside `doctor()`.
- **"Green because it read the live repo" is not an acceptable outcome.** Without the blank check the
  suite would stay green by resolving root `''`, doing `path.join('', '.mcp.json')` → `'.mcp.json'`, and
  `existsSync` against `process.cwd()` — the real repository, whose `.mcp.json` exists. That is **worse
  than the vacuous criteria rejected in revision 1**: those asserted something that could not fail, this
  one is **machine-dependent**, its answer varying with where vitest was launched and with the working
  tree's uncommitted state. Same defect class as the recorded "dist-reading tests are vacuous" lesson,
  different seam. The implementer must not discover the green and stop.

Two further costs to state: the row now renders in any git repo, where `missing-file` is the ordinary
pre-`init` verdict. Combined with §Doctor's `missing-file` keeping that verdict a `pass`, **a plain
non-infra-kit git repo now shows a passing `MCP server key` row meaning "nothing here yet"** — benign,
but a new reading of that row for a new audience. And `SECTION_MEMBERS` still needs no edit: the gate
changes *whether a row renders*, not the inventory, and `report.test.ts:90-91` pins `toHaveLength(30)`
against `DOCTOR_CHECK_NAMES`, which is unaffected.

---

## Two fields on the `--json` payload: `fixable` and `cliVersion`

The skill's pre-check is **`infra-kit doctor --json`**, not `infra-kit doctor`. `--json` is a global
option (`program.ts:756`); the doctor action skips `printDoctorReport` under it (`:557-560`) and
`emit(result)` puts `structuredContent` on stdout. Doctor's human report goes to **stderr**. Revision 1
made every argument about the pre-check against the wrong interface.

But `--json` alone breaks step 3 while rescuing step 4. `structuredContent` is built at
`doctor.ts:1472-1480` as exactly `{ checks: [{ name, status, message }], allPassed }` — no fixability,
no section, no hint. The `--fix` hint lives **in presentation** (`report.ts:356`,
`` `${fixable} fixable — run \`infra-kit doctor --fix\`` ``), which `--json` skips. And fixability is
*deliberately* not message-derivable — `report.ts:112-117` says the hint *"is driven by this set rather
than by matching message text, so it cannot drift from the real `--fix` code paths."* Worse, the two
fixable rows' messages disagree: `tokens.json perms` names the flag (`doctor.ts:605`) but
`portless routes` names a **manual** command, `portless alias --remove <name>` (`:1249`) — so a step
that echoed `message` verbatim would send the user down the hand-removal path for a row `--fix` owns.

Three ways out were considered. Naming the two rows in the SKILL.md is rejected: it violates principle
2, and **both strings are in `REPORT_OWNED_STRINGS`** (`manifest.test.mjs:490-502`), so U19 hard-blocks
it. Running doctor twice is rejected: doctor spawns `gh`, `doppler`, `aws` and TCP-probes portless, so a
second run is the real latency cost.

**Adopted: add `fixable: FIXABLE_NAMES.has(c.name)` to each entry in `doctor.ts:1473-1475`.** Step 3
then filters `status === 'fail' && fixable`, names zero rows, keeps U19 whole, and derives from the
single source that by its own comment cannot drift. It also makes step 4's exclusion rule derivable
without naming anything.

Two facts about the blast radius, **correcting the critic's item 1**:

- **doctor has exactly ONE `outputSchema`** (`doctor.ts:1492`), not two. The "schema built twice with a
  drift lane" in commit `9983015` is `buildRequestedSchema` for the **confirm-gate form**, a different
  subsystem; it does not touch `doctorMcpTool`. Update the one schema so it stays consistent with the
  payload.
- **The two guards that could have reddened both stay green, and the reason is stronger than "the field
  is nested".** `command-catalog.test.ts` pins `Object.keys(tool.outputSchema).sort()` (`:187`) — but it
  iterates **`getExposedMcpTools()`**, and doctor is `mcpExposed: false` (`command-catalog.ts:471`), so
  **doctor is not in that surface at all.** Likewise the MCP e2e whole-object tool-drift comparison
  (`mcp-stdio.e2e.test.ts:1809-1825`) iterates the `tools/list` result, and `mcp/tools/index.ts:9-11`
  states doctor "is intentionally excluded there (host-inspecting) and must never be registered here."
  **A top-level field is therefore exactly as safe as a nested one.** An earlier draft of this plan
  claimed the opposite and used it to justify reading the CLI version out of a message prefix; that
  premise is false and the choice built on it is reversed below.
- One sentence in the tool's description regardless: `--fix` is unreachable from the MCP boundary by
  design (`doctor.ts:1504`), so `fixable: true` in an MCP payload advertises a repair that client
  cannot run.

### `cliVersion` — adopted, top-level, in the same commit

**Add `cliVersion: packageJson.version` to `structuredContent` and to the one `outputSchema`.** The
skill's CLI floor check (§Landing sequence) then reads that field.

The alternative was to parse the version out of the `` `infra-kit CLI ${packageJson.version}` ``
message (`doctor.ts:1022`), which is how an earlier draft had it. Rejected on four grounds:

1. **Its stated justification was false.** See the bullet above: doctor is excluded from
   `getExposedMcpTools()`, so a top-level addition breaks nothing.
2. **The floor check is the only substitute skills get for the published-CLI version floor**
   (§Landing sequence). That makes it precisely the wrong place to depend on an unguarded string in a
   message body — the U16/U19 silent-staleness family, relocated from a row name to prose.
3. **A version in a structured payload is a comparison; a prefix is a parse**, and the failure
   direction of a slipped parse is "assume the floor is met".
4. One line, in a file and a commit already being edited, with a blast radius verified four ways as nil.

**In commit 1, not deferred, for a structural reason rather than convenience:** `cliVersion` is consumed
by commit 2's skill. Landing it later would need its own publish, and the skill would meanwhile carry a
floor check whose own datum requires a floor check. Deferring therefore means either shipping the prefix
after all, or dropping the floor check.

**Consequence to state once, because it is new:** with these two fields the `--json` payload has become a
**compatibility surface that an external artefact depends on.** Three fields in one file, one commit, one
publish is not scope creep — three commits with three publishes would be — but the payload is no longer a
private convenience, and §Observability records what that obliges.

---

## Doctor's `missing-file` verdict

Decision 2 retires the carve-out's *rationale* without killing the *verdict*. Because the row is gated
(and, after §Gate split, gated on the writer's predicate), `checkMcpServerKey` only ever runs where a
root resolved. Once `init` always creates the file, `missing-file` is reachable in exactly one state:
**a git repo where `init` has never run**, or ran on a pre-writer CLI.

- **Not `fail`.** That duplicates a signal two rows already carry — `zshrc init block` and
  `CLAUDE.md block` both fail in an un-init'd repo with `infra-kit init` as their own fix hint
  (`doctor.ts:91,102,113` and `:903`). A third would be a principle-2 violation *inside doctor*, and it
  changes nothing operationally: `program.ts:567-571` scopes exit 1 to `plugin installed` alone.
- **Not "leave the strings alone".** The rationale at `:1033-1038` — *"a repo that has chosen not to
  register any MCP server has no key to get wrong"* — asserts an abstention decision 2 has abolished.
  A comment stating a retired rationale is exactly the staleness principle 2 targets.
- **Adopted: keep the verdict in `MCP_NON_FAILING` (`:1039`) and rewrite two strings** — the
  `missing-file` message (`:1029`) so it names `infra-kit init` as the fix, and the comment
  (`:1033-1038`) so it says the file is now always written and this verdict means "`init` has not run
  here". `claude-plugin-checks.test.ts:209-213` asserts the message contains `'Not applicable:'`, so it
  updates in the same commit — **that diff is the artefact that records the decision.**

---

## Interactivity, idempotence, resume

### `init` gains no flags

**One reason, and it is sufficient:** the `dev` wizard is TTY-only and non-TTY runs skip it silently,
so a CLI-side wizard is vacuous wherever `init` is scripted.

Revision 1 gave three. Two are deleted as unsound *for this command*, both verified: `commands/init` is
**not imported** anywhere under `src/mcp/` (`mcpTool: null, mcpExposed: false` at
`command-catalog.ts:466` is metadata, not a wiring fact), and **`init` never calls `confirmOrExit`** —
no reference anywhere under `commands/init/`. Both statements are true of the codebase and inapplicable
here; leaving them as load-bearing support would invite a future reader to act on them.

Note what is **not** a reason any more: flaglessness is not the grant's safety property (principle 4).
`Bash(infra-kit init --force)` contains no `*` and would pass any wildcard deny-list; what catches it is
the rule-string allow-list in §Grant guard. `infra-kit init --help` already works — Commander provides
it free.

### No `setupCompleted` marker, anywhere

A hard constraint, not a preference:

- `~/.infra-kit/infra-kit.json` (layer 2) and `~/.infra-kit/projects/<repo>/infra-kit.json` (layer 3)
  are both parsed by `infraKitOverrideConfigSchema = infraKitConfigObject.partial()`
  (`lib/infra-kit-config/infra-kit-config.ts:278`), and **`.strict()` survives `.partial()`**
  (`:236`). `loadLayer` **throws** on any unknown key (`:668-671`), the file's own comment at
  `:655-659` says so, and both layers pass through it (`:505-512`, loop at `:518`). Layer 3 is
  auto-seeded on every command. A `setupCompleted` key there would break **every** `infra-kit` command
  on that machine.
- A **separate** file would be a second source of truth for a question doctor answers from evidence.

**So the "already configured?" pre-check is `infra-kit doctor --json`.** That single substitution
answers OMC's Pre-Setup Check, its Resume Detection and its `--force` at once — all three exist only to
compensate for a recorded marker.

### No progress/resume file

OMC needs `setup-progress.sh` because its Phase 1 mutates `CLAUDE.md` through a coordinator and an
interrupted run leaves a half-written file. infra-kit's steps are: run `init` (idempotent, exit 0 by
contract), run `doctor --fix` (idempotent, refuses while a dev session runs), and tell a human things.
An interrupted run is resumed by re-running the skill; the state to resume *from* is re-derived. A
progress file would add a staleness failure mode for nothing.

---

## The standing mutating grant

### Guard: three independent parts (replaces revision 1's U18)

Revision 1 proposed a single assertion: no `*` in any `Bash(...)` rule in this skill whose first token
is `infra-kit`. Executed against the suite's own predicate (`manifest.test.mjs:140-215`), that passes
**four of six** widening shapes — `Bash(node /abs/…/cli.js *)`, `Bash(pnpm *)`, bare `Bash` with zero
fences, and any `env`/`sudo`-prefixed fence. A guard that catches two of six is not a guard. No single
assertion closes all six; the replacement has three independent parts.

**(1) The rule side becomes an ALLOW-LIST of literal `Bash(...)` rule strings, per skill, pinned by
`deepEqual`.** A deny-list can only forbid spellings someone already thought of.

- `doctor → ['infra-kit doctor', 'node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs *']`
- `setup → ['infra-kit doctor --json', 'infra-kit init']`

This is the same discipline `EXPECTED_SKILLS` (`:19`) and `EXPECTED_COMMANDS` (`:606`) already use, at
the same cost: one deliberate line with a visible diff whenever a grant changes. It subsumes the `*`
deny-list entirely, is **head-agnostic** (so `node`- and `pnpm`-headed wildcards are caught), and makes
the next skill's first grant a reviewed event. Keep one deny-list assertion beside it as a cheap
backstop for skills not yet in the map: no rule may contain `*` unless the skill/rule pair is
allow-listed.

**This test is the normative copy of the grant.** The `allowed-tools` line will exist in three places —
the SKILL.md, this test, and this plan. The next editor changes the SKILL.md and should **expect a red
test**, not the reverse.

**(2) Bare `Bash` needs its own raw-string invariant.** `bashRules` (`:164`) matches only
`/Bash\(([^)]*)\)/g`, so bare `Bash` yields **zero** rules; with zero fenced lines the corpus is also
zero and both U6 clauses are vacuous — green, green, unrestricted bash. An allow-list keyed on *parsed*
rules cannot see this, because there is nothing to parse. So assert on the raw `allowed-tools` string:
`Bash` must never appear without an immediately following `(`. Safe to add now — no live skill uses
bare `Bash`.

**Do not** strengthen this to "a skill with a Bash rule must have a non-empty fenced corpus":
`update-toolchain` legitimately has zero fences and zero Bash rules, and clause 3 already enforces that
property for parenthesised rules (a rule matching no fenced line is a dead rule). The stronger form
would duplicate clause 3 and wrongly redden fence-free skills.

**(3) The `env` / `sudo` prefix hole is closed by generalising U15, NOT by widening `COMMAND_HEADS`.**

Widening the heads is tempting and wrong. `COMMAND_HEADS` is an allow-list *precisely because fences
hold non-commands*: live fenced first-tokens across the seven skills include `├──` (×8), `│` (×8), `#`
(×5), `export` (×3), `└──`, `cd`, and prose. Widening drags directory-tree art and comments into the
corpus, where clause 2 then demands a grant for each — 27 newly-entering lines in `fe-architect` and
`e2e-architect` alone. And the enumeration can never be complete (`NODE_OPTIONS=… node …`,
`command infra-kit …`, `bash -c '…'`, backticks, `$( … )`).

The closure already exists in the suite and revision 1 overlooked it. **U15 does not use
`COMMAND_HEADS` at all** — it scans **raw** fenced lines for mutating invocations as *substrings*
(`:477-479`). That form is inherently immune to the head problem: `env FOO=1 infra-kit init` contains
`infra-kit init` and is caught.

So restructure U15 into two pieces. The existing `MUTATING_INVOCATIONS` deny set (`:474` —
`['--fix', 'infra-kit init', 'audit --fix']`) becomes **global**, scanned across every skill instead of
only `DOCTOR_SKILL`. Beside it, a per-skill map of **explicitly permitted** mutating fences:
`setup → ['infra-kit init']`, `doctor → []`, and `[]` by default for every other skill. A skill fails
when a fenced line contains a denied needle that its own entry does not permit. Keep the substring
matching and the raw `fencedLines` input; do **not** route it through `commandCorpus`.

This closes two things at once: the `env`/`sudo` prefix hole, and U15's own scope gap — today it is
scoped to `DOCTOR_SKILL` (`:474-481`), so nothing stops the *next* skill fencing `audit --fix`. It also
puts setup's one permitted mutation in a **second** reviewed allow-list, so granting a new skill the
right to fence a mutating command is two deliberate edits rather than none.

**Coverage after (1)+(2)+(3):** `infra-kit init *` and `init*` → (1); `node …/cli.js *` and `pnpm *` →
(1); bare `Bash` → (2); `env`/`sudo`-prefixed mutating fences → (3). One shape remains and needs no
guard: `infra-kit <anything>` satisfies `Bash(infra-kit init)` under `canonicalLine`'s placeholder rule
but is not runnable — fail-safe at the permission layer. The lesson to record is narrower: **stop
treating U6-green as evidence that a fence is runnable.**

### What makes the grant acceptable

Not flaglessness — **additivity**. Every writer `init` drives leaves an existing value untouched by
construction: `plugin-pointer.ts:18-19` for the settings keys, a managed block for zshrc, an
unconditional reseed for layer 3, and (new) the writer's contract above. That is the property to assert
of the new writer, and it replaces revision 1's "zero options" test, which is **deleted**: it guards a
revocable state of one commit, and its intended resolution the first time anyone adds a flag for a good
reason is *deletion*.

---

## Not copied from OMC, and why

| OMC feature | Excluded because |
|---|---|
| GitHub-star prompt (phase 4) | A vanity ask in internal onboarding, needing a `gh api -X PUT` grant to modify the user's GitHub account. |
| HUD statusline (2.1) | infra-kit ships no statusline. Nothing to delegate to. |
| beads / task-tool selection (2.6) | No analogue. `taskManager` in the config schema is unrelated to machine setup. |
| Agent-teams `settings.json` env merge (3.3) | A Claude Code preference, not infra-kit setup — and `init` owns `.claude/settings.json` under a two-key discipline ("touches no other key"). A third key breaks the contract that makes that writer safe. |
| Global CLI install via `npm install -g` (2.5) | infra-kit's global install is `pnpm add -g infra-kit@latest`; `npm` is blocked by this repo's bash-guard hook; and infra-kit already ships silent self-update, which a setup-time install would race. |
| `--local` / `--global` targets (phase 1) | No target to choose. `init` writes the root `CLAUDE.md` block plus every workspace package's; there is no global mode. |
| Plugin-cache resolver + canonical-source handshake | `init` downloads and reconstructs nothing. |
| MCP-server menu (3.2 → `mcp-setup`) | infra-kit's only MCP server is its own, and the writer registers it. The menu would be one option long. |
| `--force` | Every step is idempotent and every decision is state-derived. |
| Resume detection + `setup-progress.sh` | §No progress/resume file. |
| **`--help` flag and help-text block** | Cut during review. No sibling skill has one — `doctor/SKILL.md`'s step 0 is a substantive caveat, not a flag parser. Nothing tests it, no user asked a skill for a flag, and it spends body lines against the token budget this plan calls a ceiling. Imported ceremony. |

---

## Naming

**Skill name: `setup`.** Invoked as `/infra-kit:setup`.

- `init` rejected: Claude Code ships a built-in `/init`, and in prose "run init" would be ambiguous
  between the skill and the CLI command — and here they do *not* mean the same thing, since the skill
  is strictly more than `init`.
- No literal collision with OMC (`/oh-my-claudecode:setup`, `/oh-my-claudecode:omc-setup`).
- **Auto-invoke risk is handled in the description, not the name.** OMC's `setup` skill is described as
  "Use first for install/update routing", so a description built on the bare word "setup" competes with
  it on every "set up X" prompt. Mitigation, per the doctor precedent: lead with the verb, name
  infra-kit, and give the matcher concrete nouns.

  Proposed: `Set up infra-kit — the zsh integration, the Claude Code plugin, and the .mcp.json server
  key, from the CLI's own init command.`

  (Revision 1's *"on this machine and repo"* is dropped so the three concrete nouns carry the match.)

---

## Landing sequence

**This is a constraint, not a footnote, and it is the answer to "has this become a subsystem?".** It
has. The fix is sequencing, not cutting further.

**The skill ships instantly; the CLI does not.** The plugin reaches machines through the marketplace on
a version bump. The writer, the `fixable` field and the gate split reach machines only through a
**publish** — and local `infra-kit` == published `infra-kit` == 0.4.0. So a single commit produces a
window in which `/infra-kit:setup` is live and promises a `.mcp.json` write the installed CLI cannot
perform: setup reports success, the `MCP server key` row stays red. The mechanism this repo built for
exactly this hazard — the published-CLI version floor in
`scripts/check-workflow-resource-published.mjs` — **binds `commands/` only.** Skills are exempt, and
that exemption removes the guard against this plan's own release ordering.

### Commit 1 — CLI only. Then publish.

The merge-safe writer with its three writer-side outcomes; the writer tests; the gate split as
`resolveGitRoot()` / `resolveInfraKitRoot()` with the `$HOME` guard **and its test**; the two amended
`agent-files.ts` messages; the `fixable` field plus the one `outputSchema` update; the MCP row's gate
alignment; doctor's two `missing-file` strings and the test that asserts them; the unwritable-file
`warn`; the outside-an-infra-kit-repo `warn`.

**Independently useful:** the writer closes the actual gap whether or not the skill ever ships.

**Publish.** A release is required before consumer repos (hulyo, travelist — which run the global
install) see any of it.

### Commit 2 — the plugin.

The SKILL.md; the three-part grant guard; the red fixture; the `EXPECTED_SKILLS` entry; the version
bump; the README row; the `README.md:81-82` correction.

The skill **states a CLI floor in prose** and step 1 checks it against the payload's **`cliVersion`**
field (added in commit 1) — the cheapest available substitute for the version floor skills do not get.
It reads a structured field rather than the `CLI version` row's name or its message prefix: the row name
is in `REPORT_OWNED_STRINGS` so naming it would trip U19, and a message prefix is an unguarded string
(§`cliVersion`).

### Pre-release step (before the publish)

Inspect hulyo's and travelist's existing `.mcp.json` — present? which key? which siblings? Both have
`infra-kit.json` at their roots, so `resolveInfraKitRoot` passes and the first `init` after the upgrade
produces a **tracked diff in a repo whose owner did not run this plan**. Same shape as the recorded
"consumer local template must be https" lesson: a writer change is not self-contained.

---

## Phases and acceptance criteria

**Phases 1 and 2 are both commit 1; Phase 3 is commit 2.** Each artefact is listed under the phase whose
code it belongs to.

**Two commit-1 blockers, flagged here so they are read before either phase is authored** — both are
defects in code commit 1 adds, and both live in Phase 2 (the gate split): `resolveGitRoot()`'s
blank-output contract, and the deliberate `src/lib/git-utils` mock in `report-inventory.test.ts`. Neither
is optional and neither is test hygiene: the first is what makes pre-mortem 3's only guard truthful, and
without the second commit 1 either reddens the section-map drift guard or passes it by reading the live
repo's `.mcp.json` through a relative path. See §Gate split, and criteria 2.8 / 2.9.

### Phase 1 — the `.mcp.json` writer (commit 1)

Files: **new** `lib/plugin-pointer/mcp-registration.ts`; `lib/plugin-pointer/index.ts` (export);
`commands/init/init.ts` (call from `syncPluginPointer`, one log line in `logPointerResult`'s style);
**new** `lib/plugin-pointer/__tests__/mcp-registration.test.ts`.

| # | Criterion |
|---|---|
| 1.1 | A fixture with `infra-kit` + `linear-server` is **unchanged byte-for-byte** — key order and trailing newline included. |
| 1.2 | A `linear-server`-only fixture gains the `infra-kit` key; `linear-server` byte-identical and **still first**. |
| 1.3 | A tab-indented fixture **that lacks the `infra-kit` key** gains it indented with tabs. (Revision 1 omitted "lacks the key", which made this vacuous: with the key the writer no-ops, the bytes are trivially unchanged and `detectIndent` is never entered.) |
| 1.4 | A misfiled-key fixture (server under `ik`): **no write**, bytes identical, one `warn` naming both keys. |
| 1.5a | A fixture with `//` comments (fails `JSON.parse`): **refuse**, bytes identical, one `warn`. |
| 1.5b | A fixture of valid JSON with **no `mcpServers` key** (`{"$schema":"…"}`): container created additively, `$schema` byte-identical and **still first**, indent and trailing newline preserved. |
| 1.6 | Absent file: created, exactly one server, valid JSON, trailing newline. |
| 1.7 | **Writer↔reader agreement**, three assertions replacing revision 1's vacuous `kind === 'ok'` round-trip — see §Writer tests. |
| 1.8 | An unwritable or non-file `.mcp.json` (EACCES, or the path is a directory) produces one **`warn`** naming the path, and `init` still exits 0. Required because `syncPluginPointer`'s existing `try/catch` logs at **`debug`** (`init.ts:322-326`), so without this the failure is invisible and `init` still prints its success line. |
| 1.9 | Lanes green for the touched packages: `tsc`, `eslint --no-cache`, `prettier --check`, `vitest`; and `git status` shows no `??` files. |

On 1.9: revision 1 said "`pnpm run qa` green", which is **unsatisfiable** — `vendor check` runs first
in root `qa` and is already red on `HEAD`, with no refresh command. That redness is pre-existing and
must **not** be "fixed" by editing `vendor/`. `eslint --no-cache` and the `??` check are named here
rather than only in the flakes section because both are live traps in this repo. sonarjs
cognitive-complexity ≤ 15 applies.

Implementer notes: use `import fs from 'node:fs'` (default) as `plugin-pointer.ts` does — `vi.spyOn`
cannot intercept named `node:fs` imports — though a real tmpdir is simpler and is what the byte-identity
assertions want anyway.

### Phase 2 — the gate split and the messages (commit 1)

Files: `commands/init/agent-files.ts` (split `resolveRepoRoot` into `resolveGitRoot` / `resolveInfraKitRoot`
**including the blank-output contract**; amend the two existing strings);
`commands/init/init.ts` (two gates); `commands/doctor/doctor.ts` (`:1464` predicate, `:1029` message,
`:1033-1038` comment, `:1456-1457` comment, `fixable` and `cliVersion` at `:1472-1480`, `outputSchema`
at `:1490-1502`); `commands/init/__tests__/init-plugin-pointer.test.ts`;
`commands/doctor/__tests__/claude-plugin-checks.test.ts`;
**`commands/doctor/__tests__/report-inventory.test.ts`** (add the deliberate `src/lib/git-utils` mock —
absent from every earlier draft of this inventory, and the suite the gate alignment actually breaks).

| # | Criterion |
|---|---|
| 2.1 | In a tmp **non-git** directory, `init` logs a skip naming the guidance step **and** a skip naming the pointer, install and MCP steps, writes neither `.claude/settings.json` nor `.mcp.json`, and exits 0. |
| 2.2 | In a tmp git repo **with** `infra-kit.json`, with `installPluginForProject` **stubbed**, `init` writes `.mcp.json` **at the resolved absolute root**. |
| 2.3 | In a tmp git repo **without** `infra-kit.json`: guidance skipped with its own message; pointer, install and `.mcp.json` performed; **one `warn`** naming the absolute root and the files touched (pre-mortem 3, guard 1). |
| 2.4 | With the resolved toplevel equal to `os.homedir()`, `init` writes no `.claude/settings.json` and no `.mcp.json`, and logs the skip. |
| 2.5 | `checkMcpServerKey` renders in a git repo without `infra-kit.json` (gate alignment), and its `missing-file` message names `infra-kit init`. |
| 2.6 | `doctor()`'s payload carries `fixable` on every entry, `true` exactly for `FIXABLE_NAMES`, and a top-level `cliVersion` equal to `packageJson.version`. |
| 2.7 | **Additivity, asserted per writer**: for each writer `init` drives, an existing value is never overwritten. |
| 2.8 | With the git seam answering **blank stdout**, `resolveGitRoot()` resolves to a **skip**: `init` writes no `.claude/settings.json` and no `.mcp.json`, logs the skip, exits 0 — and `doctor` **omits** the `MCP server key` row rather than rendering it against a cwd-relative path. |
| 2.9 | `report-inventory.test.ts` reconciles all 30 names with a **deliberate** `src/lib/git-utils` mock returning `ensureFixture()`. Green-because-it-read-the-live-repo is a **failure**, not a pass. |

On 2.1: revision 1's version was wrong three ways — it said *three* gated steps (there are four), it
said "exactly one line" while the fix **amends two existing** messages (`agent-files.ts:43,49`) rather
than adding one, and after the split a non-repo legitimately emits **two** skips with different
predicates. As phrased it would have failed the design it exists to accept.

On 2.4: the single comparison standing between `init` and a git-managed `$HOME` would otherwise land
unverified. But it is **not trustworthy on its own**: to control what `git rev-parse` returns, the test
must stub the git seam, and if it does so with this repo's prevailing blank-stdout `zx` idiom then `''`
bypasses the `$HOME` guard and 2.4 still passes. 2.8 is what closes that.

On 2.6: the first two clauses are real coverage. An earlier draft added *"`command-catalog.test.ts` and
the MCP e2e suite stay green"* — keep that as a cheap regression net if you like, but it is
**reassurance, not coverage**: doctor is excluded from both surfaces, so it cannot fail for this change,
and nobody should read it as evidence the new fields are guarded.

On 2.7: replaces revision 1's deleted "zero options" test, and asserts the property that actually makes
the standing grant safe.

On 2.9: do **not** make the `zx` mock command-aware to achieve this. That means string-matching template
literals, and it perturbs every other `$` consumer inside `doctor()`. Mock `src/lib/git-utils`, matching
the deliberate total mock of `src/lib/infra-kit-config` already at that suite's `:73`.

### Phase 3 — the skill (commit 2, after the publish)

Files: **new** `plugins/infra-kit/skills/setup/SKILL.md` (no `scripts/`, no `references/` — which also
keeps it entirely out of U12's self-location surface); `plugins/infra-kit/__tests__/manifest.test.mjs`;
**new** `plugins/infra-kit/__tests__/__fixtures__/` red fixtures for parts (1) and (2);
`plugins/infra-kit/README.md`; `plugins/infra-kit/.claude-plugin/plugin.json`.

| # | Criterion |
|---|---|
| 3.1 | `pnpm run test:claude` green: U2, U3, U4, U5, U6, T1, T5 plus the three new guard parts and their red fixtures. |
| 3.2 | `claude plugin validate ./plugins/infra-kit --strict --json` exits 0. **Record the `claude --version` used** — the U13 probe step (`plugin-ci.yml:56-57`) is `continue-on-error: true` precisely because `--strict` behaviour is version-sensitive and non-gating in CI. |
| 3.3 | The manual verification in §Manual verification is performed and its findings recorded. |

Two things 3.1 must not be read as claiming. `EXPECTED_SKILLS` is **not** what subjects the new file to
the guards — `skillDirs()` (`manifest.test.mjs:66-72`) is a `readdirSync` of the live tree, U2 (`:328`),
U6 (`:402`) and U12 (`:545`) iterate it, U4 (`:344`) and U5 (`:380`) walk `PLUGINS_DIR`, T1 (`:579`)
walks `SKILLS_DIR`. **Only U3 (`:324`) reads the array.** Creating the directory subjects it to every
guard immediately; the `EXPECTED_SKILLS` edit exists *only* to keep U3 green. And `test:claude` green
**≠ CI green** — see §CI reality.

**Deleted from acceptance: the token-budget re-measure.** It fails twice. Nothing implements it —
verified: no occurrence of `plugin details`, `347` or `projected` in
`plugins/infra-kit/__tests__/*.mjs`, `.github/workflows/plugin-ci.yml`, or `scripts/*.mjs` — so
`README.md:81-82`'s claim that *"the release checklist runs … and fails when it exceeds"* describes a
gate that does not exist. And even performed it is unfalsifiable, because revision 1 permitted
re-baselining the very number it compares against in the same commit. **Resolution:** measure it as a
documented step, keep it out of acceptance, and **correct `README.md:81-82`** to say a human does it.
The plan already edits that file for the skills-table row, so the correction is free.

**Also deleted: the version bump's "CI fails otherwise".** The enforcing step is `plugin-ci.yml:44-46`,
gated on `if: github.event_name == 'pull_request'`, and this repo commits **straight to main with no
PRs**. The bump is unenforced discipline, not a gate.

### Phase 4 — deleted

Revision 1 made this phase's existence conditional on research it never did. **Answered, so nobody
re-asks:** the generated guidance bodies live in `apps/infra-kit/cli/src/lib/agent-guidance/bodies/`
(`root-body.ts`, `package-body.ts`, `design-skeleton.ts`); a case-insensitive search for `skill` across
that directory returns nothing, and the live root block in this repo's own `CLAUDE.md` enumerates the
`ik` **commands** and the conventions only. **The generated block never enumerates skills.** No root
guidance work is needed.

**Do not** edit anything under `vendor/` in any phase.

---

## The skill body

Four sections. No flag parsing, no phase files, no scripts.

**Frontmatter:**
```
allowed-tools: Read, Bash(infra-kit doctor --json), Bash(infra-kit init)
```
Exactly two fenced commands, exactly two rules, no `*`. Note the rule must be **swapped, not added**:
`Bash(infra-kit doctor)` does *not* match the line `infra-kit doctor --json` — it fails clause 2 (zero
matches) *and* clause 3 (dead rule).

`doctor --fix` stays **unfenced prose** — it is a state change on a `--fix` verb, and U15's reasoning
(a fenced line is a prompt-free standing grant) is why the doctor skill keeps it out of a fence.

**Step 1 — read the machine.** Resolve the binary: `infra-kit` on `PATH`, else
`node <repo>/apps/infra-kit/cli/dist/cli.js`, **never `pnpm exec`**. Run `infra-kit doctor --json` once
and parse stdout; this is a **decision input, not a report** — point at `/infra-kit:doctor` for the
readable report. A non-zero exit is a diagnosis, not a tool failure (doctor exits 1 when the plugin is
missing, which is exactly the machine this runs on). Compare the payload's `cliVersion` against the
floor this skill states, and say plainly if the installed CLI is below it — the `.mcp.json` step cannot
work on a CLI that predates the writer.

Then, **before** step 2: state the resolved repo root, **that the two gates differ**, and which steps
each covers — so a user in a repo without `infra-kit.json` understands they get the plugin and MCP
steps but not the guidance blocks.

The working-copy fallback is for the **read only**. `init` must run from the resolved `PATH` binary,
because setup *mutates*: doctor's fallback is safe because doctor is read-only, and copying it to a
mutating command would let the skill change the machine via an unpublished CLI.

**Step 2 — ask once, then run `init`.** One `AskUserQuestion` naming what `init` will change and the
**absolute root**, not "this repo". On yes, run the single fenced command.

**Explicit rule when `AskUserQuestion` is unavailable** (`claude -p`, or any non-interactive session):
**do not run `init`.** Print the command and continue to step 4. Consent for the plugin's only standing
mutating grant must never be inferred by the model. Mirror this repo's own conditional phrasing
("when AskUserQuestion is available").

**Step 3 — offer the repair.** Offer `infra-kit doctor --fix` when any `status: "fail"` entry has
`fixable: true`. Say that it refuses while a dev session is running. **Prefer the flag over that row's
own message:** `portless routes` describes the manual removal command, not the repair.

**Step 4 — the remainder is doctor's, verbatim.** From the step-1 payload, take every `checks[]` entry
with `status: "fail"`, in payload order. Drop the ones already handled: entries whose `message` names
`infra-kit init` (step 2 ran it) and entries with `fixable: true` (step 3 offered the repair). Print
each remaining entry as its `name` followed by its `message`, unedited. Do not group them, do not
rename them, do not add a command of your own — the message already carries the exact command or URL.
Listed, never run.

Two things to say out loud rather than hide: the row set is not fixed — some rows are conditionally
omitted, the guidance row when `infra-kit.json` is absent and the `.mcp.json` row when no git root
resolves, so derive from what the payload contains and never from a count — and a step deliberately
**declined** is indistinguishable from one that is missing —
`status` is only `pass` or `fail` — so a declined row is re-offered every run.

**Step 5 — completion and staleness.** What changed; and that a session started before the plugin
install is stale, fixed by a restart or `/reload-plugins`. **Extend this to MCP-server staleness, not
just plugin staleness:** the writer may have created the `.mcp.json` that decides which MCP servers this
session loads — including the `infra-kit` server this session may be connected to. Per the doctor
skill's own step-3 insight, "registered on disk" and "running in this session" look identical from the
CLI side, which is exactly the failure the session half exists to catch.

Revision 1's step 4 enumerated five human actions by hand ("tool installs, `gh auth login`, the Doppler
token, the root portless step, `pnpm-workspace.yaml`"). That was a second copy of doctor's inventory
that U19 would **not** have caught — it hits none of the 11 names in `REPORT_OWNED_STRINGS`. The
derived form above restates nothing, which is what makes U19 a real invariant here rather than a
fail-open.

---

## Test plan

### Unit — the writer

`lib/plugin-pointer/__tests__/mcp-registration.test.ts`, criteria 1.1-1.8, each over a real tmpdir and
each asserting **file bytes**, not merely parsed shape.

**§Writer tests — the three assertions that pin writer↔reader agreement (criterion 1.7).** Revision 1's
criterion — *"for every case that wrote, `inspectMcpRegistration(root)` returns `{ kind: 'ok' }`"* — is
vacuous: `install-state.ts:232` is `if (MARKETPLACE_NAME in servers) return { kind: 'ok' }`, so it
passes on `{"mcpServers":{"infra-kit":null}}` and pins nothing. Replace with:

1. **Value-level, not key-level.** Assert the written entry satisfies `looksLikeInfraKitServer`
   (`:198-205`) directly — **export it** for this, or assert the `command`/`args` bytes explicitly.
   This is the assertion revision 1 believed it was making; on the write path that predicate is never
   reached, because `:232` short-circuits.
2. **The reverse direction.** Take the writer's own value, file it under `ik`, and assert
   `inspectMcpRegistration` returns `{ kind: 'wrong-key', key: 'ik' }`. This is what actually pins the
   two halves: it proves the writer's output is recognisable *as* infra-kit's server by the same
   predicate the reader uses to detect misfiling.
3. **Refuse, never add-alongside.** On a misfiled-key fixture, assert the writer performs **no write**.
   Without this, an `infra-kit` key added beside a misfiled `ik` yields `ok` (`:232` short-circuits
   before `:235`) and doctor certifies a repo running **two** infra-kit servers — a state currently
   untested anywhere.

### Integration — `init`, the gates, doctor

`commands/init/__tests__/init-plugin-pointer.test.ts` — criteria 2.1-2.4, 2.7. `installPluginForProject`
**must be stubbed**: reaching the writer otherwise goes through
`spawnSync('claude', ['plugin','install','infra-kit@infra-kit','--scope','project'])`
(`install-plugin.ts:47,81`), which in a tmpdir runs the user's real `claude`, mutates a tmp
`.claude/settings.json`, may reach the marketplace over the network, and has whatever happens hidden by
the surrounding `try/catch`.

`commands/doctor/__tests__/claude-plugin-checks.test.ts` — criteria 2.5, 2.6; the `'Not applicable:'`
assertion at `:209-213` updates here, and that diff is the record of the decision.

### Plugin / static

`plugins/infra-kit/__tests__/manifest.test.mjs` — criterion 3.1. The `EXPECTED_SKILLS` entry (U3
only), plus the three guard parts, each with a red fixture: a wildcard rule outside the allow-list, a
bare `Bash`, and an `env`-prefixed `infra-kit init` fence. Every part needs its red case — this suite's
own convention, and without them each part is a fail-open.

### Manual verification — because nothing automated verifies the skill's behaviour

State this plainly rather than implying coverage: all of Phase 3's static criteria mean *"the file is
well-formed"*, not *"the flow works"*. The per-skill test lane
(`plugins/infra-kit/skills/*/__tests__/*.test.mjs`) needs a `scripts/` to test and this skill ships
none, and the repo has **no eval suite of any kind**.

In a **scratch git repo, not this one**:

1. The payload parses, and the consent question renders.
2. `.mcp.json` appears at the **announced** root.
3. The staleness note fires.
4. **The experiment nobody has run: `init` spawning `claude plugin install` from inside a live Claude
   session.** Consenting in step 2 makes a Claude Code session spawn a nested
   `claude plugin install --scope project` child that writes the `.claude/settings.json` the parent
   already loaded, while the new writer edits the `.mcp.json` that decides which MCP servers the parent
   has — possibly including the `infra-kit` server this session is connected to. The doctor skill never
   exercised this, because doctor never runs `init`. Record what happens **before this ships to anyone
   else.**
5. **Stdout purity:** `infra-kit doctor --json` piped to a JSON parser parses cleanly, including on a
   run that triggers the silent self-update. Any stray stdout write corrupts the payload, and it is the
   single point of failure for steps 1, 3 and 4.

### Observability

- The new `init` log lines are asserted by message, in `logPointerResult`/`logInstallOutcome`'s style —
  those messages are the only evidence a user gets that a step ran or was skipped.
- doctor's `MCP server key` row is the standing monitor for #30 **only after the gate alignment in
  §Gate split**. Without that alignment it is not a monitor in any repo lacking `infra-kit.json` —
  exactly the repos decision 3 exists to serve.
- **No `SECTION_MEMBERS` edit is needed**: the row already exists, which dodges the recorded "adding a
  doctor check breaks 2 tests" cost. But the row's *gate* and *message* both change, so
  `claude-plugin-checks.test.ts` does update.
- Doctor's human report goes to **stderr**; the machine payload to stdout. Nothing may read the report
  from stdout.
- **The `--json` payload is now a compatibility surface an external artefact depends on.** `fixable`,
  `cliVersion` and the `checks[]` shape are consumed by a skill that ships on a different cadence than
  the CLI. A producer-side refactor that changes them is not a private change.
- **Step 4's derivability rests on remediation text staying in the *check* layer.** Every human-action
  row carries its runnable command inside `message` today — `formatPortlessCommand(...)` embedded at
  `doctor.ts:1249`, `installDaemonCmd(bin)` at `:1119`, `trustCmd(bin)` at `:1081-1083`,
  `Install from: https://…` at `:1391`, the marketplace command at `:1018`, the `--fix` hint at `:605`.
  Only `report.ts:350-358`'s rollup hint is presentation-only, and `fixable` replaces exactly that. **A
  future refactor that moved command construction into `report.ts` would break the skill silently,
  because `--json` skips presentation.** That is the same hazard as the line above, seen from the other
  side.

### CI reality

Revision 1 claimed `publish-gate.test.mjs` is red on main and that a skill escapes the blocked lane.
Both wrong, and the correction changes what a reviewer sees:

- `plugins/infra-kit/__tests__/publish-gate.test.mjs` is a **green unit test** of `collectViolations`
  imported from `scripts/check-workflow-resource-published.mjs` (`:16`). Its own header (`:9-10`) says
  *the gate* is red on main, not the test.
- The red artefact is the **script step** at `.github/workflows/plugin-ci.yml:54-55`, with **no
  `continue-on-error`** (only the U13 probe at `:56-57` has that), inside the workflow's **single
  sequential `validate` job**, triggered on `paths: 'plugins/**'` (`:7` for `pull_request`, `:20` for
  `push`).
- Therefore **adding `plugins/infra-kit/skills/setup/SKILL.md` will make plugin-ci red on push to
  main.** A skill is exempt from the gate's *version-floor semantics*, never from the *job*.
- And `pnpm run qa` never runs that script (`package.json:23-24` — `test:claude` runs the green unit
  test), so **local qa is green while CI is red** — the worst combination for a reviewer.

**Acceptance consequence: "green plugin-ci" is not a criterion anywhere in this plan.** Commit 2's
message must say the red step is `release-create`'s pre-existing 0.5.0-floor-vs-0.4.0-published
violation, unrelated to the skill.

### Known-flaky, not regressions

`lock.test` and `portless-driver.test` flake under full-suite load and pass in isolation — re-run the
file alone before calling either a regression.

---

## Preconditions and known limitations

State these rather than implying coverage.

- **`/infra-kit:setup` is least available exactly where it is most needed.** The plugin installs at
  **project scope, always** (`install-plugin.ts:22-24,46-47`), and enabling it writes `enabledPlugins`
  into *that repo's* `.claude/settings.json`. So in a fresh repo the plugin is not enabled, the skill is
  not discoverable, and `/infra-kit:setup` cannot be invoked — yet installing the plugin is one of the
  two things it exists to do. **Its audience is the second run, not the first.** Plugin bootstrap is
  `claude plugin marketplace add …` + `claude plugin install …` by hand, or `infra-kit init` from a
  shell — the two commands `init.ts:261` already prints.
- **The CLI cannot bootstrap itself.** If neither `infra-kit` nor a working-copy `dist/cli.js` exists,
  the skill cannot start: the global install is `pnpm add -g infra-kit@latest`, `npm` is blocked by a
  bash-guard hook, and global install is out of scope. A setup skill honestly bounded at *"infra-kit is
  installed; everything after that is mine"* is fine; one implying otherwise fails its first real user.
- **Declined is indistinguishable from missing.** `CheckResult.status` is `'pass' | 'fail'` with no
  warn, and optionality is message-only (`doctor.ts:858`). So a deliberately declined step — no Doppler
  access, no cmux, no IDE, or the documented `"infra-kit@infra-kit": false` opt-out — reports `fail`
  forever and is re-offered every run. This is a **real capability loss** against OMC's marker +
  `--force`, not a wash; the `--json` path cannot fix it either. The proper fix is an `optional` flag on
  `CheckResult`, which is out of scope. The skill says so plainly (step 4).
- **No mechanical prevention of a wrong-repo run.** Pre-mortem 3, guard 3.
- **The writer's reach exceeds "infra-kit repos"** after the gate split: any git checkout that is not
  `$HOME`. That is decision 3's intent, and the skill's pre-consent statement is what makes it legible.

---

## Cut and deferred

**Cut outright** (all from review):

- Phase 4 — empty; answered above.
- The "zero options" test — guards a revocable state, not the safety property; replaced by 2.7.
- The `--help` flag and help-text block — imported ceremony.
- The token-budget re-measure **as acceptance** — implemented by nothing and unfalsifiable; demoted to
  a documented measurement plus a README correction.
- Widening U19 from 11 names to 30 — see below.

**On U19 specifically: ship it as the existing 11-name deny list.** Widening would cost either a second
copy of `SECTION_MEMBERS` inside a `.mjs` test — the exact violation U16 was written to prevent — or a
regex over `report.ts`'s literals from a plugin test reaching into `apps/`, which adds a spurious-red
mode on any `report.ts` refactor. (`DOCTOR_CHECK_NAMES` is exported at `report.ts:109` but is
TypeScript; the plugin tests are `.mjs` and cannot import it.) It buys nothing once step 4 names
nothing. U19 still has a real job at 11 names: **both** `portless routes` and `tokens.json perms` are in
the set, so it hard-blocks the naming implementation of step 3 that §`fixable` rejects. Add one line to
its header comment: the guarantee comes from step 4 being **derived**, not from the list's coverage — so
a future reader does not mistake 11-of-30 for the guard's strength.

**Deferred to follow-ups:**

- **Rejecting blank `git rev-parse` output inside `getProjectRoot` itself** (`git-utils.ts:143-157`).
  This is the right fix in principle — a blank root is never valid for *any* caller (guidance via
  `getInfraKitConfigPaths`, layer-3 keying, worktree resolution) — but the blast radius was measured
  before deferring: **34 suites under `apps/infra-kit/cli/src` mock `zx`, and 23 of them return
  `stdout: ''`**, including all four `git-utils` suites and two shared mock helpers
  (`git-utils/__tests__/zx-command-mock.ts`, `lib/vendor/__tests__/zx-mock.ts`). Turning blank into a
  throw in a shared primitive with that surface is its own landing. **The number is recorded here
  specifically so nobody "tidies" the wrapper's check down into the primitive mid-commit-1.** The
  follow-up has an obvious home: `git-utils/__tests__/git-utils-fail-honestly.test.ts` already exists,
  which is evidence the repo treats this defect class as in scope for `git-utils` — just not in this
  commit.
- A top-level `infra-kit mcp-register`, exposing the same writer as a second entry point, which also
  gives the misfiled-key `--rename` a home as a flag rather than a future new command.
- Narrowing the reader's `unparseable` into a fifth verdict — correct as a follow-up, wrong as a
  dependency (the writer-side split makes it unnecessary).
- `doctor --fix` growing to cover `.mcp.json`, making `MCP server key` a third member of
  `FIXABLE_NAMES`.
- An `optional` flag on `CheckResult`, which is the only real fix for declined-vs-missing.

---

## ADR

**Decision.** Ship `/infra-kit:setup` as a **skill** whose pre-check is `infra-kit doctor --json`, which
runs `infra-kit init` once with consent, offers `doctor --fix` when the payload says a row is fixable,
and echoes every remaining failing row's own message verbatim. Add to the CLI: a merge-safe `.mcp.json`
writer, `fixable` and `cliVersion` fields on doctor's payload, the gate split (with a blank-output
contract in the new wrapper), and the MCP row's gate alignment. Add no marker file, no progress file, and
no flags to `init`. Land the CLI first, publish, then the plugin.

**Drivers.**
1. `.mcp.json` is the only unowned item in the 30-row inventory, and its failure mode is silent.
2. `manifest.test.mjs` makes a skill's `allowed-tools` a hard bidirectional contract.
3. `loadLayer` throws on unknown config keys, so an OMC-style marker is unavailable by construction.
4. `doctor --json` already exists, so the derived design needs no new rendering of the row list.

**Alternatives considered.** Fat OMC-shaped skill with scripts (rejected: reimplements `init` in bash).
CLI-only `--interactive` wizard (rejected: TTY-only wizards are vacuous non-interactively). A plugin
command (rejected: needs a version floor *and* a served workflow resource, and U14 pins the body to
exactly three lines). A printed `infra-kit setup` checklist (rejected: a third rendering of the same
rows, moving a principle-2 violation into the code). A `setupCompleted` marker in the config (rejected:
bricks every command). A separate `~/.infra-kit/setup-state.json` (rejected: a stale second source of
truth). `getMainRepoRoot` as the plugin/MCP gate (rejected: converges worktrees onto a root whose config
a worktree session never reads, and throws where a gate needs three states). A single all-in-one commit
(rejected: ships a skill promising a write the published CLI cannot perform).

**Owner decisions folded in.** The skill may run `init`. `init` creates `.mcp.json` when absent. The
`infra-kit.json` gate is split. No marker anywhere.

**Why chosen.** It is the smallest thing that closes the actual gap while reproducing the split the
owner asked to mirror — CLI reports and mutates, session asks and interprets — and after the `--json`
substitution the skill restates **nothing** it does not own. Substituting doctor for OMC's marker file
removes three of OMC's eight structural features at once.

**Consequences.**
- `init` now writes a third tracked file (`.mcp.json`), and after the split it does so in any git
  checkout that is not `$HOME`. Real widening; the byte-identity tests, the `$HOME` test and the
  outside-an-infra-kit-repo `warn` are all non-negotiable because of it.
- The plugin acquires its first standing grant for a **mutating** command. The three-part guard exists
  to keep it narrow, and **the test is the normative copy** of the grant.
- doctor's `MCP server key` row changes both its gate and its message; `missing-file` stays `pass` but
  now means "`init` has not run here". `claude-plugin-checks.test.ts` updates, and that diff records it.
  A plain non-infra-kit git repo now shows that row passing, meaning "nothing here yet".
- **The `--json` payload becomes a compatibility surface** consumed by an artefact on a different release
  cadence. Two producer-side obligations follow, both in §Observability.
- **`resolveGitRoot()` acquires a blank-output contract**, and `report-inventory.test.ts` acquires a
  deliberate `git-utils` mock. Both are commit-1 blockers, not hygiene: the first is what makes
  pre-mortem 3's only guard truthful, the second is what stops the section-map drift guard passing
  machine-dependently. The equivalent fix in `getProjectRoot` is deferred with its blast radius measured.
- `doctor.ts:1456-1457`'s stated parallel between the MCP row and the guidance row is retired: the row
  set follows the writer's gate, per writer.
- Pushing the skill to main **will show a red plugin-ci run** from a pre-existing, unrelated step.
- The work cannot land as one commit. A publish sits between the two.
- Consumer repos get a tracked diff on their first `init` after the upgrade; they must be inspected
  before the publish.

**Follow-ups.** See §Cut and deferred.

---

## Open questions — need the owner

Reduced to four. Everything else in revision 1's list is now settled above.

1. **Does setup ever run `sudo`?** This plan says never: the portless `:443` daemon install stays a
   printed absolute-path command (`doctor.ts:1119`). Related and separate: should setup **mention** the
   portless rows at all, or is the dev proxy out of onboarding scope? Note that step 4's derived form
   makes this nearly free either way — the rows appear as whatever `message` doctor emits — so the
   question is scope, not mechanism.
2. **Is the Doppler token bootstrap in scope?** Rows #16-18 need a human with a Doppler service token
   (`infra-kit env-token-set <env>`). Same note: the derived step 4 includes them at no cost, so the
   question is whether setup should *lead* a user through them or merely list them.
3. **Plugin version: 0.3.0 → 0.4.0?** Recommended, as a new component. Note it is **unenforced** —
   `plugin-ci.yml:44-46` is PR-only and this repo commits straight to main.
4. **The description wording.** `Set up infra-kit — the zsh integration, the Claude Code plugin, and
   the .mcp.json server key, from the CLI's own init command.` This is the only defence against
   `/infra-kit:setup` firing on unrelated "set up X" prompts, so it is worth a read.
