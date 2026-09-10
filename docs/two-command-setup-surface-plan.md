# [DO] Two commands: `doctor` diagnoses, `setup` does

**Status: pending approval** — **Revision 8**

Collapse the bootstrap/diagnostics surface to exactly two commands — `doctor` and `setup` — on all three
surfaces: the CLI, the MCP server, and the Claude Code plugin.

---

## Revision 8 changelog

**Critic verdict: APPROVE.** Four items folded before implementation; none reopened the design.

| # | Item | Fold |
| --- | --- | --- |
| 1 | **`doctor({ fix: true })` deletes the developer's portless routes, and U-D2(b) calls it deliberately — twice.** `doctor.ts:1461-1470` runs `pruneStalePortlessRoutes()` under `fix`; `decidePrune` (`prune-routes.ts:67-81`) marks **every** non-live route prunable when no `infra-kit dev` runner is alive — the ordinary state during a unit suite — and `doctor.ts:1379-1383` then calls `removeAlias` on each. Neither assertion observes it, so the suite stays green and the damage surfaces later as a 502'ing dev proxy | **Mandatory stub added to §5b's fixture setup**, framed as a safety requirement rather than a speed optimisation, plus the general rule it makes explicit: the stub list for a `fix: true` path must cover its **writers**, not only its readers |
| 2 | Phase 4's criterion still read "five revisions" | Corrected to "four revisions with five distinct failure modes" |
| 3 | §5b cited `doctor-corrupt-token-store.test.ts:12-21` but not `:23-34` | Cited, with what it is for — a wholesale module mock breaks the import graph **at import time**, in a way that looks nothing like a fixture problem |
| 4 | U-D2(b)'s soundness rested on `doctor.ts:1` staying a default `import fs`, guarded by nothing | **Hardening adopted, not offered: new U-D5** asserts the source still contains `import fs from 'node:fs'`. Wired into Phase 4's accept list |

**One correction to the stub as briefed, and it matters — it is the same class of error that has bitten
this test four times.** The brief said to stub `src/commands/doctor/prune-routes`. That does **not**
intercept: `pruneStalePortlessRoutes` is defined in **`doctor.ts:1348`**, so mocking that module reproduces
revision 1's un-interceptable same-module self-call exactly. The seam that works is the **cross-module
named import** at `doctor.ts:18-28` — `vi.mock('src/dev/proxy/portless-driver', …)` overriding
`listRoutes` to `() => []`, so `dead` is empty and `removeAlias` is never reached. And it must be
**partial via `importOriginal`**, because `doctor.ts` uses ten named exports from that module — which is
item 3's lesson arriving in item 1's fix. Both traps are written into §5b.

---

## Revision 7 changelog

Critic: **ITERATE — one blocking item.** Everything else discharged.

**U-D2(b)'s assertion order was the fifth vacuum.** The assertions were right; the *order* destroyed the
fixture the negative one depends on. Two environmental facts, both verified in this repo rather than
assumed:

- **`vi.spyOn` calls through by default** — `config-bootstrap.test.ts:115-122` installs a bare
  `vi.spyOn(fsp, 'writeFile')`, asserts one call, then reads the file back and asserts the new bytes are
  on disk.
- **Nothing auto-clears mock state** — no `clearMocks` / `restoreMocks` / `mockReset` in
  `apps/infra-kit/cli/vitest.config.ts` or the root config; the repo clears by hand
  (`config-bootstrap.test.ts:99`).

Composed: positive-first meant assertion 1's `doctor({ fix: true })` **physically chmodded the fixture
tight**, so assertion 2 met a fixture with `loose.length === 0`, returned at `doctor.ts:601`, and passed
**under the mutation**.

**Fixed by running the negative assertion FIRST** — fresh loose fixture, empty spy, counts cumulative
(0 then 4 on correct code; the mutation reds on assertion 1, before the fixture is altered). No clearing,
no `mockImplementation`, no rebuild.

**§5b now records why the order is what it is**, because the trap closes itself: on correct code,
positive-first reds assertion 2 anyway (the spy still holds four calls), and the repair a maintainer
reaches for — `spy.mockClear()` between them — is *exactly* the edit that converts "red on correct code"
into "green on the mutation". The section says do not reorder and do not insert `mockClear()`, lists the
two sanctioned variants, and says negative-first is chosen because it needs **no cleanup step a later
edit can drop**.

**And the stop condition is now a Phase 4 acceptance criterion, executed rather than reasoned about.**
The test has been specified wrongly in **four revisions, with five distinct failure modes** (revision 1's
was wrong in two independent ways) — un-interceptable self-call,
wrong module, no positive control, self-destroying order, and the bare negative. Three of those produced a
green suite over a live hole. Phase 4 no longer passes on U-D2(b) being green; it passes on U-D2(b) having
been **demonstrated to go red**: write the mutation, run it, observe the red, revert, record it in the PR.

**Discharged and untouched this pass** (critic-verified): B2 `:553-556`, B3 `:1236-1245`, B4 `:1015`,
B5 `:1212-1216`, B6 `:394-398`; the 0.6.0→0.7.0 sweep, all six survivors historical; the `readTokenStore`
correction (two sites, `:341` and `:501`). The 0.7.0-plus-marker conjunction is confirmed sound and
fail-safe — a conjunction of necessary conditions can only delay removal.

---

## Revision 6 changelog

Critic verdict: **ITERATE**, six blocking items. All six fixed; two produced findings beyond the brief.

| # | Fix |
| --- | --- |
| 1 | **U-D2(b) was vacuous for the fourth time — now has a positive control.** The seam (`vi.spyOn(fs,'chmodSync')`) was right; the *assertion* was a bare negative. `checkTokenStorePerms` reaches zero chmods down **four** paths — `:576`, `:580`, `:601`, `:610` — two of which (no store on disk; perms already correct) are the ordinary state of a dev machine and of CI, so the negative passed on green, mutated, and never-entered runs alike. **§5b rewritten**: one fixture, two assertions in opposite directions, with the fixture construction spelled out and a stop condition if the positive half cannot pass |
| 2 | **`mcp-stdio.e2e.test.ts:253` added as a Phase 4 edit site**, with the repair spelled out as an **inversion** (`toContain`), not a deletion — its own comment at `:250-252` warns that loosening it destroys the guard |
| 3 | **Phase 6 names `0.5.0`** — and the number was load-bearing: `check-workflow-resource-published.mjs:71` records the gate is **already red** for `release-create` (floor 0.5.0, published 0.4.0), so this publish discharges a pre-existing red too. `plugin-ci.yml:44-50` gates Phase 7's PR on it |
| 4 | **I-12 retargeted** from `publish-gate.test.mjs`'s synthetic command factory — which asserts nothing about the shipped file — to `node scripts/check-workflow-resource-published.mjs`, the check CI actually runs |
| 5 | **Phase 5 must build and invoke `dist/cli.js` by absolute path.** `body.md` is `?raw`-bundled at `resources.ts:13`, so a bare `infra-kit` (the published global) re-emits the **old** wording and silently undoes the edit. Exact invocation written; `pnpm exec` excluded by name |
| 6 | **The two `body.md` strings decided and quoted.** Retargeting `:4` to `infra-kit setup` would have printed "regenerating docs means running the installer" into four repos — Scenario 5 authored by this plan. `:4` now names `ik audit --fix --root` (the actual guidance-block writer, already a row in the block); `:15` names `ik setup` for setup only |

**Two findings beyond the brief.**

**`init`'s removal moves from 0.6.0 to `0.7.0`.** Naming Phase 6's version exposed that a 0.5.0 ship with
a 0.6.0 removal leaves a **one-minor** deprecation window — which §1's own evidence refutes:
starter-workspace sits at `0.3.14` against published `0.4.0`, two minors behind on a global install
nobody there upgraded deliberately. Such a consumer can skip every version in which `init` both works and
points at `setup`. Removal is now gated on **both** `0.7.0` **and** every consumer's `infra-kit:version`
marker reading ≥ `0.5.0` — a version floor counts CLI releases, while what goes stale is the committed
block, which only advances when someone regenerates it in that repo. All 19 mentions swept.

**§5b now carries the full failure history** — three wrong versions in a table, each a *different*
mistake (wrong seam / wrong module / no positive control). The fourth is only defensible with the first
three visible, and the pattern itself is the warning.

**Confirmed sound by the critic, kept as recorded evidence:** Phase 1's replacement gate is genuinely
achievable (root `package.json:23` short-circuits on `vendor:check &&`); Option B is rejected on merits
and Option C's "rejected on the stated goal" is honestly labelled; `COMMAND_FRONTMATTER_KEYS` deleting the
standing-grant question is real; Scenario 4's `bypassPermissions` answer is the honest one; and the A/B/C
decomposition plus the Phase 6→7 resource ordering both hold.

---

## Revision 5 changelog

Architect round 4: REVISE, **no architectural objection remaining**. Six fixes; the first is the serious
one.

| # | Fix |
| --- | --- |
| 1 | **U-D2(b)'s seam was wrong, for the third revision running.** It watched `vi.mock('src/lib/env-tokens')`, but `src/lib/env-tokens/index.ts:1` exports no chmod — the `--fix` write is `chmodPath(entry.target, …)` at `doctor.ts:619`, resolved from `fs.chmodSync` at `:571`, and `doctor.ts:1451` passes no `deps`. So it recorded zero calls with or without the mutation. Corrected to `vi.spyOn(fs, 'chmodSync')`, sound **because `doctor.ts:1` is a default import** — new **§5b** records the whole chain, names the mutation, and flags that rewriting that line to a named import silently re-vacuates the test |
| 2 | **Deleted §2's stale second "Flag surface"** — it said "`--tools`, `--update`. No others.", contradicting the four-row table above it and omitting `--skip-tools`, the flag the safety argument hangs on |
| 3 | **I-3 and U-S5 pinned a code path the plan denies is distinct.** §2 says `init` and `setup --skip-tools` are the *same operation*, yet the tests were written so that sharing one implementation would fail I-3 while duplicating it invited drift — the defect that makes an implementer build the wrong thing *while passing review*. Both restated behaviourally as "never reaches `lib/dependency-install`" |
| 4 | **Phase coverage holes.** U-S7 was in no phase (Phase 2 said "U-S1..U-S6" and U-S7 sorts above U-S6); `--skip-tools` was absent from Phase 2's work list; U-S5 sat in Phase 2 but exercises `init`, unwired until Phase 3. Fixed by enumerating tests rather than widening the range, and by moving U-S5 to Phase 3 beside I-3 |
| 5 | **Phase 1's "`pnpm run qa` green" was unsatisfiable** — `vendor check` runs first in root qa and is already red on HEAD, so a literal-minded agent stalls or edits `vendor/`, the one directory that must not change. Restated as four named, achievable commands with the known-red check excluded **by name**, and full qa deferred to Phase 6 |
| 6 | **Finished the alias→preserved sweep** (7 sites), and fixed **RALPLAN driver 3** and **ADR driver 3**, which both still cited a plugin standing grant the command shape deleted |

**Non-blocking follow-ups, folded.** The `deny`-vs-`allow` finding now says plainly that the
over-permission direction is **unevidenced** — every observed consumer rule *restricts* infra-kit — while
keeping the evidenced point that consumers author such rules at all. G-U6 is restated as
**inapplicable** rather than tolerable: U6 asserts `allowed-tools` ↔ fenced-corpus equality, and a command
cannot have `allowed-tools`, so the subject matter does not exist. I-10 carries a whole-line-matching note
against the day a permitted entry is added.

**Recorded as evidence** (architect's positive findings): the A/B/C commit decomposition is sound; Phase 6
correctly owes the served `infra-kit://workflow/setup` resource *before* Phase 7's command — a dependency
the command shape introduced; every acceptance criterion except Phase 1's was already checkable without
judgement, and Phase 1's now is; and `COMMAND_FRONTMATTER_KEYS` making `allowed-tools` impossible in a
command is the strongest structural move in the plan.

---

## Revision 4 changelog

Architect round 3: REVISE. No design change — three defects, all in how the plan *describes* what it
specifies, plus one genuine gap.

| # | Defect | Fix |
| --- | --- | --- |
| 1 | **§Viable options and the ADR still described revision 2's design.** Option A's heading said "additive flagless default"; its CLI bullet said flagless = init + report; its Plugin bullet said "skills `setup` and `doctor`". The ADR said the flagless form is "additive-only" and the plugin fences it. A reader who read the summary and stopped got the wrong plan | Both rewritten to state what the plan specifies. The ADR Decision is now seven numbered clauses naming `--skip-tools`, `menuGroup: null`, the preserved `init`, and the command-not-skill explicitly |
| 2 | **Scenario 4 conflated two permission axes.** It cited `_meta['anthropic/requiresUserInteraction']` as the gate surviving `bypassPermissions` on a path made entirely of *Bash* spellings. `_meta` rides the MCP `tools/list` entry and is never consulted on a Bash call | Corrected, and the honest answer stated instead: in `bypassPermissions` the ambient risk dominates and infra-kit adds **no marginal exposure**. Also records why a CLI-side confirm is not the repair — `confirm-or-exit.ts:77` exits `0` on decline and its own JSDoc (`:44`) notes `process.exit` skips every `finally` |
| 3 | **Consumers author their own infra-kit Bash rules and this plan cannot reach them** | New §Known-limitations entry. Mitigation is inspection: Phase 5 / Landing step 3 widened from `CLAUDE.md` to also read each consumer's `.claude/settings.json`. *Relay correction:* starter-workspace's four infra-kit rules are in **`deny`**, not `allow`/`ask` — the observed instance is a consumer *restricting* infra-kit. The surviving point is that they write such rules at all, in `pnpm exec` / `ik` spellings §3's list does not use |

**Also folded.** starter-workspace's fifth and cleanest drift cited: `<!-- infra-kit:version 0.3.14 -->`
at `CLAUDE.md:63` against a published 0.4.0, where hulyo (`:177`), travelist (`:266`) and this repo
(`:18`) all read `0.4.0` — a machine-written marker, not prose. Phase 7 gains a checkable criterion that
`plugins/infra-kit/skills/setup/` must not exist, since a command and a skill of the same name both
surface as `/infra-kit:setup`.

**Recorded as evidence rather than lost** (architect's positive findings): `--skip-tools` relocates an
invariant that used to be carried by the default into two test-carried ones (I-9, U-S7), each with a real
mutation; **misspellings fail closed** — `allowUnknownOption` appears nowhere in the CLI, verified, which
is what makes the flag safe to hang `init`'s successor on; and the whole-line-vs-needle diagnosis in I-10
is correct, with a genuinely discriminating red fixture.

---

## Revision 3 changelog

**The owner answered revision 2's open question: B — flagless `infra-kit setup` installs everything.**
Owner's words: *"B (але також прибери із starter-workspace)"*. Revision 2's additive-only default is
reversed, and the consequence revision 2 itself named is now the design: **the plugin skill gets no
standing grant for the installing path.**

Revision 2 leaned on the additive default to resolve three tensions at once. B reopens each, and each is
answered separately below rather than by reverting text.

**B is not free, and the price is measured.** The architect verified all three legs of revision 2's cascade
at source — including `run-session.ts:199` dispatching `[deps.cliPath, ...command.groupPath]` with zero
flags. So B did not expose a weak argument; it **spends three genuine resolutions**. The owner chose it
with the price stated, and the price is recorded below as fact rather than as a concern.

| Tension B reopens | Revision 3's answer |
| --- | --- |
| **§5 menu row.** The palette dispatches zero flags, so a `setup` row is now a one-keystroke installer — the thing `command-catalog.ts:580-581` deliberately refused | **`menuGroup: null`** (ruling). It also closes a naming leak the §Naming mitigation cannot reach: `command-palette.tsx:285` renders `item.name` = `groupPath.join(' ')` with **no binary qualifier**, so the row would read bare `setup`. One edit retires a reversal and a leak together |
| **§1 alias blast radius.** Aliasing `init` to a `setup` that installs software silently upgrades a stale consumer instruction into an installer | **`init` is not aliased at all** (ruling). It keeps its historical contract — the additive writes, nothing installed — plus a stderr pointer to `setup`. The plan stops calling it an alias, because it is not one |
| **The sibling plan's additivity justification** (`docs/infra-kit-setup-skill-plan.md` §Principles 4) is false of `setup` under B | Moot: the plugin's `setup` becomes a **command**, and `COMMAND_FRONTMATTER_KEYS` (`manifest.test.mjs:617`) admits no `allowed-tools` key. There is no standing grant to justify — the strongest possible form of the answer |
| **Scenario 4** was "the grant is a hole to fence" | Rewritten for the command shape. `T1` walks `SKILLS_DIR` only (`manifest.test.mjs:12` vs `:615`), so a **command** may name `mcp__infra-kit__setup` and route through its confirm gate — the precedent is `release-create.md:8`, shipping today |
| **The name `setup` is triple-loaded** in all four consumer repos | New **§Naming**: `pnpm setup` (builtin), `pnpm run setup` (`runtime-set-node && pnpm install`, identical in all four), and `infra-kit setup`. Every generated instruction writes the binary-qualified form |

Also in revision 3: `/Users/arthur/projects/starter-workspace` added as a fourth consumer (§1, Phase 5),
and the consumer-guidance limitation **discharged by direct inspection of all four repos** — the table is
now evidence in §1, not a caveat in §Known limitations.

---

## Revision 2 changelog

Revision 1 was reviewed at `docs/two-command-setup-surface-plan.architect-review.md` (verdict: REVISE).
Option A's central move survives; five things moved, and one precondition was discharged by
measurement. *(Item 3 below — the additive-only default — is superseded by the owner's B decision above;
the rest stand.)*

| # | What moved | Why |
| --- | --- | --- |
| 1 | **U-D2 replaced** with `doctorMcpTool.handler.length === 0` plus a cross-module `vi.mock` write assertion | `checkTokenStorePerms` is a same-module self-call (def `doctor.ts:567`, call `:1451`), so `vi.spyOn` cannot intercept it and every weakening of the old U-D2 was vacuous on the mutation it targeted. This test is the sole payment for §4; unbuildable, it left the trade unfunded |
| 2 | **`dependencies[]` sibling array deleted.** The dependency data now rides as an optional `detail` on the four `checks[]` rows `doctor` already owns, plus one new `brew` row and a deliberate `SECTION_MEMBERS` edit | Revision 1 held a second copy of a list `doctor` already owns (`doctor.ts:1299`, `:1402`, `:1414`, `:1421`), with semantics documented to disagree, and chose that design partly to keep `report-inventory.test.ts` green — architecture settled by test convenience |
| 3 | **Bare `infra-kit setup` no longer installs software.** It runs the init half plus a read-only dependency report; the converge is `--tools` / `--update`. New pre-mortem Scenario 4 | A plugin skill's `allowed-tools` rule runs *without a prompt*, and a flagless rule can only grant the flagless form. Revision 1's Phase 7 shipped an ungated Bash route to a package installer that its own I-5/I-6/I-7 certified as fine |
| 4 | **§2 gains a structured `InitReport` and the merged tool gains an `outputSchema`** | `init()` is `Promise<void>` reporting through a logger, and MCP logs go to `/tmp/mcp-infra-kit.log` — an MCP `setup` call as specified in revision 1 did ~8 local writes and reported nothing about them |
| 5 | **Edit-site list corrected**: `EXPECTED_GATED_TOOLS:209`, `REQUIRES_INTERACTION_TOOLS:258`, `palette.test.ts:59`, the catalog snapshot `:265,274`, `readme.md:100-111`, two now-false comments in `src/mcp/tools/index.ts`; `setup-dependency-gate-mutation.test.ts` retargeted to `['setup']`; U-C4 demoted; U-C5 rewritten | Revision 1 missed six edit sites and proposed one no-op (`doctor: 'doctor'` is **already** in `EXPECTED_PARITY` at `command-catalog.test.ts:315`) |

**Discharged, not deferred.** Revision 1 carried "is the `setup-dependency` trio really unpublished?" as a
precondition someone would check before Phase 3. The published 0.4.0 tarball has since been pulled and
grepped: **0 occurrences** of `setup-dependency`, `setup-dependency-status`, `dependency-registry` or
`dependency-install` in `package/dist`; `.command("init")` present; `.command("setup")` absent. §1 now
states this as measured fact, §6 is sharpened accordingly, and the item is gone from §Preconditions and
§Known limitations.

Two scope corrections to the review are recorded inline at §4 and §Q6 rather than accepted silently; both
narrow the work rather than dispute the finding. The `init`-compatibility reasoning (§1), the sequencing (§6) and
the Q6 override survive as written.

---

## Evidence base

- HEAD `969bbe0`, branch `main`, tracking `origin/main`. Working tree **dirty**: 71 changed paths.
- In scope and **untracked** (never committed on any ref): `src/commands/setup-dependency/`,
  `src/commands/setup-dependency-status/`, `src/lib/dependency-{registry,probe,plan,install}/`,
  `src/lib/plugin-pointer/mcp-registration.ts`,
  `src/lib/command-catalog/__tests__/setup-dependency-gate-mutation.test.ts`,
  `src/commands/doctor/__tests__/probe-argv-single-source.test.ts`. Untracked and **out of scope** but
  sharing files: `src/commands/release-remove/`, `src/integrations/jira/remove-version.ts`,
  `src/integrations/gh/pr-status.ts`.
- A parallel session was reported editing `doctor.ts` and `report.ts`. Every line number in those two
  files is read from the **working tree** and must be re-checked before editing.
- Paths are relative to `apps/infra-kit/cli/` unless prefixed `plugins/`, `docs/` or `/`.

**Scope fence (owner, verbatim):** *"self update то інше (не чіпаємо) / версіон залишаємо / аудіт то інше
(теж залишаємо) / інші команди не чіпаємо, я кажу setup deps setup status init"* and *"і плагін для claude
code"*. `self-update`, `version`, `audit` and every other catalog command are **not touched**. Four names
fold into `setup`: `init`, `setup-dependency`, `setup-dependency-update`, `setup-dependency-status`.

---

## RALPLAN-DR summary

### Principles

1. **"Two commands" is a taxonomy, not a count.** `doctor` answers *what is the state?*; `setup` answers
   *make it so*. Each folded name lands on the side of that line where it belongs — which is why the
   dependency **read** path goes to `doctor`, not into `setup`.
2. **A permission identity is whatever the rule matches on.** `setup-dependency.ts:156-158`:
   *"MCP permission rules match on tool name only (a parenthesised `mcp__` rule is silently skipped at
   settings load)."* On the **Bash** axis a rule matches on **argv**. Collapsing names must not collapse
   identities on either axis — and the two axes make that achievable in different ways (§3).
3. **A safety flag describes the exposed tool, not the CLI command.** Already the repo's rule: `audit` is
   `mutating: false, mcpExposed: true` (`command-catalog.ts:519-525`) despite a CLI `--fix` that writes.
4. **Never hold a second copy of a list you do not own** (`docs/infra-kit-setup-skill-plan.md`
   §Principles 2). Revision 1 violated this; §4 now derives instead of duplicating.
5. **A standing grant may name only an argv that is safe ungated.** A skill fence and a `Bash(...)` allow
   rule without a wildcard grant exactly the invocation they spell, and such a rule **runs with no
   prompt**. Revision 2 satisfied this by making the flagless form safe; under B the flagless form
   installs software, so the principle is satisfied the other way — **the grant names a different argv**
   (`setup --skip-tools`) and the installing form is granted nowhere. The principle is unchanged; only
   which side of it moved.
6. **A test that passes on the bug it targets is a defect.** Every test below names the mutation that
   reds it, and one of them (U-D2) was rewritten in this revision because its first form could not.

### Decision drivers (top 3)

1. **Preserving the prompt-free read path.** `setup-dependency.ts:154-158` is the strongest argument
   against the owner's shape; a design that does not answer it on the merits is not viable.
2. **`init` is published surface across 104 versions and 0 tags**, reached by consumer repos (hulyo,
   travelist) through a **global** install with no local pin, and named by *generated* guidance those
   repos have committed (`/CLAUDE.md:34`, rendered from `resources/root/body.md:15`). A repo regenerates
   its block only when someone runs `infra-kit init` / `audit --fix` **inside it** — so the instruction
   naming the removed command is exactly the thing that cannot self-heal.
3. **The one gate `doctor` is leaving must be re-funded, and the installing path must reach no
   prompt-free route.** `doctor` deliberately exits the P1 fail-closed catalog gate
   (`command-catalog.test.ts:243-256`), so U-D2 must actually bite (§5b). And under B the installing form
   must be reachable through no standing grant — which the command shape achieves by construction, since
   `COMMAND_FRONTMATTER_KEYS` (`manifest.test.mjs:617`) admits no `allowed-tools` key at all.

### Viable options

#### Option A — a gated, installing `setup`; the additive path kept as `--skip-tools`; dependency **read** path unified into an exposed `doctor` (**chosen**)

*This is the shape the plan actually specifies, under owner decision B. Revisions 1–2 stated it with an
additive flagless default; that is superseded throughout.*

- **CLI:** `setup` — **flagless installs everything** (init writes + converge over all five tools).
  `--tools <ids...>` / `--update [ids...]` narrow the converge; **`--skip-tools`** is the additive form
  (init writes + a read-only report). `doctor` keeps `--fix` as CLI-only. **`setup` takes
  `menuGroup: null`** — no palette row, because the palette dispatches zero flags.
- **`init`:** **not an alias.** A hidden, non-catalog Commander command that keeps `init`'s historical
  contract verbatim — the additive writes, nothing installed — plus a stderr pointer to `setup`. Removed
  in 0.7.0.
- **MCP:** exactly two tools. `setup` = `mcpExposed: true, mutating: true, requiresHumanConfirm: true`
  **unconditionally on every call, flagless included**, plus `_meta['anthropic/requiresUserInteraction']`.
  `doctor` = `mcpExposed: true, mutating: false`, ungated, its four dependency rows gaining a `detail`
  payload.
- **Plugin:** the `doctor` **skill** stays; `setup` ships as a **command**
  (`plugins/infra-kit/commands/setup.md`). A command carries **no `allowed-tools` key at all**
  (`COMMAND_FRONTMATTER_KEYS`, `manifest.test.mjs:617`), so there is no standing Bash grant anywhere; it
  names `mcp__infra-kit__setup` and lets the confirm gate drive, which only `commands/` may do (T1 is
  scoped to `SKILLS_DIR`, `manifest.test.mjs:12` vs `:615`).

**Pros.** Two names ⇒ two permission identities on the MCP axis, so the read path keeps an ungated tool
name and the click-through failure never materialises. On the Bash axis the flagless/`--skip-tools` split
keeps the installer distinguishable from the additive writer — the granularity
`.claude/settings.json:11-14` already exercises (three `ask` rules aimed at the installer, **zero** at
`init`) — and misspellings **fail closed**: the CLI sets `allowUnknownOption` nowhere, so a mistyped
`--skip-tool` errors rather than silently installing. It maps onto the owner's own words, uses the
`audit` precedent, and deletes three unpublished names outright.

**Cons.** Requires reversing the Q6 consensus (§Q6) and takes `doctor` out of the P1 gate's population,
paid for by U-D2. B's own price: no palette row (§5), a capability that needs a flag rather than the
default, and — since a plugin command has no grant to give — the plugin cannot run the installer at all,
only route the human to the gated tool. Each is answered in place; none is left open.

#### Option B — one gated `setup` tool with `mode: 'status' | 'converge' | 'update'`

**Pros.** Maximal name economy; `doctor` needs no catalog change; mirrors the shape `setup-dependency`
ships (`setup-dependency.ts:159-161`).

**Cons — invalidating.** MCP rules match tool name only, so `mode:'status'` inherits both
`requiresHumanConfirm` and `_meta['anthropic/requiresUserInteraction']`. `setup-dependency.ts:186-193`
records that one install already costs the human **two** prompts; here a harmless status check costs two
as well — the precise mechanism `setup-dependency.ts:154-158` was written to prevent. A `dryRun` variant
that skips the gate is worse: it makes the gate a function of an argument, and the confirm token is
HMAC-bound to canonical args, so an agent choosing the argument chooses the gate. **Rejected.**

*Note the asymmetry with Option A's `--tools`, since they look alike.* In Option A the argument selects
**how much work**, never **how much consent**: `setup` carries both gates whether or not `--tools` is
passed. Option B's argument selects consent. That is the whole difference.

#### Option C — keep `setup-dependency-status` as a third MCP tool while the CLI shows two

**Pros.** No change to `doctor`; P1 gate population untouched; smallest diff.

**Cons — invalidating.** The owner named all three surfaces. This leaves MCP at three tools and keeps a
name the owner asked to delete, achieving the two-command shape as a CLI cosmetic. **Rejected on the
stated goal.** Retained as the fallback if the Q6 reversal is refused at review.

#### Option D — hard-remove `init` with no alias

Folded into §1: no guard exists for a generated instruction only the removed command can rewrite.

---

## The Q6 override

`progress.txt:375-386` records a prior consensus: **"Q6 — 'delete status, move it into doctor?' —
consensus: KEEP BOTH,"** carried into the catalog as a comment at `command-catalog.ts:500-508` written
expressly so it would not be re-litigated. **The owner has now overridden it.** The override is not the
argument — if the two objections still hold, the design is unsafe regardless of who asked.

**Objection 1 — "merging needs `doctor` to become `mcpExposed: true` AND `mutating: false`, which asserts
'not mutating' about a handler that reaches `checkTokenStorePerms(fix)` and disarms the fail-closed P1
gate (`command-catalog.test.ts:238`)."**

*Answer: true of the exposed tool, and the repo already relies on this distinction.* `doctorMcpTool`
(`doctor.ts:1520-1544`) declares `inputSchema: {}` and `handler: () => { return doctor() }` — nullary,
forwarding nothing. So `options` at `doctor.ts:1396` takes its `= {}` default, `options.fix ?? false` at
`:1451` is `false`, and `checkTokenStorePerms(false)` is read-only **by construction**. `audit` has the
same shape and the same flags (`command-catalog.ts:519-525`), with a dedicated regression test at
`command-catalog.test.ts:265-274`. The precedent transfers.

*What it costs.* The P1 gate is population-based — it inspects only `mutating && mcpExposed` entries — so
`mutating: false` removes `doctor` from its watch and the gate can no longer see a future
`handler: (params) => doctor(params)`. **The `audit` precedent has this same hole**, which is why
`command-catalog.test.ts:259-264` says the flip *"is the change the ungated-mutating gate above cannot
see for itself."* Option A therefore inherits a pattern **plus a known gap**, and must close the gap with
**U-D2**. Revision 1's U-D2 could not be built (see §Test plan 5a); the replacement can, and is strictly
stronger than the `audit` precedent it borrows from.

Secondary cost: `mutating` also derives the advisory `annotations.readOnlyHint`, which becomes `true` for
`doctor` — accurate for the exposed tool, inaccurate only for the CLI command, which the annotation does
not describe.

**Objection 2 — "doctor returns ~95 rows of host state — a poor MCP answer to 'is aws installed'."**

*Answer: correct, and revision 1's answer to it was wrong.* Revision 1 proposed a sibling
`dependencies[]` array. The review established that this is a **second copy** of a list `doctor` already
owns — `gh installed` (`doctor.ts:1402`), `doppler installed` (`:1414`), `aws installed` (`:1421`),
`portless installed` (`:1299`) — with semantics documented to disagree (`checkCommand` passes iff the
binary resolves **on PATH**; the probe reports `present` and `onPath` separately, and the AWS installer
writes `$HOME/.local/bin`, so `aws` could be `checks: fail` and `present: true` in one response with no
tie-break rule). Finding accepted; the array is deleted.

**The corrected answer**: the probe's report rides as an optional `detail` on the row that already
answers the question. An agent asking "is aws installed" reads one row and, if it wants more, that row's
`detail`. There is exactly one list.

*Two scope corrections to the review's Synthesis B, both narrowing the work:*

- The review asks that the rows be "re-derived from the dependency reports". **Three of the four already
  derive from the registry**: `doctor.ts:1402`, `:1414` and `:1421` each call `specFor(<id>).probeArgv`,
  pinned by `probe-argv-single-source.test.ts`'s `UNIFIED` list. The remaining work is attaching `detail`
  and adding one genuinely new row (`brew`) — not rebuilding four rows.
- The review says *"`portless` needs an explicit decision recorded either way… Silence is not [fine]."*
  The decision is **already recorded and already pinned green**:
  `probe-argv-single-source.test.ts:46-47` asserts `DOCTOR_SOURCE` contains `resolvePortlessBin` and
  **not** `specFor('portless')`, with the reason in the test's own comment (unifying it would change the
  row's meaning from "resolvable" to "on PATH" and turn a passing check into a permanent failure). This
  plan **keeps that exclusion** and adds no `detail` to the portless row. Nothing is left silent.

*What Q6 actually traded, and why it does not bind.* The recorded trade was *"bad trade for deleting 88
lines"* (`progress.txt:381`). Here the merge is not paying for 88 deleted lines — it is the load-bearing
enabler of the two-command taxonomy on the MCP surface, and the alternative that preserves Q6 (Option B)
reintroduces the click-through failure Q6's own sibling comment forbids. The population objection Q6
closed (`progress.txt:383-385`; `install-plugin.ts:159-176` enumerates `claude-missing` / `failed` /
`unverified`, plus every non-Claude-Code host) is **unchanged and still correct** — and Option A satisfies
it, because the surviving agent-reachable read path is the MCP tool `doctor`, which needs no plugin.

---

## Decisions

### 0. Naming — `setup` is already taken, three times, in every consumer

**The CLI name is fixed by the owner and is not reopened here.** What follows is the disambiguation the
name obliges.

Measured across all four repos on this machine, `scripts.setup` is **identical in every one** —
`pnpm run runtime-set-node && pnpm install` (`infra-kit`, `starter-workspace`, `hulyo-monorepo`,
`travelist-monorepo`). So in every repo where the guidance block lives, "run setup" already resolves three
ways:

| Spelling | What it does | Mutates? |
| --- | --- | --- |
| `pnpm setup` | pnpm **builtin** — configures the global bin directory | yes |
| `pnpm run setup` | the repo's own script — set node runtime, install workspace deps | yes |
| `infra-kit setup` / `ik setup` | this plan's command — init writes + install five external tools | yes |

Under B all three are plausible readings of "set this repo up" and **all three mutate**, so a wrong guess
does not error — it succeeds at the wrong thing. `pnpm run setup` is what someone in a monorepo reaches
for by default, which makes it the most likely wrong answer.

This is the same objection `docs/infra-kit-setup-skill-plan.md` §Naming used to **reject `init`** as the
skill name (Claude Code ships a built-in `/init`, so "run init" would be ambiguous). It applies to `setup`
with more force: there, the competing meanings lived in different surfaces; here they live in the same
shell, in the same repo, and two of them install things.

**Disambiguation, binding on every generated artefact:**

1. **Every generated instruction writes the binary-qualified form** — `ik setup` or `infra-kit setup`,
   never a bare "setup". This binds `resources/root/body.md`, `readme.md`, and
   `plugins/infra-kit/README.md`. Pinned by **I-13**.

   **The two `body.md` strings, decided and quoted — because the obvious answer is a trap this plan
   authored.** Line `:4` currently reads *"This block is generated by `infra-kit init`"*. Retargeting it
   to `infra-kit setup` would print, into four consumers' committed `CLAUDE.md`, an instruction saying
   that **regenerating documentation means running the installer**. That is Scenario 5 — the human runs
   the wrong `setup` and it succeeds quietly — authored by this plan's own hand and shipped to every
   repo. So `:4` must name a **non-installing** command, and one already exists: `audit --fix` **is** the
   guidance-block writer, it already has its own row in the block, and the owner has a recorded
   preference that the writer stays `audit --fix` rather than becoming a new command.

   | Line | From | To |
   | --- | --- | --- |
   | `:4` | ``This block is generated by `infra-kit init` — edit text _outside_ the markers, never inside.`` | ``This block is generated by `ik audit --fix --root` — edit text _outside_ the markers, never inside.`` |
   | `:15` | ``- `ik init` — re-runs shell integration **and** refreshes every guidance block in the repo.`` | ``- `ik setup` — set up infra-kit on this machine: shell integration, the Claude Code plugin, the `.mcp.json` key, and the external CLIs (brew, aws, gh, doppler, portless).`` |

   The split is the point: `:15` names `ik setup` for **setting up**, and `:4` leaves **regeneration** to
   `audit --fix --root`. Neither string claims the other's job, so no reader is told that documentation
   maintenance runs a package installer. The existing `ik audit --fix` row (already present in the block)
   needs no change and is now the referent `:4` points at.
2. **The plugin command's `description` must not match on the bare word "setup"** — lead with the verb and
   name infra-kit, per the mitigation `docs/infra-kit-setup-skill-plan.md` §Naming specifies against
   OMC's own `/oh-my-claudecode:setup`. Proposed: *"Set up infra-kit on this machine — shell integration,
   the Claude Code plugin, the .mcp.json server key, and the external CLIs it needs."*
3. **`infra-kit setup` stays silent about `pnpm run setup`.** Decided, not omitted. Naming another tool's
   command in your own output is the "second copy of a list you do not own" failure (Principle 4) — the
   text would be a guess about a script this plan does not own and cannot see change. The disambiguation
   belongs in *our* spelling being unambiguous, not in narrating someone else's.
4. **`setup` gets no palette row** (§5). `command-palette.tsx:285` renders `item.name` =
   `groupPath.join(' ')` with no binary qualifier, so a row would display bare `setup` — the one place
   rule 1 cannot reach, because the plan does not control that render.

### 1. Compatibility contract for the four removed names — **split by publication status**

| Name | Published? | Contract |
| --- | --- | --- |
| `init` | Yes — all 104 npm versions | **Not an alias.** Hidden Commander command retaining `init`'s **historical contract verbatim** — the additive writes, nothing installed — plus a stderr pointer to `setup`. **Removed in 0.7.0** |
| `setup-dependency` | **No** | Hard removal, no alias |
| `setup-dependency-update` | **No** | Hard removal, no alias (becomes `setup --update`) |
| `setup-dependency-status` | **No** | Hard removal, no alias (becomes `doctor`, and flagless `setup`'s report) |

**Why `init` is preserved rather than removed.** `resources/root/body.md:4` and `:15` render into every consumer's committed
`CLAUDE.md` (this repo's copy: `/CLAUDE.md:23`, `:34`) and instruct an agent to run `ik init`. Those
blocks are rewritten only by `infra-kit init` / `audit --fix` **run inside that repo**. hulyo and
travelist run the *global* CLI: they upgrade without anyone touching their repo, so after a hard removal
their committed instruction names a command that exits non-zero, repairable only by the removed command.
Keeping `init` breaks the circularity for about eight lines.

**Why hidden and non-catalog.** Registered directly in `program.ts` as
`.command('init', { hidden: true })` with **no `commandCatalog` entry** — so the catalog stays at two
entries, `groupPaths('setup')` stays honest, it stays off the palette, and it stays off MCP (which derives
from the catalog via `getExposedMcpTools()`, `src/mcp/tools/index.ts`). "Two commands" is literally true
of every generated and rendered surface; the preserved `init` exists only for text already written down elsewhere.

**`init` is preserved, not aliased — and the plan should stop calling it an alias.** This is the sharpest
edge in the plan, and the distinction is the whole of the resolution.

Under B, flagless `setup` installs five packages. `infra-kit init` has never installed anything. Wiring
the old name to the new default would mean a **stale instruction in a consumer's committed block silently
acquires a package installer** — the instruction's text unchanged, its blast radius not. This is a live
measured path, not a hypothesis: `starter-workspace/CLAUDE.md:68,78` carries stale guidance naming
`ik init`, and that repo receives plugin changes immediately through the marketplace
(`.claude/settings.json:81`) while its committed block stays behind.

So `infra-kit init` keeps doing **exactly what it has always done**: the additive writes of `init.ts:53-127`,
and nothing else that writes. It additionally probes and reports — five `--version` spawns, read-only — so
the precise claim is **no new *write***, not "no new work". It then prints:

```
infra-kit init is deprecated and will be removed in 0.7.0.
Its replacement is `infra-kit setup`, which does everything init does AND
installs or updates brew, aws, gh, doppler and portless.
For init's behaviour without the installs, use `infra-kit setup --skip-tools`.
```

The framing matters for what it buys: **nothing any existing instruction can reach changes what it does**,
and the only way to get the installer is to type the new name. That is a property a reviewer can check in
one line, where "the alias is safe because it maps to a safe flag" is a property they have to trace.

*Two alternatives, rejected with reasons.* **Hard removal** — no guard exists for stale guidance that only
the removed command can rewrite (§Consumer evidence, and Option D). **Alias-with-warning that still
installs** — the worst of the three to be on the receiving end of: the warning arrives on stderr *after*
the packages are on the machine, and a warning does not stop an agent mid-run.

**Removal version is fixed at 0.7.0.** Revision 1 said "≥2 minor releases" while also requiring the
warning to name its removal release — which made the warning string unwritable. Current published version
is 0.4.0.

**Why no alias for the trio — measured, not inferred.** The published artifact
(`https://registry.npmjs.org/infra-kit/-/infra-kit-0.4.0.tgz`) was pulled and grepped. In
`package/dist`:

| Needle | Occurrences in the published bundle |
| --- | --- |
| `setup-dependency` | **0** |
| `setup-dependency-status` | **0** |
| `dependency-registry` | **0** |
| `dependency-install` | **0** |
| `.command("init")` | **present** |
| `.command("setup")` | **absent** |

So the trio has never shipped, `init` is published Commander surface exactly as this section assumes, and
the CLI name `setup` is free in the *published* surface as well as in the working tree. Corroborating:
`git log --all --oneline -- '*setup-dependency*' '*dependency-registry*' '*dependency-install*'` is empty
across every ref; `git tag` = 0; local version == published version == 0.4.0. The three
`.claude/settings.json` grants naming the trio (`:11-14`) are themselves uncommitted.

Deleting an unpublished name is free exactly once; carrying it into a release spends that. **That right
is now measured to still exist**, so §6 spends it rather than deferring the question.

**How to re-verify, because the obvious method does not work.** `npm view` lists versions, not command
names, and the published artifact is a **bundled esbuild dist of 43 files** — so listing tarball
*filenames* proves nothing either: a command's source file has no separate entry in the bundle. "Is name
X published?" is answerable only by grepping the bundle contents:

```
npm pack infra-kit@<version> --pack-destination /tmp && \
  tar -xzOf /tmp/infra-kit-<version>.tgz | grep -c '<name>'
```

**Consumer evidence — observed, not inferred.** All four consumer repos are on this machine and were read
directly. Every site is inside a generated guidance block:

| Repo | Sites | Block state |
| --- | --- | --- |
| `/Users/arthur/projects/hulyo-monorepo` | `CLAUDE.md:182`, `:193` | current |
| `/Users/arthur/projects/travelist-monorepo` | `CLAUDE.md:271`, `:282` | current |
| **`/Users/arthur/projects/starter-workspace`** | **`CLAUDE.md:68`, `:78`** | **stale** |
| `/Users/arthur/projects/infra-kit` (self) | `CLAUDE.md:23`, `:34` | current |

**starter-workspace is a live instance of the premise this section rests on**, and the cleanest single
citation is machine-readable rather than prose: its block carries
**`<!-- infra-kit:version 0.3.14 -->` at `CLAUDE.md:63`**, against a published 0.4.0 — while hulyo
(`:177`), travelist (`:266`) and this repo (`:18`) all read `0.4.0`. One consumer is two minor versions
behind in a marker the tooling itself writes.

The prose drift is worse than one line. Its block says *"`ik init` — (re)install shell integration and regenerate these
agent-instruction files"* against the current body's *"re-runs shell integration **and** refreshes every
guidance block in the repo"* — and it is also **missing `ik audit --fix` entirely**, **missing
`release remove`** from the release line, and still writes `*outside*` where all three other repos write
`_outside_` (the prettier normalization this repo has recorded). Four independent drifts in one block.

That is the argument for preserving `init`, no longer argued: a consumer's committed block **does not self-heal on
a global CLI upgrade** and drifts arbitrarily far behind, because only `infra-kit init` / `audit --fix`
*run inside that repo* rewrites it. Under B this is also the argument for `init` keeping its own contract rather than mapping to
`--skip-tools` — a block this far behind is exactly the one that would silently acquire an installer.

*Plugin reach needs no separate edit.* starter-workspace consumes the plugin through the marketplace
(`.claude/settings.json:81` `"infra-kit@infra-kit": true`; marketplace entry `:102-105`) and carries **no
local copy** of the infra-kit plugin skills — its `.claude/skills/` holds only `omc-reference`,
`excalidraw-diagram`, `shadcn`, `skill-creator`. A plugin change reaches it automatically; its only edit
is the two `CLAUDE.md` lines.

**Real edit sites** (narrowed from ~213 raw grep hits; `docs/**` excluded as historical record):

*Instruction sites:*
- `resources/root/body.md:4`, `:15` — the generated root guidance body, the source of all four blocks above.
- `/CLAUDE.md:23`, `:34` — this repo's rendered copy; regenerated by `audit --fix --root`.
- The three consumer repos' `CLAUDE.md` blocks at the lines tabled above — regenerated in each repo, by
  its owner, after the publish (§Landing step 3).
- `readme.md:72` (Setup table row), `:100-109` (the exposed-tools bullet list **and** the
  "21 tools total" count — both must be recomputed from the catalog; note the count is already stale with
  respect to the untracked trio), `:111` (the "Not exposed" list, which names both `doctor` and `init` and
  becomes wrong twice over).
- `plugins/infra-kit/README.md` — 8 hits: skill inventory row and setup narrative.
- `.claude/settings.json:11-14` — see §3 for the replacement rules.

*Code sites:*
- `command-catalog.ts:489` (`init`), `:491-497` (`doctor`), `:511-518` (`setup-dependency-status`),
  `:582-601` (`setup-dependency`, `setup-dependency-update`), `MCP_TOOL_PRESENTATION:646`.
- `program.ts:663-685` (three registrations), `:711-717` (`init`), `:384` (`AUTO_LOAD_EXCLUDED`: `init` →
  `setup`; `doctor` stays).
- **`src/mcp/__tests__/mcp-stdio.e2e.test.ts:253` — `expect(actual).not.toContain('doctor')`.** Exposing
  `doctor` reds this, and **the tempting repair is to delete the line**, which its own comment (`:250-252`)
  warns against: *"the natural 'fix' is to loosen the assertion — which destroys the drift guard this
  exists to be."* **The correct repair is to invert it, not remove it:** `expect(actual).toContain('doctor')`,
  keeping `toEqual(expected)` and the `size > 20` floor untouched. The guard's purpose is that the exposed
  set matches the catalog-derived set; `doctor` moving from excluded to included is a change of expected
  membership, not a reason to stop checking membership.
- `src/mcp/tools/index.ts:10-11` — the comment *"doctor is intentionally excluded there (host-inspecting)
  and must never be registered here"* becomes **false**; and `:45` — *"`anthropic/requiresUserInteraction`
  rides here on the two setup-dependency tools"* becomes false. Both must be rewritten, not deleted: they
  are the only in-code narration of why the exposure list looks as it does.
- `src/commands/init/init.ts` → the init half moves under `src/commands/setup/`.

*Mention-only, no change* (recorded so review does not chase them): `init.ts`'s internal migration JSDoc,
`migrate-config.ts`, `plugin-pointer/*`, `constants.ts`, `vitest.setup.ts`, `vendor config --init`
(`program.ts:344-347` — an unrelated flag), and all `docs/*.md`.

### 2. What `infra-kit setup` does, in order

**Flagless `infra-kit setup` — the full job (owner decision B):**

```
1. init half   (local writes, offline, additive-and-never-overwrite, near-instant)
   a. .zshrc managed block                                     init.ts:54-70
   b. four migrations, in the recorded order                   init.ts:75-89
   c. seedUserGlobalConfig()                                   init.ts:91
   d. syncAgentGuidance()   — non-fatal, gated resolveInfraKitRoot   init.ts:97
   e. resolveGitRootForWrites() + warnOnGateDisagreement       init.ts:108-110
   f. syncPluginPointer()   — .claude/settings.json, .mcp.json, plugin install   init.ts:112
   g. reseedUserProjectConfig()                                init.ts:115
   h. non-zsh $SHELL warning                                   init.ts:118-127
2. dependency CONVERGE  (install missing / update present, serial in registry order;
   `risk-predicate` refusals printed, never run)
3. one combined summary; the argv for every refused recipe, printed for the human;
   `source ~/.zshrc` reminder last
```

**Flag surface.** Three flags, all narrowing:

| Flag | Step 2 becomes |
| --- | --- |
| *(none)* | converge all five |
| `--tools <ids...>` | converge only those ids |
| `--update [ids...]` | update present tools only; never install a missing one |
| `--skip-tools` | **read-only probe** — report what is missing and the argv that would fix it, install nothing |

`--skip-tools` with `--tools` or `--update` is a usage error, not a precedence rule.

**Why `--skip-tools` still exists, since both its original motivations are gone.** Revision 3 introduced
it to be what `init` would map to, and the plugin grant's argv. Ruling 1 removed the first (`init` is
preserved, not aliased) and the command shape removed the second (a plugin command carries no
`allowed-tools` at all). The surviving justification is narrower and stands on its own: **`init` is
removed at 0.7.0, and without `--skip-tools` that removal deletes a capability rather than renaming one.**
The additive-only path has existed for 104 versions and has real users; `--skip-tools` is its successor,
and it is what the deprecation message points at for the behaviour `setup` alone no longer gives.

**What B costs, stated once.** The flagless form is now the most dangerous form, and three things follow
that revision 2 got for free and this revision must pay for:

- **The palette row goes** (§5). `run-session.ts:199` spawns `[deps.cliPath, ...command.groupPath]` with
  zero flags, so a menu row would be a one-keystroke installer — precisely what
  `command-catalog.ts:580-581` refuses — and `command-palette.tsx:285` would label it bare `setup`.
- **`init` cannot be wired to it** (§1). `init` keeps its own historical behaviour instead.
- **The plugin cannot carry a standing grant for it** (Scenario 4). The sibling plan's justification for a
  prompt-free grant is *"not flaglessness — **additivity**"*
  (`docs/infra-kit-setup-skill-plan.md` §"What makes the grant acceptable": `plugin-pointer.ts:18-19`, a
  managed block for zshrc, an unconditional layer-3 reseed). Every writer `init` drives preserves that
  property; a package installer does not, so **that justification is false of flagless `setup` and must
  not be carried across the rename**. The command shape resolves this by removing the grant entirely
  rather than re-justifying it.

**Order rationale.** The init half is local, cheap, and one of its steps (`.mcp.json` + plugin install) is
what makes the MCP surface usable at all, so it must not sit behind a network converge. The refused
recipes' manual commands (the Homebrew bootstrap and the first AWS CLI install) are the last thing the
human should read.

**Failure composition.** Both halves always run; neither short-circuits the other. Exit non-zero if
**either** hard-failed; zero if only warnings and refusals occurred (a refusal is not a failure — existing
`allSucceeded` semantics, `setup-dependency.ts:181`). The init half's existing best-effort behaviour
(`syncAgentGuidance` is explicitly non-fatal) is preserved, not tightened.

**Structured return — new in revision 2, and required.** `init()` is `async (): Promise<void>`
(`init.ts:53`) and reports entirely through `logger`; under MCP the logger writes to
`/tmp/mcp-infra-kit.log` (`lib/logger/index.ts:6,36`), **not** to the caller. As specified in revision 1,
an MCP `setup` call performed ~8 local writes and reported nothing about them. So:

- `init()` becomes `initCore(): Promise<InitReport>`, returning one entry per step:
  `{ step: 'zshrc' | 'migrations' | 'user-config' | 'guidance' | 'plugin-pointer' | 'mcp-server' |
  'project-config' | 'shell', outcome: 'written' | 'unchanged' | 'skipped' | 'warned', message: string }`.
  Every `logger` call in `init.ts` becomes an entry; the CLI wrapper logs them exactly as today, so the
  human output is byte-identical and the change is invisible on that surface.
- The merged tool's `outputSchema`:
  ```
  {
    init:      z.array(initStepSchema),        // always present
    tools:     z.array(dependencyResultSchema),// converge results, or probe reports under --skip-tools
    converged: z.boolean(),                    // false under --skip-tools; true when step 2 could act
    changed:   z.boolean(),
    allSucceeded: z.boolean(),
  }
  ```
  `tools`, `changed` and `allSucceeded` keep `setup-dependency`'s existing names and meanings
  (`setup-dependency.ts:179-183`) so the snapshot diff at
  `__snapshots__/command-catalog.test.ts.snap:265-270` reads as a rename plus two additions.

**`--fix` stays on `doctor` and stays CLI-only** — it is not part of `setup`'s flag surface, which is the
three-flag table above.

**Checked negative, recorded so review does not chase it:** the whole init graph contains no
`confirmOrExit`, no `@inquirer`, no `prompt(`, no `isTTY`. The recorded
`confirmOrExit`-skips-every-`finally` hazard and the prompts-on-the-JSON-RPC-stream hazard do **not**
apply to this composition.

**One init step shells out to the host.** `installPluginForProject` (`install-plugin.ts:155-176`) spawns
`claude plugin install`. Under the MCP `setup` tool that is the infra-kit server spawning `claude` from
inside a live Claude Code session. `isInstalledFor` short-circuits, so a configured machine spawns
nothing — but it is the one step that invokes the host, and E-2/E-3 must exercise it on an
*unconfigured* machine rather than assume the short-circuit.

### 3. The MCP `setup` tool's gate

`setup` carries `requiresHumanConfirm: true` **and** `meta: REQUIRES_USER_INTERACTION`
(`setup-dependency.ts:199`) **unconditionally — on every call, flagless included**, for the reason
`setup-dependency.ts:186-197` documents: **on an MCP call**, `_meta` is the only gate a host honours in
`bypassPermissions`; `requiresHumanConfirm` is the only one left on a host that ignores the annotation
(below Claude Code v2.1.199, and anything that is not Claude Code); and neither substitutes for
`risk-predicate`, the only control shipping inside the CLI.

**Both are MCP-axis gates and nothing else.** Neither is consulted when the same work is reached through
Bash — see Scenario 4, which is where revision 3 wrongly cited `_meta` as a Bash-path control. Everything
in this section describes `mcp__infra-kit__setup`; the Bash axis is governed by the `ask` list below,
`risk-predicate`, and nothing more.

It does **not** go on `LOW_RISK_MUTATING_ALLOWLIST`: `command-catalog.ts:576-578` — the allowlist
*asserts* low risk, which would be a false claim for a command that can install software.

**The read path keeps its own tool name.** This is the whole resolution of the name-only-matching problem:
`doctor` is a different tool name, therefore a different permission identity, therefore an
`mcp__infra-kit__doctor` allow rule cannot be widened into a `setup` grant and a status check raises no
prompt.

**Answering the review's prong 1 — where the write/write granularity survives.** The review is right that
`.claude/settings.json:11-14` today expresses a distinction (three `ask` rules on the installer, zero on
`init`) that one MCP tool name cannot express. The distinction survives on the axis where rules are
argv-shaped:

Under B the polarity inverts from revision 2: the **flagless** form is the one that must be asked about,
and `--skip-tools` is the safe spelling.

```jsonc
"ask": [
  "mcp__infra-kit__setup",           // both forms — correct, the tool is gated either way
  "Bash(infra-kit setup)",           // flagless == the installer, under B
  "Bash(infra-kit setup --tools:*)",
  "Bash(infra-kit setup --update:*)"
]
```

`Bash(infra-kit setup --skip-tools)` and `Bash(infra-kit init)` are deliberately **absent from `ask`** —
both are the additive form, and `init` is absent today for exactly this reason. Under Ruling 1 `init` is
preserved rather than rewired, so **no existing rule in any consumer's settings changes meaning**; that
is the property §1 is buying. On the MCP axis the collapse is moot because
consent there is unconditional and set at the maximum: an agent that omits every flag still faces both
gates, so nothing is under-consented.

**Residual limitation, stated:** these are prefix matches and are order-sensitive, so
`infra-kit setup --update --tools gh` defeats the third rule, and no `ask` list can enumerate every
spelling of the installing form (`npx`, `pnpm exec`, an absolute `node …/cli.js`). The Bash rules are
defence in depth. **The controls are the MCP gate and `risk-predicate`** — and this is precisely why
Scenario 4 concludes that the installing path must not be reachable through a *standing grant* at all,
since a grant, unlike an `ask` rule, is not a prompt.

**`formProvider` not adopted in v1.** The seam exists with two live users (`gh-release-deploy-all.ts:145`,
`gh-release-deploy-selected.ts:254`, via `lib/deploy-form`). Deferred — the gate carries the safety, and a
form is collected *on the way into* the gate, never instead of it (`types.ts:85-91`).

### 4. `doctor` becomes `mcpExposed: true, mutating: false`, and **unifies** the dependency rows

Concretely:

- `command-catalog.ts:491-497`: `mcpExposed: false` → `true`, `mutating: true` → `false`.
- `doctorMcpTool` (`doctor.ts:1520-1544`): `inputSchema` **stays `{}`**; the handler **stays nullary**.
  Both are load-bearing and both are pinned (U-D1, U-D2).
- `CheckResult` gains an optional `detail?: DependencyDetail` —
  `{ manager, version, present, onPath }`. Optional, so the ~23 non-producing check functions are
  untouched; this is the shape `progress.txt:376-378` already records the critic blessing as costing them
  nothing.
- The three registry-derived rows (`gh installed` `:1402`, `doppler installed` `:1414`,
  `aws installed` `:1421`) attach `detail`. Their **pass/fail meaning is unchanged** — still
  "resolves on PATH" — so no existing row flips.
- One genuinely new row, `brew installed`, requiring a deliberate `SECTION_MEMBERS` edit (`report.ts:64`)
  — and **only** that: `DOCTOR_CHECK_NAMES` (`report.ts:113`) is `SECTION_MEMBERS.flatMap(…)`, so it is
  derived, not a second list to edit. `:64` is the single edit site. Revision 1 chose its design partly to avoid this; that was
  architecture settled by test convenience, and `report-inventory.test.ts` exists precisely to force a
  legible diff here. **Verify against the parallel session's `report.ts` before editing.**
- `portless installed` (`:1299`) is **excluded from unification and gets no `detail`**, keeping the
  invariant `probe-argv-single-source.test.ts:46-47` already pins green.
- `MCP_TOOL_PRESENTATION` (`command-catalog.ts:646`) gains a `doctor` entry with **`openWorld: true`** —
  `doctor` reaches `gh auth status` / `doppler` / `aws`; declared, not derived (`command-catalog.ts:635`).
- Safety is carried by **U-D2**, not by the P1 gate, which no longer sees `doctor`.

**The one-way seam (review V2), answered by construction rather than by needle.**
`probe-argv-single-source.test.ts:34-39` declares: *"the registry owns 'how do I ask this tool for its
version'; what would FIX a failing row belongs to `setup-dependency*`. A doctor that could install is
`doctor --fix` by another door."* Revision 1 had `doctor` consume `setupDependencyStatus()`, whose payload
carries `action` and `commands` **derived from the install recipes** (`setup-dependency-status.ts:63-74`)
— crossing the seam while the guard, a `DOCTOR_SOURCE` substring check, stayed green because the needles
moved one module away. Finding accepted. The corrected design:

- `doctor` composes from `lib/dependency-probe` + `lib/dependency-registry` **directly**, never from
  `setupDependencyStatus()`.
- `DependencyDetail` carries probe facts only — `{manager, version, present, onPath}` — and **no**
  `action`, **no** `commands`. Doctor still cannot name a fix beyond the static install URLs it already
  prints.
- The seam guard is strengthened so relocation cannot defeat it again: add
  `expect(DOCTOR_SOURCE).not.toContain('setupDependencyStatus')` and a **type-level** assertion that
  `DependencyDetail` has no `action` / `commands` key. A needle check catches a name; the key assertion
  catches the capability. Mutation: importing `setupDependencyStatus` into `doctor.ts`, or widening
  `DependencyDetail` to the full report.

### 5. Menu-group placement — **`setup` takes `menuGroup: null`**

`groupPaths('setup')` is pinned in **two** places, both of which must change from
`['init','doctor','setup-dependency-status','audit','version']` to
**`['doctor','audit','version']`**:

- `command-catalog.test.ts:378`
- `palette.test.ts:59` (`['Setup & Diagnostics', [...]]`) — missed in revision 1

**Why the row is dropped rather than defended — two independent reasons, either sufficient.**

1. **It would be a one-keystroke installer.** `run-session.ts:199` spawns
   `[deps.cliPath, ...command.groupPath]` with **zero flags**, and `groupPath` is command tokens — flags
   are not Commander leaves, so `resolveLeaf` cannot address a narrowed form and the palette has no way to
   show a row that runs anything but flagless `setup`. That is exactly what `command-catalog.ts:580-581`
   refuses: *"installing software is a deliberate act rather than something to land on by arrowing a
   menu."* Revision 2 escaped this by making the flagless form additive; B removes the escape, so the
   recorded decision is honoured the only remaining way — `setup` joins `setup-dependency` off the menu,
   for the identical reason and with the identical wording available to justify it.
2. **It is the one place §Naming's mitigation cannot reach.** `command-palette.tsx:285` renders
   `{item.name.padEnd(nameWidth)}`, where `item.name` is `groupPath.join(' ')` (`palette.ts:67`) — **no
   binary qualifier**. §Naming rule 1 binds every *generated* instruction to write `ik setup`, but the
   palette row is not generated text; it is a render this plan does not control. A bare `setup` row, next
   to a `pnpm run setup` that also mutates, is the naming collision at its most confusable.

**The cost, stated.** This is a real regression against today: `init` *is* a menu row
(`command-catalog.ts:489`), and a user who arrows to it gets their shell set up. That affordance
disappears. Three things blunt it and none of them fully replaces it: the hidden `init` still works
for muscle memory until 0.7.0; `doctor` remains in the group and is the command that *tells* you what is
missing; and the plugin skill (Scenario 4) covers the Claude Code path. A user who wants the old
one-keystroke behaviour must type `infra-kit setup --skip-tools`.

**This is the one decision in the plan that is cheap to reverse.** Nothing else depends on it: `menuGroup`
feeds only palette rendering and the two pinned lists above. If the owner would rather keep the row and
accept a one-keystroke installer, flip `menuGroup: null` → `'setup'` and restore `'setup'` to both lists —
no other section changes.

Harmless namespace overlap: `MENU_GROUPS` already has a group keyed `'setup'`
(`command-catalog.ts:125`) and the new command is `cliName: 'setup'`. Different namespaces; it will read
oddly in a diff. The CLI name `setup` is **free** (no `command('setup')` in `program.ts`, no
`cliName: 'setup'` in the catalog).

### 6. Sequencing against the dirty tree — **fold before the trio lands**

**Chosen: the three `setup-dependency*` names never reach a published version.** This is no longer a
judgement call between two defensible options. The right to delete a name without a deprecation cycle
exists exactly once, while the name is unpublished — and §1 **measured** that it still exists (0
occurrences of `setup-dependency` in the published 0.4.0 bundle). Committing the trio and then merging it
away spends a right the plan can see, in exchange for nothing: there is no consumer to protect, because
no release contains them. It would also oblige an honest plan to give them aliases — the same argument
that earns `init` one — permanently enlarging the surface the owner asked to shrink. Folding first is the
only option that does not throw away a measured asset.

*The counter-argument, answered.* The trio's implementation is not wasted: `setup` needs all of
`lib/dependency-{registry,probe,plan,install}` and `risk-predicate` unchanged, and `doctor` needs
`dependency-probe` + `dependency-registry`. This is a rename plus a composition. Two commits:

- **Commit A (no surface change):** `lib/dependency-*` and `risk-predicate` land as-is with their tests.
  Nothing in `command-catalog.ts` / `program.ts` / `resources/` changes.
  **Explicitly: `src/commands/setup-dependency/`, `src/commands/setup-dependency-status/`,
  `setup-dependency-gate-mutation.test.ts` and `probe-argv-single-source.test.ts` stay in the working
  tree across Commit A.** They are not landable there (they need catalog entries) and not deletable
  before Commit B consumes their bodies. Phase 1's acceptance criterion is about the *staged diff*, not
  about a clean tree.
- **Commit B (the surface):** `src/commands/setup/`, catalog, `program.ts`, the hidden `init`, the
  doctor changes, resources/readme/settings, and the deletion of the trio's command directories.

*Coordination.* `doctor.ts` and `report.ts` are being edited by a parallel session and by the in-flight
`docs/infra-kit-setup-skill-plan.md` commit 1 (which added `fixable` and `cliVersion` to doctor's payload
and split `resolveGitRoot`/`resolveInfraKitRoot` — both appear present and uncommitted). Commit B rebases
onto whatever lands there rather than racing it. That plan's §Landing ordering is **reused, not
reinvented** (§Landing below).

---

## Deliberate-mode pre-mortem — five scenarios

### Scenario 1 — `doctor --fix` becomes agent-reachable

**What breaks.** Someone tidies `doctor.ts:1541-1543` to `handler: (params) => doctor(params)`, or adds
`fix: z.boolean().optional()` to the empty `inputSchema` "so the tool can report what it would fix".
`doctor` is `mutating: false`, so it is **outside** the P1 gate's population
(`command-catalog.test.ts:243-256`) and CI stays green.

**How it reaches a user.** `tool-handler.ts:466` injects `confirmedCommand: true` into every MCP call. An
agent calls `mcp__infra-kit__doctor({ fix: true })` with no prompt and no confirm token;
`checkTokenStorePerms(true)` (`doctor.ts:1451`, def `:567`) chmods the Doppler token store, plus every
other `--fix` write.

**The guard.** **U-D2** — `handler.length === 0` reds the first mutation the instant it is typed; **U-D1**
reds the second. Revision 1's U-D2 could not catch either (§5a).

### Scenario 2 — hulyo's agent is told to run a command that no longer exists

**What breaks.** hulyo/travelist upgrade the global `infra-kit` (no local pin). Their committed
`CLAUDE.md` still carries a block whose `/CLAUDE.md:34` equivalent says ``ik init` — re-runs shell
integration **and** refreshes every guidance block`.

**How it reaches a user.** An agent follows its own project instructions, runs `infra-kit init`, gets
"unknown command" and exit 1, and reports infra-kit as broken. The block that told it to do that is
rewritten only by `infra-kit init` / `audit --fix` **run in hulyo** — the command that just failed.

**The guard.** The preserved `init` (§1) turns the failure into a warning; **I-3** asserts it resolves, is
hidden, warns, and still installs nothing. A hard removal has *no* available guard, which is why Option D was folded away.

### Scenario 3 — the prompt-free read path is lost, and humans learn to click through

**What breaks.** `detail` is dropped from doctor's rows during review as "redundant with the CLI report",
or a later refactor moves the probe behind `doctor --fix`.

**How it reaches a user.** The only agent-reachable route to "is aws installed" becomes the gated
`setup` — two prompts per harmless question (`setup-dependency.ts:186-193`) — so the human starts
approving `setup` reflexively, at which point the gate protecting the actual install is worthless. This is
exactly the failure `setup-dependency.ts:156-158` names.

**The guard.** **I-2**, stated over the *registered* tool population rather than by tool name, so it
survives a rename and reds on the deletion.

### Scenario 4 — an agent routes around the absent grant, and lands the installer unprompted

*Revision 2 framed this as "the grant is a hole to fence." Under B there is no grant at all — the plugin's
`setup` is a **command**, and `COMMAND_FRONTMATTER_KEYS` (`manifest.test.mjs:617`) admits only
`argument-hint`, `description`, `name`. A command cannot carry `allowed-tools`, so the standing-grant
question is not answered, it is **deleted**. The residual risk inverts: the danger is what an agent does
when the grant it wants does not exist.*

**The shape Phase 7 ships.** `plugins/infra-kit/commands/setup.md`, modelled on `release-create.md:6-9`,
which does exactly this today: read the served resource, and fall back to naming the MCP tool and letting
its confirm gate drive. T1 (`manifest.test.mjs:588`) walks `SKILLS_DIR` only (`:12` vs `:615`), so a
command **may** name `mcp__infra-kit__setup` — the exemption `manifest.test.mjs:608-612` describes in so
many words as *"precisely what LETS a command name an MCP tool, which a skill may never do."*

**What breaks.** The command routes the human to the gated MCP tool. An agent that would rather just run
it reaches for a Bash spelling: `infra-kit setup`, `npx infra-kit setup`, `pnpm exec infra-kit setup`,
`node …/cli.js setup`, or `brew install gh` directly. None matches an allow rule, so in `default` and
`acceptEdits` each **prompts** — the fail-safe direction. **In `bypassPermissions` an unmatched Bash
command simply runs**, and the workaround succeeds unprompted.

**What actually stops it — and the two axes do not cross.** Revision 3 answered this by citing
`_meta['anthropic/requiresUserInteraction']`, which was **wrong for this path**. `_meta` rides on the MCP
`tools/list` entry and is consulted on an MCP call; **it is never consulted on a Bash invocation**, and
this scenario is entirely about Bash spellings. The axes are independent in both directions: a Bash
`ask` rule never gates an MCP call, and MCP `_meta` never gates a Bash call. So on this path the only
in-CLI control is `risk-predicate`, which refuses the two network-script recipes and **permits the other
three**.

The honest answer is stronger than the patch would have been: **in `bypassPermissions` the ambient risk
dominates, and infra-kit adds no marginal exposure.** An agent that can run arbitrary Bash unprompted can
run `brew install gh` whether or not `infra-kit setup` exists. The mode's own contract is that unmatched
commands run; this plan neither widens nor narrows that, and claiming a gate here would be claiming
credit for a control that is not on the path.

**Why a CLI-side confirm is not the fix.** The tempting repair — prompt inside `setup` before installing —
is refused by a recorded hazard in this repo: `confirm-or-exit.ts:77` calls `process.exit(0)` on an
interactive decline, and its own JSDoc (`:44`) states that `process.exit` **skips every `finally`**, so
any resource acquired before the prompt leaks on the most ordinary exit. Adding a confirm to the `setup`
CLI path would put that hazard on the busiest new command in the plan. `_meta` and `requiresHumanConfirm`
stay where they belong — as the **MCP-axis** gates in §3 — and are not cited as Bash-axis controls
anywhere.

**The guard — three parts. These are load-bearing now, not defence in depth:** revision 2's structural
first guard (a flagless form that could not install) is gone, so nothing upstream absorbs a miss here.

1. **No `allowed-tools` anywhere in `commands/`.** Enforced already by U14's `deepEqual` on
   `COMMAND_FRONTMATTER_KEYS` — adding the key reds it. **I-9** restates it against `setup.md` explicitly
   so the guarantee is greppable from this plan.
2. **`MUTATING_INVOCATIONS` gains a bare `'infra-kit setup'` needle, and U15 goes global.** The list is
   **five** needles at `manifest.test.mjs:479-485`, not three: `'--fix'`, `'infra-kit init'`,
   `'audit --fix'`, `'setup-dependency'`, `'setup-dependency-update'`. `'--fix'` and `'audit --fix'`
   **survive**; `'infra-kit init'` **survives until 0.7.0**, because `init` still exists and still writes;
   the two `setup-dependency` needles go with the names. Add `'infra-kit setup'`. The **permitted map is
   `{}`** — no skill is permitted any mutating fence, `setup` included, because there is no `setup`
   *skill*. Delete the prefix caveat at `:475-478`: it is about `setup-dependency` ⊂
   `setup-dependency-status`, and both names die in Phase 3. **I-10.**
3. **The publish gate binds the command to a served resource and a version floor** —
   `publish-gate.test.mjs:18-26` (`floor`, `uri`) and G-A5 (`:79-87`, *"a command naming no workflow URI is
   a violation"*). This is what stops the command shipping before the CLI that serves
   `infra-kit://workflow/setup` is published. **I-12.**

### Scenario 5 — the human runs the wrong `setup`, and it succeeds

**What breaks.** A guidance block, a skill, or a person's memory says "run setup". In every consumer repo
that resolves three ways (§Naming), and **all three mutate**: `pnpm setup` reconfigures the global bin
directory, `pnpm run setup` sets the node runtime and installs workspace deps, `infra-kit setup` installs
five external CLIs.

**How it reaches a user.** Nothing errors. `pnpm run setup` is the default reach in a monorepo and it
succeeds — so the person believes they have set up infra-kit when they have installed workspace
dependencies, and the shell integration, `.mcp.json` key and external CLIs are all still missing. The
symptom surfaces later and somewhere else: `env-load` does nothing, or `doctor` reports rows the user
thought they had just fixed. The inverse is worse in a shared checkout — reaching for `infra-kit setup`
when workspace deps were meant installs five global CLIs nobody asked for.

**Why it is likely rather than exotic.** The two wrong answers are the *more familiar* commands, and this
plan's own generated text is what puts the word in front of the reader. Under revision 2's additive
default the cost of a wrong guess was small; under B every branch mutates.

**The guard.** §Naming rules 1, 2 and 4 — the binary-qualified form in every generated instruction
(**I-13**), a plugin description that does not match on the bare word, and no bare `setup` palette row
(§5). Mutation that reds I-13: writing "run `setup`" or "`setup` — …" in `resources/root/body.md` instead
of `ik setup`. **Explicit non-guard:** `infra-kit setup` does not mention `pnpm run setup` in its output
(§Naming rule 3) — that would be a second copy of a list this plan does not own.

## Test plan

Every entry names the mutation that reds it. Revision-2 changes are marked **(rev2)**.

### Unit

| # | Test | Mutation that reds it |
| --- | --- | --- |
| U-C1 | `commandCatalog` contains `setup` and `doctor` and **no** entry whose `cliName` matches `/^(init\|setup-dependency)/` | Leaving any of the four old entries; adding a catalog entry for the preserved `init` |
| U-C2 **(rev3)** | `groupPaths('setup') === ['doctor','audit','version']` at **both** `command-catalog.test.ts:378` **and** `palette.test.ts:59` — `setup` is absent because it takes `menuGroup: null` (§5) | Editing one list and not the other (revision 1 cited only the first, so the suite would have redded); **or leaving `setup` in either list**, which is the observable symptom of a `menuGroup: 'setup'` that would put a one-keystroke installer in the picker |
| U-C3 **(rev3, reason corrected)** | Retarget the untracked `setup-dependency-gate-mutation.test.ts`'s `INSTALLERS` (`:35`) from `['setup-dependency']` to `['setup']` | Right test, and revision 2 stated its reason wrongly. It performs **one** mutation — the `requiresHumanConfirm: undefined` strip at **`:42`** — and `:55-59` *asserts* the allowlist exclusion (`expect(LOW_RISK_MUTATING_ALLOWLIST).not.toContain(cliName)`) rather than performing a second. Still stronger than field assertions, and it **reds on Phase 3 as-is** because it hardcodes a removed name, so retargeting is not optional |
| ~~U-C4~~ **(rev2, demoted)** | *Was:* "the P1 gate test is left unmodified". A test cannot assert its own source is unchanged. **Now a Phase 3 acceptance criterion.** | — |
| U-C5 **(rev2, rewritten)** | `EXPECTED_PARITY` (`command-catalog.test.ts:298-326`) **gains** `setup: 'setup'` and **loses** `'setup-dependency'` and `'setup-dependency-status'` (`:324-325`) | Revision 1 proposed adding `doctor: 'doctor'`, which is **already present at `:315`** — a no-op edit proving nothing. The map keys on `entry.mcpTool` existing, not on `mcpExposed`, so the flip does not touch it |
| U-C6 **(rev2)** | `EXPECTED_GATED_TOOLS` (`command-catalog.test.ts:209`) has `'setup'` where `'setup-dependency'` was | Renaming the catalog entry without repinning the gated set |
| U-D1 | `doctor` entry is `{mcpExposed:true, mutating:false}` **and** `doctorMcpTool.inputSchema` has zero keys | Adding any input key — including a "harmless" one |
| **U-D2 (rev6, positive control added — BOTH REQUIRED)** | **(a)** `expect(doctorMcpTool.handler.length).toBe(0)`. **(b)** One test, one fixture, **two assertions in opposite directions**: on a real temp-dir store with genuinely loose modes, `await doctor({ fix: true })` **DOES** call `fs.chmodSync` (positive control), and `await doctorMcpTool.handler(…)` **does NOT** (the invariant) | (a) reds `handler: (params) => doctor(params)` but is bypassed by `(params = {}) => …` and `(...args) => …`, which both report length `0`. (b) reds all three — **and the positive half is what makes the negative half mean anything**. See §5b: `checkTokenStorePerms` has **four** paths that reach zero chmods on correct *and* mutated code, so a bare negative is green on most machines and on CI |
| U-D3 **(rev2)** | `CheckResult.detail` parses a probe payload for `gh`/`doppler`/`aws`/`brew`; `portless installed` carries **no** `detail`; `DependencyDetail` has no `action`/`commands` key | Dropping `detail` (Scenario 3); unifying portless against `probe-argv-single-source.test.ts:46-47`; widening `detail` to the full status report (crosses the seam) |
| U-D4 **(rev2)** | Seam: `DOCTOR_SOURCE` contains neither `bootstrapInstall`, `updateFor`, nor `setupDependencyStatus` | Importing the status command into `doctor.ts` — the exact relocation that walked through the guard in revision 1 |
| **U-D5 (rev8)** | `doctor.ts` source contains the exact string `import fs from 'node:fs'` | **Guards U-D2(b)'s seam.** `vi.spyOn(fs,'chmodSync')` intercepts only a *default* import; a named import defeats it **silently** — zero calls observed and the real write still happens. This repo's post-edit formatter is recorded to rewrite imports, so the risk is live, and this is the test that has been wrong in four revisions. Mutation: rewriting `doctor.ts:1` to `import { chmodSync } from 'node:fs'`. The failure message must name the consequence, not merely the missing string |
| U-S1 | `setup` runs the init half then the dependency step, in that order | Reordering; short-circuiting the second on an init warning |
| U-S2 | An init-half **throw** still runs the dependency step, and the aggregate exit is non-zero | `return` on first failure |
| U-S3 | A `risk-predicate` refusal ⇒ `allSucceeded: true` with commands printed; a real install failure ⇒ `false` | Conflating refusal with failure either way |
| U-S4 | `setup --update` reaches the registry with update-only semantics and never the install path | Dropping `--update` in the merge, silently turning update-only into converge |
| **U-S5 (rev5, behavioural)** | **`infra-kit init` never reaches `lib/dependency-install`.** With that module mocked, running `init` records **zero** calls; flagless `setup` records one per missing tool | The stale-guidance invariant (`starter-workspace/CLAUDE.md:78`): the deprecated name never gains an installer. Stated over *behaviour*, not code path — §2 says `init` and `setup --skip-tools` are the **same operation**, so an implementation sharing one function must PASS. Mutation that reds it: wiring `init`'s action to the flagless `setup` path |
| **U-S7 (rev5)** | `setup --skip-tools` never reaches `lib/dependency-install` (zero calls); `--skip-tools` combined with `--tools` or `--update` is a **usage error**, not a precedence rule | The same invariant on the form that survives `init`'s 0.7.0 removal. U-S5 and U-S7 are deliberately the same assertion over two entry points — that is what lets one implementation serve both. Mutation: making `--skip-tools` a no-op flag, or letting `--tools` silently override it. Misspellings are **not** a hazard here: `allowUnknownOption` appears nowhere in the CLI, so `--skip-tool` errors rather than installing |
| **U-S6 (rev2)** | The MCP payload carries one `init` entry per `initCore` step, with outcomes | Reverting `initCore` to `Promise<void>` / logger-only, which reports nothing to an MCP caller |

### Integration

| # | Test | Mutation that reds it |
| --- | --- | --- |
| I-1 | Build the program; `resolveLeaf(commands, ['setup'])` and `['doctor']` resolve; the three `setup-dependency*` paths resolve to `undefined` | A stale `program.ts` registration left behind — invisible otherwise, because `palette.ts` skips an unresolvable entry silently |
| I-2 **(rev2)** | Over `getExposedMcpTools()`: exactly two tools; and some tool with `requiresHumanConfirm !== true` reports all five dependency ids **each with a `present` boolean** | Revision 1's "reports five ids" was satisfiable by a stub returning five ids and nothing useful |
| I-3 **(rev5, behavioural)** | `resolveLeaf(commands, ['init'])` resolves, is `hidden`, **installs nothing when run** (asserted via the mocked `lib/dependency-install`, exactly as U-S5), and warns naming 0.7.0, `infra-kit setup`, and `setup --skip-tools` | Revision 3 asserted it "runs the preserved init path (not `setup`)", which pinned an **implementation distinction the plan denies elsewhere** — §2 states `init` and `setup --skip-tools` are the same operation, so sharing one function would have failed I-3 while duplicating it invited drift. Restated over behaviour: reds on removing it early, promoting it to visible/catalog, a warning naming no release, or any wiring that installs |
| I-4 **(rev9, corrected in Phase 3 — do NOT "fix" the code back to revision 8's wording)** | `AUTO_LOAD_EXCLUDED` (`program.ts`) contains `setup` **and still contains `init`**. Asserted BEHAVIOURALLY, over a mocked `runEnvAutoLoad`: neither `infra-kit setup` nor `infra-kit init` fires the cli-invocation auto-load, while a non-excluded command (`config-get`) does — so the test survives the set being renamed or restructured. Note `version` is itself excluded and is therefore the wrong choice for that positive control | Revision 8 said "contains `setup`, **not** `init`", which was wrong and would have caused a regression. The set is keyed on the INVOKED COMMAND NAME, and `init` is still invokable — that is the entire reason §1 preserved it. Dropping it would hand a name published in all 104 versions a side effect it has never had (a Doppler env-load file written into the session cache), on the one command a user runs BEFORE doppler is installed, i.e. when there is nothing to prime from — the same class of silent contract change that §1 refuses when it declines to alias `init` to `setup`. It leaves with `init` in 0.7.0. Mutations that red it: forgetting to add `setup` (a config auto-load on the shell-startup path); removing `init`; or dropping the positive control, which would leave both negatives green on a build where the auto-load is unreachable from every command |
| **I-5 (rev3, commands not skills)** | `EXPECTED_COMMANDS` (`manifest.test.mjs:616`) gains `'setup.md'`; U13 green. `EXPECTED_SKILLS` (`:19-27`) is **unchanged** — there is no `setup` skill | Shipping the command file without the inventory edit, or vice versa. Also reds if someone adds it as a skill instead, which would re-import the T1 problem |
| **I-6 (rev3)** | U14 green for `setup.md`: frontmatter keys exactly `['argument-hint','description','name']`, `name` equals the filename stem, body **exactly 3 non-empty lines** (`manifest.test.mjs:637`, an equality not a cap) | A 4th body line, or any added frontmatter key. Note U6 does **not** cover `commands/` — it walks `skillDirs()`, a known gap (G-U6) — so U14 is the only structural guard on this file |
| **I-7 (rev3, inverted)** | T1b: the `setup` **command** *does* name `mcp__infra-kit__setup`, and T1 stays scoped to skills (`manifest.test.mjs:588`, `:704`) | Widening T1 to `PLUGINS_DIR`, which `manifest.test.mjs:608-612` warns would *"silently delete the command's fallback clause"*. The existing T1b pins both halves; this extends it to the second command |
| **I-9 (rev3, restated)** | No file under `plugins/infra-kit/commands/` carries an `allowed-tools` key | Already enforced by U14's `deepEqual` on `COMMAND_FRONTMATTER_KEYS` (`:617`); restated against `setup.md` explicitly because it is the property Scenario 4 rests on, and a reader should not have to infer it from a key-set assertion |
| **I-10 (rev3, list corrected)** | U15 generalised from `DOCTOR_SKILL` (`manifest.test.mjs:470`) to **every** skill. `MUTATING_INVOCATIONS` is **five** needles at `:479-485`; `'--fix'` and `'audit --fix'` survive, `'infra-kit init'` survives until 0.7.0, the two `setup-dependency` needles go, and `'infra-kit setup'` is added. Permitted map is **`{}`** — no skill is permitted any mutating fence. **If an entry is ever added, it must match whole fenced lines, not needles**: substring matching would let a permitted longer form re-permit a denied prefix (the hazard `manifest.test.mjs:475-478` documents for `setup-dependency` ⊂ `setup-dependency-status`). Carry the red fixture for that case even while the map is empty | A future skill fencing `audit --fix` or `infra-kit setup`, including under an `env`/`sudo` prefix (U15 matches raw fenced lines as substrings, so prefixes are caught). Revision 2 said three needles and prescribed a `setup → [...]` permitted entry; both were wrong — there is no `setup` skill to permit. Delete the now-dead prefix caveat at `:475-478`, which is about `setup-dependency` ⊂ `setup-dependency-status` |
| **I-12 (rev6, retargeted at the real gate)** | `node scripts/check-workflow-resource-published.mjs` exits 0 with `setup.md` present — i.e. the published `infra-kit@latest` is at or above the floor `setup.md`'s body states **and** that build actually answers `resources/list` with `infra-kit://workflow/setup` | Revision 3 pointed I-12 at `publish-gate.test.mjs`, which exercises a **synthetic command factory** (`:18-26`) and asserts nothing about the shipped `setup.md` — a green unit test over a fixture, not over the artifact. The binding check is the script, which `plugin-ci.yml:44-50` runs on the PR. Mutations that red it: shipping `setup.md` with no floor line (the script's `:59` regex finds none), naming a URI the published build does not serve, or merging the command before Phase 6's publish |
| **I-13 (rev3)** | Every generated instruction writes the binary-qualified form: no `resources/**` or README line matches `/(^\|\s)setup\b/` unqualified by `ik ` or `infra-kit ` | §Naming rule 1 / Scenario 5. Mutation: writing "run `setup`" or "`setup` — …" in `resources/root/body.md`, which is the spelling that collides with `pnpm run setup` in all four consumers |
| I-8 | `resources/root/body.md` renders no `ik init`; the guidance snapshot (`agent-guidance/__tests__/__snapshots__/bodies-snapshot.test.ts.snap`) updated in the same commit. **Evaluate the snapshot only after the repo's `Edit\|Write` format hook has run** — prettier owns the bytes of `.md` resources here, so a snapshot captured mid-edit measures text the formatter is about to rewrite | Editing the resource without refreshing the snapshot, or the reverse. Note the *rendered* line count is the sound assertion; file-level byte cleanliness is not, because the formatter reflows the source |
| **I-11 (rev2)** | `__snapshots__/command-catalog.test.ts.snap:265-276` shows `setup` with the merged input/output keys and no `setup-dependency*` entries | Landing the tool without regenerating the snapshot — it would red, but the plan must name the file so the regeneration is reviewed rather than `-u`'d |

### End-to-end / manual

- **E-1 (automated, rev2 line fix).** `mcp-stdio.e2e.test.ts`: `tools/list` returns exactly two
  setup/diagnostics tools; **`REQUIRES_INTERACTION_TOOLS` at `:258`** becomes `new Set(['setup'])`
  (revision 1 cited `:277`, which is inside the consuming helper); `doctor` carries
  `annotations.readOnlyHint === true` and no `_meta` gate.
- **E-2 (manual, rev3).** Scratch repo, no `.zshrc` block, **`claude plugin` not yet installed** so
  `installPluginForProject` actually spawns. Run `infra-kit setup --skip-tools` first: confirm the managed
  block, seeded config, plugin pointer and `.mcp.json` key all land, that **nothing was installed**, and
  that missing tools are reported with runnable argv. Then run flagless `infra-kit setup` and confirm the
  converge actually installs, and that the two refused recipes print rather than run.
- **E-3 (manual).** Live Claude Code session: `mcp__infra-kit__doctor` returns with **no** prompt;
  `mcp__infra-kit__setup` raises the host prompt **and then** the confirm round-trip, flagless included.
  The only direct evidence for §3's central claim.
- **E-4 (manual, rev3).** `infra-kit init` prints the 0.7.0 deprecation warning naming both
  `infra-kit setup` and `setup --skip-tools`, performs the additive writes, and **installs nothing** —
  verified on a machine with at least one dependency missing, so "installed nothing" is an observation
  rather than a vacuous pass on an already-complete host.
- **E-5 (manual, rev3).** In a consumer repo, confirm the three `setup` spellings are distinguishable in
  practice: `pnpm setup`, `pnpm run setup`, `infra-kit setup` (§Naming, Scenario 5). Specifically check
  that the regenerated `CLAUDE.md` block and the plugin command's description never present a bare
  `setup`.

### Observability

- `setup` emits one combined summary naming which half produced which outcome — now backed by
  `InitReport`, so it is the same data on both surfaces rather than a logger-only side effect.
- The deprecation warning names **0.7.0**.
- `doctor`'s payload keeps `cliVersion` (from the in-flight setup-skill-plan commit 1), which is what the
  plugin skill checks its CLI floor against — skills get no published-version floor of their own.

### 5a. Why revision 1's U-D2 could not be built

`checkTokenStorePerms` is defined at `doctor.ts:567` and called at `doctor.ts:1451` **inside the same
module**. An ESM self-call binds the module-local const, so `vi.spyOn(doctorModule, 'checkTokenStorePerms')`
cannot intercept it — the same mechanism this repo has recorded for named `fs` imports. Both phrasings
fail:

- *"assert the spy was invoked with `false`"* → the spy sees **0 calls** and the test fails on **correct**
  code; someone then "fixes" it into the second form.
- *"assert the spy was never invoked with `true`"* → **vacuously green on the exact mutation it targets** —
  Principle 6 violated by the plan's flagship test, and U-D2 is the *sole* payment for leaving the P1
  gate's population.

The replacement's form (a) needs no mocking at all: `defineMcpTool` returns its argument unchanged
(`types.ts:138-142`), so `doctorMcpTool.handler` is the authored closure and `handler.length` is `0` for
`() => doctor()` and `1` for `(params) => doctor(params)`. Two lines, no seam.

**But (a) alone is not enough, and revision 2 was wrong to make (b) optional.**
`Function.prototype.length` counts parameters *before* the first default and excludes rest parameters — so
`(params = {}) => doctor(params)` and `(...args) => doctor(args[0])` both report `0`. Each is a one-token
edit away from the mutation (a) is meant to catch, and each would pass. Since U-D2 is the **sole** payment
for removing `doctor` from the P1 gate's population, funding it with an assertion that has two trivial
bypasses would leave the trade unpaid in a subtler way than revision 1 did.

So (b) is required, not optional. What (b) must watch is settled in §5b.

### 5b. U-D2(b): four wrong specifications, five failure modes, and what finally bites

This test has been specified wrongly in **four revisions — 1, 3, 5 and 6 — with five distinct failure
modes**, because revision 1's was wrong in two independent ways (§5a). The history is kept because no two
failures shared a cause, and this version is only defensible if the earlier ones are visible: the pattern
is itself the warning, and it is why the stop condition below must be **executed** rather than reasoned
about.

| Revision | Specified | Why it did not bite |
| --- | --- | --- |
| 1 | `vi.spyOn(doctorModule, 'checkTokenStorePerms')` | Same-module self-call (def `doctor.ts:567`, call `:1451`) — an ESM self-call binds the module-local const, so the spy never intercepts |
| 3 | `vi.mock('src/lib/env-tokens')`, assert zero writes | **Wrong module.** `src/lib/env-tokens/index.ts:1` exports `getTokenStorePath, readTokenStore, removeToken, setToken, writeTokenStore` — **no chmod at all**. The `--fix` write is `chmodPath(entry.target, entry.expected)` at `doctor.ts:619`, resolved at `:571` from `fs.chmodSync`. Records zero calls with or without the mutation |
| 5 | `vi.spyOn(fs, 'chmodSync')`, assert **not** called | **Right seam, unusable assertion.** A bare negative with no positive control — green on any machine without a token store or with correct perms, which is most machines and CI |
| 6 | Positive control **first**, then the negative | **Right assertions, fatal order.** `vi.spyOn` calls through, so the positive half chmods the fixture tight; the negative half then hits `doctor.ts:601` (`loose.length === 0`) and passes under the mutation. See "Why not positive-first" below |

**Why revision 5's assertion was still vacuous.** `checkTokenStorePerms` reaches zero chmod calls down
**four** paths, on correct and mutated code alike:

| Path | Line | Reached when |
| --- | --- | --- |
| `storePath()` throws → pass | `:576` | the token-store path cannot be resolved |
| `modeOf(target) === null` → pass | `:580` | **no store exists on disk** |
| `loose.length === 0` → pass | `:601` | **permissions are already correct** |
| `!fix` → fail | `:610` | the flag is false — *this is the one correct code takes* |

The middle two are the ordinary state of most developer machines and of CI. So "assert `chmodSync` was
not called" passes on a green run, a mutated run, and a run that never entered the function at all — it
cannot distinguish them. The trap is sharpened by precedent: the repo's only example of driving a real
`doctor()` against a token store, `doctor-corrupt-token-store.test.ts:12-21`, points `getTokenStorePath`
at a **nonexistent path** — which is path 2. Copying that fixture reproduces the vacuum exactly.

**The fourth version: one fixture, two assertions, opposite directions.**

*Fixture.* `mkdtemp` a root, then build the exact shape `checkTokenStorePerms` walks — it derives three
ancestors from the target by `path.dirname` (`doctor.ts:585-587`), so the layout must be three levels
deep:

```
<tmp>/.infra-kit/projects/api/tokens.json
  ├─ userConfigDir = <tmp>/.infra-kit        expected 0o700  (TOKEN_DIR_MODE,  doctor.ts:275)
  ├─ projectsDir   = <tmp>/.infra-kit/projects
  ├─ projectDir    = <tmp>/.infra-kit/projects/api
  └─ target        = …/tokens.json           expected 0o600  (TOKEN_FILE_MODE, doctor.ts:274)
```

`chmodSync` each directory to `0o755` and the file to `0o644` **explicitly after creation** — never rely
on the creating call's mode, which umask perturbs. That makes `loose.length === 4`, so paths 2 and 3 are
both bypassed and the `:619` loop is reachable. Point `getTokenStorePath` at the target via
`vi.mock('src/lib/env-tokens', …)`, the module boundary
`doctor-corrupt-token-store.test.ts:12-21` already proves works. Tear the temp root down in `afterEach`.

**The mock factory must supply `readTokenStore` as well as `getTokenStorePath`.** `doctor.ts:38` imports
both from that module, and `readTokenStore` is the default for `deps.readStore` at `doctor.ts:341` and
`:501` — two checks that run in the same `doctor()` pass. A factory returning only `getTokenStorePath`
leaves the other binding undefined and those checks throw. It **fails loudly rather than silently**, so it
is not a correctness risk to the assertions — it is named here only so an implementer following this
section literally does not burn a cycle discovering it.

*Assertions — **the negative runs FIRST**, and the order is load-bearing.*

1. **The invariant, against a fresh loose fixture and an empty spy:**
   `await doctorMcpTool.handler({ fix: true, confirmedCommand: true } as never)` → `spy` called **zero**
   times with any fixture path.
2. **Positive control, on the same still-loose fixture:** `await doctor({ fix: true })` → `spy` now
   called with each of the four fixture paths. **This is the half that proves the fixture reaches
   `doctor.ts:619` at all**; without it, assertion 1 asserts nothing.

Counts are cumulative across the two calls and no clearing happens between them, which is exactly why
this order works: correct code gives 0 then 4.

Assert against the *fixture paths* rather than a bare call count, so an unrelated `chmodSync` elsewhere
in `doctor()` cannot make either half lie.

**Why not positive-first — the fifth vacuum, and it closes its own trap.** Revision 6 specified the
positive control first. That is unsound, for two environmental reasons both verified in this repo rather
than assumed:

- **`vi.spyOn` calls through by default.** `config-bootstrap.test.ts:115-122` installs a bare
  `vi.spyOn(fsp, 'writeFile')`, asserts one call, **and then reads the file back and asserts the new
  bytes are on disk**. The spy observes; it does not suppress.
- **Nothing auto-clears mock state.** Neither `apps/infra-kit/cli/vitest.config.ts` nor the root config
  sets `clearMocks`, `restoreMocks` or `mockReset`; the repo clears by hand
  (`config-bootstrap.test.ts:99`).

Compose those: positive-first means assertion 1's `doctor({ fix: true })` **physically chmods the fixture
tight** — to exactly `TOKEN_DIR_MODE` / `TOKEN_FILE_MODE` (`doctor.ts:274-275`). Assertion 2 then runs the
handler against a fixture that is no longer loose, so under the mutation it computes `loose.length === 0`
and returns at **`doctor.ts:601`** — early-return path 3 in the table above. Zero calls, green, mutation
undetected.

**And the trap closes itself, which is why this paragraph exists rather than just the fix.** On *correct*
code that same ordering reds assertion 2 anyway, because the spy still holds assertion 1's four calls. The
repair a maintainer reaches for is `spy.mockClear()` between the assertions — **and that single line is
precisely what converts "red on correct code" into "green on the mutation".** A future editor who
reorders these two assertions for readability restores the vacuum, and the failure will look like a
flake, not a hole. **Do not reorder, and do not insert `mockClear()`.**

*Sanctioned variants, if negative-first is ever impossible:* suppress call-through
(`spy.mockImplementation(() => {})`) **and** clear between assertions; or split into two `it` blocks with
a `beforeEach` that rebuilds the fixture **and** an explicit clear. Both work. Negative-first is chosen
because it requires **no cleanup step that a later edit can drop** — the other two are correct only while
someone remembers to maintain a second moving part.

**Mutation that reds it:** `handler: (params) => doctor(params)` — assertion 1 then sees four calls where
it requires zero, and reds *first*, before the fixture has been altered. The arity bypasses
(`(params = {}) => …`, `(...args) => …`) red it identically, because (b) never inspects the signature.

**MANDATORY STUB — `doctor({ fix: true })` deletes the developer's portless routes.** This is a safety
requirement on the owner's own machine, not a speed optimisation, and it is the one item in this section
that is not about the assertions.

`doctor.ts:1461-1470` runs `pruneStalePortlessRoutes()` **under `fix`**, and `decidePrune`
(`prune-routes.ts:67-81`) returns **every** non-live route as prunable whenever no `infra-kit dev` runner
is alive — the ordinary state of a machine running a unit suite. `doctor.ts:1379-1383` then calls
`removeAlias(alias)` on each. **Assertion 2 invokes this deliberately, and Phase 4's mutation drill
invokes it again.** Neither assertion observes it — both match on fixture paths, correctly for the chmod
seam and blind to this — so the suite goes green and the damage surfaces later as a 502'ing dev proxy.
This repo has a recorded 502 with a *different* cause, so the likely outcome is a misdiagnosis rather
than a trace back to a test run.

*The stub, at the seam that actually intercepts:*

```ts
vi.mock('src/dev/proxy/portless-driver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/dev/proxy/portless-driver')>()),
  listRoutes: () => [],
}))
```

With no routes, `dead` is empty, `prunable` is empty, and `removeAlias` is never reached.
*(`isDevSessionRunning: () => true` from `src/commands/doctor/prune-routes` is an equally valid
alternative — a live dev session makes `decidePrune` withhold everything — but `listRoutes` is the more
robust choice because it defeats the writer at its source rather than relying on the decision logic
staying as it is.)*

**Two traps in that stub, both of which have bitten this repo:**

1. **`pruneStalePortlessRoutes` is defined in `doctor.ts:1348`, not in `prune-routes.ts`.** Mocking
   `src/commands/doctor/prune-routes` does **not** intercept it — that would be revision 1's
   un-interceptable same-module self-call all over again. The interceptable seam is the **cross-module
   named import** at `doctor.ts:18-28`, which is where `listRoutes` and `createPortlessDriver` come from.
2. **The mock must be partial, via `importOriginal`.** `doctor.ts` uses ten named exports from that
   module; a wholesale replacement breaks the import graph **before a single check runs**, and it fails
   at *import* time in a way that looks nothing like a fixture problem.
   `doctor-corrupt-token-store.test.ts:23-34` already hit exactly this wall with
   `src/integrations/doppler` and documents it in a comment — read that comment before writing this mock,
   not after.

**The general rule this makes explicit:** the stub list for a `fix: true` path must cover its
**writers**, not only its readers. Everything in the cost paragraph below is a reader.
`pruneStalePortlessRoutes` is the only writer on this path besides `chmodSync` itself.

**Cost, stated:** `doctor()` runs ~95 checks including `gh`/`doppler`/`aws` spawns, so this test is slow
and touches the network unless those are stubbed. Those are all **readers** — stub them for speed if the
suite complains; the chmod seam is independent of them. **If the positive control cannot be made to pass — i.e. the fixture cannot
reach `doctor.ts:619` — then §4 has no funding and must be reopened rather than shipping another
vacuum.** That is the stop condition.

**The stop condition must be exercised literally, not reasoned about.** This test has now been specified
wrongly in **four revisions with five distinct failure modes** — revision 1's un-interceptable self-call
(wrong in two ways), the wrong module, no positive control, and a self-destroying fixture order. A test
with that history does
not get the benefit of the doubt on the sixth attempt. Before U-D2(b) is believed: **write the mutation
into `doctor.ts`, run the test, require a red, revert.** This is an acceptance criterion of Phase 4, not
advice.

**Residual fragility — and the hardening is ADOPTED, not offered.** `vi.spyOn(fs, 'chmodSync')`
intercepts only because `doctor.ts:1` is `import fs from 'node:fs'`, a **default** import. A *named*
import defeats the spy silently: zero calls observed **and** the real write still happens.

Revisions 6–7 listed two possible hardenings and adopted neither. That is not defensible here. This
repo's post-edit formatter is recorded to rewrite imports, this is the test that has been wrong in four
revisions, and the failure mode is a green suite over a live hole. So **U-D5 is added** — a two-line
source assertion that `doctor.ts` still contains the exact string `import fs from 'node:fs'`. It costs
nothing, it reds loudly and immediately, and its failure message can name the consequence.

**Measured, not argued (Phase 4).** `import * as fs from 'node:fs'` was executed against the finished
test — the namespace form deliberately, because it is the only non-default variant that still compiles
(`doctor.ts` uses `fs.` at ~20 call sites, so a bare `import { chmodSync }` fails `tsc` and never
survives to deceive anyone). It is therefore the realistic formatter-rewrite shape. The spy recorded
**zero** `chmodSync` calls while the real chmod still happened — both halves of the claim above
confirmed.

But the suite redded at the **positive control**, not at the invariant: assertion 1 (`:201`) passed
**vacuously** and the visible failure was assertion 2 (`:210`), *"the CLI `--fix` path never reached
…"*. So the failure is **loud but misattributed**, not silent — and that reads to a maintainer as a
broken fixture, whose tempting repair is to weaken or delete the positive half, restoring revision 5's
vacuum with the invariant permanently green.

**U-D5 is therefore not a second detector — the positive control already detects.** It is the
**attribution**: the only assertion whose message names the cause, and the only one that survives a
later thinning of the positive control. That is a narrower claim than this section made before Phase 4
measured it, and the narrower one is the true one.

The alternative — switching (b) to the real-FS mode check, which has no import-style dependency at all —
stays documented in §Known limitations as the escape if U-D5 ever becomes a nuisance. It is not chosen
now because reading a mode back is a weaker assertion than observing the call: it cannot distinguish "no
chmod happened" from "a chmod happened and something restored the mode".

## Phases and acceptance criteria

**Phase 0 — rebase and re-verify.** Re-read `doctor.ts` / `report.ts` from the working tree; confirm the
setup-skill-plan commit-1 artefacts (`fixable`, `cliVersion`, `resolveGitRoot`/`resolveInfraKitRoot`,
`mcp-registration.ts`) are present. *Accept:* no edit is written against a stale line number. (The §1
"never published" premise needs no check here — it is discharged by measurement against the published
0.4.0 bundle.)

**Phase 1 — Commit A: `lib/dependency-*` with no surface change.**

*Accept, stated so it is achievable and checkable:*

- `pnpm --filter infra-kit exec vitest run src/lib/dependency-*` — green.
- `pnpm --filter infra-kit exec tsc --noEmit` — exit 0.
- `pnpm --filter infra-kit exec eslint src/lib/dependency-* --no-cache` — exit 0 (`--no-cache`: a cached
  run can exit 0 while a cold run finds real errors).
- The **staged** diff touches no `command-catalog.ts`, no `program.ts`, no `resources/`.

**`pnpm run qa` is NOT the Phase 1 gate, and this is deliberate.** `vendor check` runs **first** in root
qa and is **already red on HEAD** (§Preconditions). An agent told "qa green" will either stall or start
editing `vendor/` — the one directory that must not be touched, because `vendor check` is a checksum
guard and editing the mirror reddens the whole gate. The known-red check is named here and excluded by
name rather than by hope. Run full `pnpm run qa` at Phase 6, by which point whoever owns the `vendor`
red has resolved it or explicitly waived it; a `vendor check` failure at any phase is **pre-existing and
not this work's regression** unless the diff touches `vendor/`, which no phase does.

The four untracked files named in §6 remain unstaged in the working tree — expected, not a failure.

**Phase 2 — `src/commands/setup/`.** `initCore` returns `InitReport`; the dependency step composes; **all
three flags — `--tools`, `--update`, and `--skip-tools`** (revision 4 omitted the last from this list,
leaving the flag the whole safety argument hangs on unscheduled). *Accept:* **U-S1, U-S2, U-S3, U-S4,
U-S6 and U-S7** green — enumerated, not a range, because U-S7 sorts above U-S6 and a range silently
excludes it; and the CLI's human output for flagless `setup` is today's `init` output plus the converge
and report sections.

**U-S5 is NOT accepted here** — it exercises `infra-kit init`, which is not wired until Phase 3. It moves
to Phase 3 with I-3, the other half of the same invariant.

**Phase 3 — catalog + Commander surface.** Catalog edits; three registrations removed; `init`
re-registered hidden with the 0.7.0 warning; `AUTO_LOAD_EXCLUDED` renamed;
`setup-dependency-gate-mutation.test.ts` retargeted. *Accept:* U-C1, U-C2, U-C3, U-C5, U-C6, **U-S5**,
I-1, I-3, I-4, I-11 green — U-S5 and I-3 are the two halves of the stale-guidance invariant and land
together with the command that carries it; **and the P1 gate test at `command-catalog.test.ts:243-256`
appears unmodified in the diff** (the demoted U-C4).

**Phase 4 — `doctor` exposure and row unification.** Catalog flip; `detail` on three rows; new `brew` row
with its single `SECTION_MEMBERS` edit (`report.ts:64`; `DOCTOR_CHECK_NAMES` is derived from it and needs
no edit); portless untouched; `MCP_TOOL_PRESENTATION`
entry; seam guard strengthened; **`mcp-stdio.e2e.test.ts:253` inverted, not deleted** (§1 edit sites).

*Accept:* U-D1, U-D2, U-D3, U-D4, **U-D5**, I-2, E-1 green; `report-inventory.test.ts` green **with** a reviewed
one-row `SECTION_MEMBERS` diff.

**Plus one criterion that is a procedure, not a test result — U-D2(b)'s mutation must be executed.**
Write `handler: (params) => doctor(params)` into `doctor.ts`, run U-D2(b), **observe a red**, revert.
Record the red in the PR. §5b explains why this is not ceremony: the test has been specified wrongly in
**four revisions with five distinct failure modes**, three of which produced a *green* suite over a live
hole. Phase 4 does not pass on U-D2(b) being green; it passes on U-D2(b) having been **demonstrated to go
red**.

**Phase 5 — generated text and grants.** Edit `resources/root/body.md` (§0 rule 1 — the exact strings are
quoted there), `readme.md:72` and `:100-111`, `plugins/infra-kit/README.md`, `.claude/settings.json` (the
§3 `ask` list), and the two `src/mcp/tools/index.ts` comments. Then regenerate.

**The regeneration must build first and run `dist/cli.js` by absolute path:**

```
pnpm --filter infra-kit run build
node /Users/arthur/projects/infra-kit/apps/infra-kit/cli/dist/cli.js audit --fix --root
```

**Why, and this is a recorded trap this repo has hit twice.** `body.md` is bundled `?raw` at
`src/lib/agent-guidance/resources.ts:13`, so its text ships **inside the built artifact**. A bare
`infra-kit` on PATH is the *published global* binary and will faithfully re-emit the **old** wording,
producing a green-looking regeneration that undoes the edit. `pnpm exec infra-kit` is equally wrong — it
resolves a different binary and sets `npm_*` in the child env. Neither spelling may appear in this phase.

*Accept:* I-8 and **I-13** green; the readme's tool count recomputed from the catalog; zero non-`docs/`
grep hits for `infra-kit init` / `setup-dependency` **as an instruction**; and `/CLAUDE.md`'s regenerated
block **renders** the §0 strings — asserted on the rendered line count and content, **not** on source
bytes, because the repo's `Edit|Write` format hook rewrites `.md` after the write (I-8's note). The four
consumer `CLAUDE.md` blocks (§1 table) are **not** edited here — they are regenerated in their own repos
after the publish (§Landing step 3).

**Phase 6 — Commit B lands; publish `0.5.0`.** Commit B **must also add the
`infra-kit://workflow/setup` resource**, because the publish gate refuses a command whose URI is not
served (I-12) and the resource ships in the CLI, not the plugin.

**The version is `0.5.0`, and it is not arbitrary.** `commands/release-create.md:8` already floors at
`0.5.0` while published is `0.4.0`, so `check-workflow-resource-published.mjs` is **red today** — its own
header records this at `:71` (*"the gate is red today for `release-create` (floor 0.5.0, published
0.4.0)"*). Publishing `0.5.0` therefore discharges a **pre-existing** red as well as satisfying `setup.md`'s
floor. `setup.md` must state the same `0.5.0` floor, and Phase 7's PR **cannot merge until this publish
lands** — `plugin-ci.yml:44-50` runs the script on the PR and its comment says that redness between
merging the command and publishing the CLI *"is the feature"*.

*Accept:* the published `0.5.0` contains `setup`, the preserved `init`, the two-tool MCP surface, **and**
answers `resources/list` with `infra-kit://workflow/setup`; and `node scripts/check-workflow-resource-published.mjs`
exits 0 afterwards (I-12), which it does not today.

**Consequence for `init`'s removal: it moves from `0.6.0` to `0.7.0`.** If `setup` ships in 0.5.0 and
`init` died in 0.6.0, the deprecation window would be a **single minor**. §1's own evidence refutes that as sufficient:
starter-workspace is sitting at `0.3.14` against a published `0.4.0` — a consumer *two* minors behind, on
a global install nobody in that repo upgraded deliberately. A one-minor window means such a consumer can
skip every version in which `init` both works and points at `setup`. Two minors (0.5.0 → 0.7.0) is the
window this plan sets. **This changes the `0.6.0` figure used in earlier revisions**; every mention is
updated, and the deprecation string in §1 names `0.7.0`.

**But a version floor alone is measured on the wrong clock, so it is a floor and not the gate.** A version
window counts *CLI releases*; what actually goes stale is the *committed block*, which advances only when
someone runs the regenerating command **in that repo**. starter-workspace reads `0.3.14` because nobody
has run it there since `0.3.14` — and nothing in `0.5.0` or `0.6.0` changes that by itself. Two minors
against a two-minor observed drift is also zero margin on a single data point. The removal condition is
therefore **both**: at or after `0.7.0`, **and** not until every consumer block's `infra-kit:version`
marker reads ≥ `0.5.0` (§Follow-ups).

**Phase 7 — the plugin command (after the publish).** `plugins/infra-kit/commands/setup.md` — a
**command, not a skill** — modelled on `release-create.md:6-9`: read the served resource; on failure name
`mcp__infra-kit__setup` and let its confirm gate drive; if the server is not connected, say so and stop.
Frontmatter exactly `argument-hint`, `description` (§Naming rule 2), `name`; body exactly three non-empty
lines. Plus `EXPECTED_COMMANDS`, the U15 generalisation (I-10), the README row, and plugin + marketplace
version bumps.

*Accept:* I-5, I-6, I-7, I-9, I-10, **I-12** green; E-3 performed; the shipped `setup.md` carries **no
`allowed-tools` key and no fenced `infra-kit setup`** — the installing form is named only as the MCP tool,
whose gate is on it; **and `plugins/infra-kit/skills/setup/` does not exist.**

**Why that last criterion is not pedantry.** A command and a skill of the same name both surface to the
user as `/infra-kit:setup`. The plan chose the command, so the collision cannot arise — but only as long
as nobody adds the skill later "for the docs". `EXPECTED_SKILLS` (`manifest.test.mjs:19-27`) makes that a
red test rather than a silent shadowing, and I-5 asserts the list is unchanged; this criterion states the
reason so the next editor does not read the omission as an oversight.

**What the served resource must contain**, since this is new work Phase 6 owes: the ordered procedure of
§2 (init writes, then converge), what `--tools` / `--update` / `--skip-tools` each narrow, that refused
recipes are printed rather than run and why, and that `init` is deprecated with `--skip-tools` as its
successor. It is the long form; the command file is three lines because the resource carries the detail —
the "defer to the resource" design `manifest.test.mjs:637` exists to protect.

**Why `doctor` stays a skill and `setup` becomes a command.** `doctor` reads host state, needs no gate,
and its value is the session-local checks a skill can make around the CLI report. `setup` mutates and must
route through a confirm gate, which obliges naming an MCP tool — and only `commands/` may do that
(T1, `manifest.test.mjs:588`, scoped to `SKILLS_DIR` at `:12`). The asymmetry follows from the gate, not
from taste.

---

## Landing and publish sequence

Reused from `docs/infra-kit-setup-skill-plan.md` §Landing, because the hazard is identical: **the plugin
ships instantly through a marketplace bump; the CLI ships only through an npm publish.** A single combined
commit produces a window where `/infra-kit:setup` is live and promises behaviour the installed CLI lacks.

1. **Commit A** (`lib/dependency-*`) → merge.
2. **Commit B** (CLI surface + doctor + generated text) → merge → **publish**.
3. **Pre-release sweep, before the publish — all four repos, three files each:** `.mcp.json`,
   `CLAUDE.md`, **and `.claude/settings.json`** (the last is new in revision 4; see §Known limitations —
   consumers author their own infra-kit Bash rules and starter-workspace already carries four). Each has
   `infra-kit.json` at its root, so `resolveInfraKitRoot` passes and the first `setup` after the upgrade
   produces a **tracked diff in a repo whose owner did not run this plan** — the recorded "a writer change
   is not self-contained" shape. The sweep **reports**; it does not edit those repos.
4. **Commit C** (the plugin **command** + the U15 generalisation) → plugin version bump → marketplace bump.

Consumer impact is bounded to (a) the deprecation warning on `infra-kit init`, and (b) a guidance-block
diff the next time anyone regenerates in those repos.

---

## ADR

**Decision.** Collapse to two commands per Option A, under owner decision B.

1. **Flagless `infra-kit setup` installs everything** — the init writes plus a converge over brew, aws,
   gh, doppler and portless. `--tools` / `--update` narrow it; **`--skip-tools`** is the additive-only
   form and the successor to `init`'s contract.
2. **The MCP `setup` tool is gated unconditionally on every call** — `requiresHumanConfirm` **and**
   `_meta['anthropic/requiresUserInteraction']` — flagless included.
3. **The dependency read path unifies into `doctor`'s existing rows**, which flip to
   `mcpExposed: true, mutating: false`, funded by U-D2's two required forms.
4. **`init` is preserved, not aliased**: a hidden, non-catalog command keeping its historical contract
   verbatim (additive writes, nothing installed) plus a stderr pointer, removed in 0.7.0.
5. **`setup` takes `menuGroup: null`** — no palette row.
6. **The plugin's `setup` is a command, not a skill** (`plugins/infra-kit/commands/setup.md`), carrying
   no `allowed-tools` and naming `mcp__infra-kit__setup` so its confirm gate drives. The `doctor` skill
   is unchanged.
7. The three `setup-dependency*` names are removed before they are ever published.

**Drivers.** (1) Preserve a prompt-free, ungated read path so the prompt on `setup` stays meaningful.
(2) `init` is published surface reached by unpinned global consumers through self-referential generated
guidance. (3) The P1 catalog gate that `doctor` leaves must be re-funded by a test that bites (§5b), and
the installing form must reach no prompt-free route — the command shape deletes the standing-grant
question rather than answering it.

**Alternatives considered.** *Option B* (one gated tool, `mode`/`dryRun`): rejected — it gates the read
path at the write path's risk; a gate selected by an argument is not a gate. *Option C* (keep
`setup-dependency-status` as a third MCP tool): rejected against the stated goal; retained as fallback if
the Q6 reversal is refused. *Option D* (hard-remove `init`): rejected — no guard exists for a generated
instruction only the removed command can rewrite. *Flagless `setup` additive-only* (revision 2): **overridden by the
owner in revision 3** in favour of B. Revision 2's objection was not wrong — a flagless grant would be an
ungated installer — but it is answered by removing the grant rather than by narrowing the command, which
is the trade the owner chose. *Aliasing `init` to flagless `setup`*: rejected — a deprecation alias that
gains a blast radius is a trap, and §1's evidence shows stale consumer blocks are real.
*Sibling `dependencies[]` array on doctor's payload* (revision 1): rejected in revision 2
— a second copy of a list `doctor` owns, with semantics documented to disagree. *Plugin `setup` as a **skill***: rejected in revision 3, reversing
revisions 1–2. `docs/infra-kit-setup-skill-plan.md` §Viable options analysed the command path as its
Option D and rejected it *for that plan*, when the skill could carry a `Bash(infra-kit init)` grant
justified by additivity. B falsifies that justification, and a skill may never name an MCP tool (T1,
`manifest.test.mjs:588`), so a skill under B could only gesture at the gated tool in untestable prose —
and I-7 would red the moment anyone wrote the name down. The command path's costs are real but
**precedented, not speculative**: `release-create.md` pays all of them today — the published-CLI version
floor and served `infra-kit://workflow/<name>` URI (`publish-gate.test.mjs:18-26`, `:79-87`) and U14's
exactly-three-non-empty-lines body (`manifest.test.mjs:637`, an equality, not a cap). The naming
mitigation `docs/infra-kit-setup-skill-plan.md` §Naming specifies carries over to the command's
`description` unchanged (§Naming rule 2).

**Why chosen.** It is the only shape found that gives the owner two names on all three surfaces *and*
keeps the read path ungated: the read path moves to a **different tool name**, which is what an MCP rule
matches on. Under B the write/write granularity is no longer carried by the *default* — it is carried by
`--skip-tools`, the successor to `init`'s contract; and by the plugin's `setup` being a **command**, which
carries no `allowed-tools` at all, so the standing-grant question is deleted rather than re-answered.

**Consequences.** `doctor` leaves the P1 gate's population; U-D2 replaces it and is stronger than the
`audit` precedent it borrows from. "Two commands" is true of every generated and rendered surface but not
of `--help` internals, where the hidden `init` persists until 0.7.0. **Flagless `infra-kit setup`
installs software**, and three things follow: `setup` takes `menuGroup: null` so today's arrow-to-`init`
affordance is lost (§5, and the cheapest decision here to reverse); `init` is preserved rather than
aliased, so no existing instruction changes meaning (§1); and the plugin's `setup` is a command that
routes installs through the gated MCP tool, carrying no Bash grant at all (Scenario 4). `report.ts` gains one row, a deliberate
and reviewed diff. The plugin ships two setup/diagnostics skills among eight; the other six
(`fe-architect`, `fe-patterns`, `e2e-architect`, `comment-verifier`, `full-cycle`, `update-toolchain`) are
a different domain — "only two" is a claim about the bootstrap/diagnostics surface, not about
`EXPECTED_SKILLS` cardinality.

**Follow-ups (not now).** A `formProvider` for `setup`'s arguments. **Removing `init`: at or after
`0.7.0`, and not until every consumer block's `infra-kit:version` marker reads ≥ `0.5.0`** — the version
floor bounds CLI releases, the marker bounds what the consumers have actually regenerated, and only the
second tracks the thing that goes stale. *This gate is sound only because the consumer set is closed:*
the four repos §1 tables are the whole population and §Landing step 3 sweeps all of them. **A fifth
consumer outside those four makes the sweep incomplete and the gate unsound** — discovering one is a
reason to re-open the removal date, not to waive the check.
Giving `audit` U-D2's behavioural treatment — the gap this plan closes for `doctor` is open for `audit`
today. Landing the sibling plan's guard part (2) (bare `Bash` raw-string invariant), which this plan does
not need but which is cheap alongside (1) and (3).

---

## Resolved: should flagless `infra-kit setup` install tools?

**Yes — owner decision B**, recorded here because the rest of the plan is shaped by it.

Revision 2 argued no: a plugin fence and a wildcard-free `Bash(...)` rule can only grant the flagless
form, and such a rule runs with no prompt, so the flagless form had to be safe ungated. The owner chose
the other side of that trade, and revision 3 pays it in the three places revision 2 named in advance —
the palette row (§5), `init`'s contract (§1), and the plugin grant (Scenario 4). The objection was not
overruled so much as **dissolved**: the flagless form is no longer safe ungated, and the command shape
means there is no standing grant that could name it.

**One decision remains genuinely open and is cheap either way:** §5's `menuGroup: null`. Keeping the row
means a one-keystroke installer in the no-arg picker; dropping it costs today's arrow-to-`init`
affordance. The plan takes `null`; flipping it changes nothing else.

---

## Preconditions

- The setup-skill-plan commit-1 artefacts land or are confirmed present; Phase 4 edits doctor's
  `outputSchema`, which that work also edits.
- The parallel session's `doctor.ts` / `report.ts` changes are settled before Phase 4.
- `vendor check` runs **first** in root qa and is **already red on HEAD**. Nothing here edits `vendor/`;
  the red is pre-existing and must not be read as caused by this work.
- `pnpm run qa` (not just vitest) is the gate: tsc catches what vitest misses, and sonarjs
  cognitive-complexity ≤15 applies to the new `setup` composition and to `initCore`'s report assembly —
  the two most likely offenders.

## Known limitations

- Nothing automated verifies the end-to-end machine effect of `setup` (E-2) or live host prompt behaviour
  (E-3). Both manual; E-3 is the only direct evidence for §3's central claim.
- `_meta['anthropic/requiresUserInteraction']` is a Claude Code extension, silently ignored below
  v2.1.199 and by every non-Claude-Code host (`types.ts:95-101`). There, `requiresHumanConfirm` and
  `risk-predicate` are the whole protection.
- The `.claude/settings.json` Bash rules in §3 are prefix matches and are order-sensitive; flag reordering
  defeats them. They are defence in depth, not the control.
- **A stale consumer block cannot be repaired from here.** All four blocks are now *read* (§1 table), but
  regenerating starter-workspace's four drifted lines requires `audit --fix` run in that repo by its
  owner, after the publish. Until then it keeps instructing agents to run `ik init` — which still works
  and still installs nothing, which is exactly what Ruling 1 buys.
- **U-D2(a) asserts arity, not behaviour, and arity is bypassable** — `(params = {}) => …` and
  `(...args) => …` both report length `0`. This is why (b) is required rather than optional; (a) survives
  as the cheap, no-mock tripwire for the common mutation, not as the guarantee.
- **U-D2(b)'s soundness depends on an import style in a file this plan does not otherwise constrain.**
  `vi.spyOn(fs, 'chmodSync')` intercepts only because `doctor.ts:1` is `import fs from 'node:fs'`. Rewrite
  that to `import { chmodSync } from 'node:fs'` and the recorded failure mode returns: the spy sees zero
  calls **and** the real chmod still runs — a green test beside a live write. Nothing currently guards the
  import style, and §4's entire funding rests on it. Two cheap hardenings are available if review wants
  them: a source assertion that `doctor.ts` contains `import fs from 'node:fs'`, or switching (b) to the
  real-FS mode check from §5b, which has no import-style dependency at all.
- **Consumers author their own infra-kit Bash rules, and this plan cannot reach them.** §3's `ask` list
  binds only *this* repo's `.claude/settings.json`. A consumer can write `Bash(infra-kit setup)` — or an
  `allow` rule for any spelling — into their own settings, and nothing here constrains it. This is not
  hypothetical: **starter-workspace's `.claude/settings.json` already carries four infra-kit Bash rules**
  (`Bash(pnpm exec infra-kit release-deliver:*)` and three siblings). *Correcting one detail as relayed:*
  they sit in **`deny`**, not `allow`/`ask`. So **the over-permission direction is unevidenced**: every
  observed consumer rule *restricts* infra-kit, and nothing seen here shows a consumer granting it. What
  is evidenced, and sufficient: consumers author their own infra-kit Bash rules at all, in spellings
  (`pnpm exec`, `ik`) that §3's list does not use and Scenario 4 names as unmatched — so a future `allow`
  is reachable and invisible to this repo. **Mitigation is inspection, not enforcement**: Phase 5's consumer sweep
  is widened from `CLAUDE.md` alone to also read each consumer's `.claude/settings.json` for a rule naming
  a removed name (`setup-dependency*`) or a newly-dangerous form (any `setup` spelling). Reporting them to
  each repo's owner is the whole of the remedy — this plan has no write access to those files and should
  not acquire one.
- **G-U6 is inapplicable to `setup.md`, not merely tolerable.** U6 asserts equality between a skill's
  `allowed-tools` rules and its fenced command corpus. A command **cannot have `allowed-tools`**
  (`COMMAND_FRONTMATTER_KEYS`, `manifest.test.mjs:617`), so U6's subject matter does not exist here —
  there is no grant to keep in sync. The file is guarded by U13/U14/T1b and the publish gate, which is
  the whole of what applies.

## Cut / deferred

- A `formProvider` for `setup`.
- Any change to `self-update`, `version`, `audit`, or any other catalog command.
- A published-version floor for skills (the general fix for the skill-ships-first hazard).
- Splitting `doctor`'s ~95 rows into scoped sections addressable by an MCP argument — attractive, but it
  requires a non-empty `inputSchema` on `doctor`, which U-D1 forbids for good reason. Revisit only with a
  design that keeps `fix` unreachable by construction.
- The sibling plan's guard part (2) (bare `Bash` raw-string invariant) — not needed by this plan.
