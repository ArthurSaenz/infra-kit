# Architect review — two-command setup surface plan

**Target:** `docs/two-command-setup-surface-plan.md` (604 lines, `Status: pending approval`)
**Mode:** deliberate (RALPLAN-DR). Read-only; no source edited.
**Verified against:** working tree at HEAD `969bbe0`, branch `main`, dirty (the `setup-dependency` trio and
`lib/dependency-*` are untracked; `docs/infra-kit-setup-skill-plan.md` commit 1 appears implemented and
uncommitted). All file:line citations below are read from the **working tree**.

**Verdict: REVISE.** The chosen shape (Option A) is right in its central move — a read path that keeps its
own tool name is the only answer to name-only permission matching, and the plan argues that better than
anything else in the document. But the compensating control it trades the P1 gate for cannot be built as
specified, the `dependencies[]` sibling array collides with four `checks[]` rows `doctor` already owns, and
the plan's own last phase ships a plugin skill whose Bash fence routes around the entire gate it spends §3
constructing. Those are fixable inside Option A. The shape is not wrong; the payment for it is unpaid.

---

## 0. What I verified, and what I could not

**Verified correct at source** (spot-checked every code citation the plan makes; these all hold):
`doctor.ts:1520-1544` (`inputSchema: {}`, `handler: () => { return doctor() }`), `doctor.ts:1396`
(`options: { fix?: boolean } = {}`), `:1451` (`checkTokenStorePerms(options.fix ?? false)`), `:567`;
`init.ts:53` (`init` is `async (): Promise<void>`), `:54`, `:75`, `:91`, `:97`, `:108`, `:112`, `:115`,
`:120-127`; `command-catalog.ts:125` (`MENU_GROUPS` `'setup'` key), `:489` (`init`), `:491-497` (`doctor`
= `mcpExposed: false, mutating: true`), `:500-508` (the Q6 comment), `:511-518`
(`setup-dependency-status`), `:519-525` (`audit` = `mcpExposed: true, mutating: false`), `:576-578`
(allowlist asserts low risk), `:580-581` (`menuGroup: null` rationale), `:582-601`, `:635`, `:646`;
`command-catalog.test.ts:243-256` (P1 fail-closed gate), `:259-274` (the `audit` precedent, and its
comment does say the flip "is the change the ungated-mutating gate above cannot see for itself"),
`:378` (`groupPaths('setup')`); `program.ts:384` (`AUTO_LOAD_EXCLUDED`), `:663-685`, `:711-717`;
`report.ts:64` / `:113`; `setup-dependency.ts:150-161`, `:186-197`, `:199`;
`setup-dependency-status.ts:63-84`; `install-plugin.ts:155-176`; `types.ts:85-101`;
`resources/root/body.md:4` and `:15`; `/CLAUDE.md:23` and `:34`; `readme.md:72` and `:111`;
`.claude/settings.json:12-14`; `progress.txt:375-386`; `palette.ts` (the silent-skip comment and
`buildPaletteItems`); `src/mcp/tools/index.ts` registers `getExposedMcpTools()` only;
`tool-handler.ts:466` injects `confirmedCommand: true`. The CLI name `setup` is free — no
`command('setup')` in `program.ts`, no `cliName: 'setup'` in the catalog.

Citation hygiene is unusually good. The findings below are about what the plan **omits** and what it
**cannot build**, not about sloppy references.

**Could not verify:** hulyo's and travelist's committed `CLAUDE.md` block contents. Not reachable from
this repo. The plan flags this itself and Phase 5 already schedules the check — that limitation stands as
written and I am adding nothing to it.

**Partially dischargeable now (the plan defers this to "check `npm view` before Phase 3"):**
`git log --all --oneline -- '*setup-dependency*'` returns **empty** — no ref, local or remote, has ever
carried those paths. `git tag | wc -l` = 0. `pnpm view infra-kit version` = **0.4.0**. So the §1
asymmetry does not rest on "untracked in this working tree" alone; it rests on "absent from every ref
this repo has." The residual risk is narrower than the plan states — a publish from an *uncommitted*
tree — and `npm view` is the wrong instrument for it (it lists versions, not command names). The
decisive check is grepping the published 0.4.0 tarball for `setup-dependency`. Say that instead.

---

## 1. Steelman antithesis — the strongest case that Option A's shape is wrong

Argued as if I believed it. Two prongs; the second is the one I would not concede.

### Prong 1 — the plan applies its own Principle 2 to the read/write axis and silently declines to apply it to the write/write axis

Principle 2 is stated flatly: *"A permission identity is a tool name… Collapsing names must not collapse
identities."* It is the load-bearing reason Option B is rejected, and the rejection is correct.

Now look at what §2 actually merges. The init half is:

- home- and repo-scoped (`~/.zshrc`, `~/.infra-kit/`, `.claude/settings.json`, `.mcp.json`),
- **additive-and-never-overwrite by construction** — the sibling plan states and evidences this
  (`docs/infra-kit-setup-skill-plan.md` §"What makes the grant acceptable": `plugin-pointer.ts:18-19`,
  a managed block for zshrc, an unconditional layer-3 reseed),
- offline, idempotent, and near-instant.

The dependency half is machine-scoped, network-fetching, slow, changes software versions the user did not
choose, and is dangerous enough that a *computed* predicate refuses two of its recipes outright on every
host regardless of configuration (`lib/dependency-install/risk-predicate`).

These are not the same operation and they do not warrant the same consent. §3's answer is one sentence:
*"`setup` is strictly more dangerous than `setup-dependency` was… `requiresHumanConfirm` already covers
that."* That is an argument that the **maximum** risk is gated. It is not an argument that the
**minimum**-risk operation retains a usable identity — and the loss of that identity is precisely the
harm Principle 2 names. The owner is already exercising this granularity today:
`.claude/settings.json:12-14` carries three `ask` rules aimed at the installer and **zero** aimed at
`init`. After the merge that distinction is unexpressible: there is one name, so there is one rule.

The symmetry is exact. Option B is rejected because it forces a harmless read through the installer's
gate. Option A forces harmless *writes* through the installer's gate. The plan rejects one and adopts the
other without noticing they are the same move on a different axis.

The visible symptom is §5. `setup-dependency` carries `menuGroup: null` partly because *"installing
software is a deliberate act rather than something to land on by arrowing a menu"*
(`command-catalog.ts:580-581`). §5 reverses that with *"the palette row is itself a deliberate selection,
not a hover"* — an assertion about UI affordance, offered against a recorded design decision, and offered
*after* the plan has conceded that bare `setup` = "init writes + converge all five tools." A palette row
that installs five packages is prong 1 in miniature, and §5 concedes the reversal is negotiable, which
suggests the plan itself is not confident in it.

### Prong 2 — the merge falsifies the standing-grant justification in the sibling plan, and Phase 7 ships the result ungated

This is the prong that matters. `docs/infra-kit-setup-skill-plan.md` is in flight in this same tree and
its §"The standing mutating grant" is unambiguous:

> **This test is the normative copy of the grant.** … `setup → ['infra-kit doctor --json', 'infra-kit init']`
>
> **What makes the grant acceptable:** Not flaglessness — **additivity**. Every writer `init` drives leaves
> an existing value untouched by construction.

and, in its §Principles 4: *"Fencing a command in a SKILL.md obliges an `allowed-tools` rule (U6 clause 2),
and **a rule runs without a prompt**."*

Rename `init` → `setup` and the fenced grant `Bash(infra-kit setup)` now names a command that installs
software over the network. The property that made the grant acceptable — additivity — is **false of the
new command**. So the two-command plan's Phase 7 would ship a plugin skill in which an agent can run the
installer with **no prompt at all**, on the Bash path, bypassing every control §3 builds for the MCP path:
no `requiresHumanConfirm`, no HMAC `confirmToken`, no `_meta['anthropic/requiresUserInteraction']`. The
only surviving control is `risk-predicate`, which refuses two recipes and permits the other three.

And nothing catches it. I checked the live guard: `manifest.test.mjs:487` is
`test('U15: the doctor skill fences no state-changing command')`, scoped to `DOCTOR_SKILL`
(`:470`), with `MUTATING_INVOCATIONS` at `:479`. The sibling plan's generalisation of U15 to a global
deny set plus a per-skill permitted map has **not landed**. So a `setup` skill fencing `infra-kit setup`:

- passes U15 (out of scope — U15 only reads the doctor skill),
- passes U6 clauses 2 and 3 (it has a matching `allowed-tools` rule and the rule matches a fenced line),
- passes U3/`EXPECTED_SKILLS` once `'setup'` is added,
- passes T1 (`manifest.test.mjs:588` — no `mcp__infra-kit__*` string).

Which is to say: **I-5, I-6 and I-7 are all green in exactly this failure.** The plan's own test plan
certifies the hole.

This is a fourth pre-mortem scenario the plan does not have, and it is the most probable of the four,
because it is not a hypothetical future refactor — it is Phase 7, the plan's last step, executed as
written.

### What the antithesis does *not* establish

Two candidate objections I was asked to weigh, and which I judge weaker than they look:

- **"Moving the dependency read into `doctor` gives `doctor` a second home for a list it doesn't own."**
  As stated, no: `setup-dependency-status` is *deleted*, so `doctor` becomes the sole owner and the
  objects ride verbatim from `setupDependencyStatus()`. That is derivation, not duplication. But the
  objection is right for a reason the plan never considers, and §3 below shows it is right about
  `checks[]`, not about `setup-dependency-status`.
- **"The hidden `init` alias is a compatibility fiction."** No — this is the plan's strongest passage. The
  circularity is real and I verified both ends: `resources/root/body.md:15` renders into `/CLAUDE.md:34`,
  and that block is rewritten only by `infra-kit init` / `audit --fix` **run inside the consumer repo**.
  A hard removal leaves an instruction that names a command that exits non-zero, repairable only by the
  removed command. Eight lines of alias against a self-referential breakage is a good trade. Option D is
  correctly folded away.

---

## 2. The tension the plan resolves by assertion

**Principle 1 (taxonomy by question asked) vs Principle 2 (identity is a name).**

Principle 1 is a two-way partition of *verbs*: `doctor` asks, `setup` does. Principle 2 is a claim that
**granularity of name = granularity of consent**. On the read/write axis the two agree, and the plan reaps
that agreement brilliantly — it is the whole reason Option A beats Option B.

On the write/write axis they disagree. Principle 1 says `init` and the converge are both "do", therefore
one name. Principle 2 says two blast radii need two identities, therefore two names. The plan adopts
Principle 1 as the tiebreaker and never says why the tiebreaker is Principle 1 rather than Principle 2 —
it simply proceeds, and §3 supplies a sentence about the gate covering the maximum risk, which answers a
different question.

Naming the tension explicitly is not pedantry: the resolution changes the design. If Principle 2 wins on
this axis too, the answer is not a third name (the owner has ruled that out) but a **default** — see §6.

A second, smaller tension: §4's last bullet chooses the sibling-array design partly so that
`SECTION_MEMBERS` (`report.ts:64`) and `DOCTOR_CHECK_NAMES` (`:113`) stay untouched and
`report-inventory.test.ts` stays green. That is an architecture question settled by test convenience. The
report-inventory test exists precisely to force a legible diff when doctor's row inventory changes; routing
around it is the option that hides.

---

## 3. Principle violations, named

### V1 — "Never hold a second copy of a list you do not own" (sibling plan §Principles 2). **Violated by §4.**

§Q6 Objection 2 argues the dependency reports "do not become `checks[]` rows" and therefore sidestep
`report.ts`. True of `report.ts`. False of the payload. `doctor()` already emits rows for **four of the
five** dependency ids:

| dependency id | existing `doctor` row | site |
| --- | --- | --- |
| `gh` | `'gh installed'`, via `specFor('gh').probeArgv` | `doctor.ts:1402-1407` |
| `doppler` | `'doppler installed'`, via `specFor('doppler').probeArgv` | `doctor.ts:1414-1419` |
| `aws` | `'aws installed'`, via `specFor('aws').probeArgv` | `doctor.ts:1420-1425` |
| `portless` | `'portless installed'` | `doctor.ts:1299-1310` |
| `brew` | — (the only genuinely new one) | — |

So `dependencies[]` is a **second answer, in the same payload, to a question `checks[]` already answers** —
and the two answers have **different semantics that are documented to disagree**:

- `checkCommand` passes iff the binary resolves **on PATH**. The probe reports `present` and `onPath`
  separately, and the AWS installer writes `$HOME/.local/bin` — so `aws` can be `checks: fail` and
  `dependencies: { present: true, onPath: false }` in one response. An agent asking "is aws installed"
  now gets two answers and no rule for which wins.
- `portless` is worse, and the repo says so in writing. From the untracked
  `src/commands/doctor/__tests__/probe-argv-single-source.test.ts:41-46`: doctor resolves portless out of
  `node_modules` (`resolvePortlessBin`), **never off PATH** — *"Unifying it would silently change what the
  row means, from 'resolvable' to 'on PATH', and turn a passing check into a permanent failure."* The
  plan's design puts **both meanings under one tool's payload** and never reconciles them.

The fix is unification, not addition — see §6.

### V2 — the one-way seam declared by `probe-argv-single-source.test.ts` is crossed, silently, and the guard stays green

That same untracked test (`:34-39`) states the invariant in so many words:

> *"One-way seam: the registry owns 'how do I ask this tool for its version'; what would FIX a failing row
> belongs to `setup-dependency*`. **A doctor that could install is `doctor --fix` by another door.**"*
>
> `expect(DOCTOR_SOURCE).not.toContain('bootstrapInstall')` / `.not.toContain('updateFor')`

§4 has `doctor.ts` consume `setupDependencyStatus()`, whose payload carries `action: 'install'|'update'|'none'`
and `commands: string[]` ("the exact commands, one per step") — both **derived from the install recipes**
(`setup-dependency-status.ts:63-74`). The seam is crossed. And the guard **passes**, because it is a
source-text needle check and the needles are now one module away.

That is the repo's recorded vacuous-test failure mode, arriving from the other direction: not a test that
passes on its own bug, but a **plan that walks through a guard by relocating the thing the guard names**.
Either the invariant is wrong and the plan must retire it with an argument, or §4 must compose from
`lib/dependency-probe` + `lib/dependency-registry` directly rather than from the status command. It cannot
pass through in silence.

### V3 — "A test that passes on the bug it targets is a defect" (the plan's own Principle 5). **Violated by U-D2.** See §5.

### V4 — the sibling plan's Principle 4 (additivity, not flaglessness, is what makes the standing grant safe) is falsified and not restated. See §1 prong 2.

---

## 4. Soundness audit of the six Decisions

**§1 — compatibility split by publication status. SOUND, and better-evidenced than stated.**
The `init` alias argument is the best passage in the plan. Two corrections: (a) the "unpublished" claim is
now near-decisive (`git log --all` empty, 0 tags) and the residual check should be the 0.4.0 tarball, not
`npm view`; (b) §1 says the alias is kept "≥2 minor releases" while §Observability requires the warning to
"name its removal release" — the plan therefore cannot write the warning string it demands. **Pick a
version** (e.g. "removed in 0.6.0") or drop the observability requirement.

**§2 — what `setup` does, in order. Order and failure composition SOUND; the payload is missing.**
The order rationale is right (the local half enables the MCP surface at all and must not sit behind a
network converge), and "both halves always run, a refusal is not a failure" is the correct aggregate.
Three gaps:

1. **No structured return, and no `outputSchema`.** `init` is `async (): Promise<void>` (`init.ts:53`) and
   communicates entirely through `logger`. Under MCP the logger writes to `/tmp/mcp-infra-kit.log`
   (`lib/logger/index.ts:6,36` — `pino.destination({ dest: LOG_FILE_PATH })`), **not** to the caller. So an
   MCP `setup` call as specified performs ~8 local writes and reports **nothing at all** about them. The
   plan says "move `init.ts`'s body in" and promises "one combined summary", but never states that the init
   half must be rewritten to return a structured result, and specifies no `outputSchema` for the merged
   tool (today `setup-dependency`'s is `{tools, changed, allSucceeded}`, `setup-dependency.ts:179-183`).
   No test in the plan covers this: U-S1/U-S2 assert ordering and exit code, not payload.
2. **`installPluginForProject` spawns the host's own CLI.** `install-plugin.ts:155-176` runs
   `claude plugin install` via a subprocess. Under the MCP `setup` tool that is the infra-kit server
   spawning `claude` from inside a live Claude Code session. It is probably fine — `isInstalledFor`
   short-circuits so a configured machine spawns nothing — but it is the one init step that shells out to
   the host and it deserves a sentence, not silence.
3. No prompt hazard: I grepped the whole init graph for `confirmOrExit` / `@inquirer` / `prompt(` /
   `isTTY` and found **zero**. The recorded `confirmOrExit`-skips-`finally` and prompts-on-the-JSON-RPC-
   stream hazards do **not** apply here. Worth recording as a checked negative so review does not chase it.

**§3 — the MCP `setup` gate. SOUND for the MCP path; silent on the Bash path.**
Carrying both `requiresHumanConfirm` and `_meta` is right and correctly justified from
`setup-dependency.ts:186-197`; refusing `LOW_RISK_MUTATING_ALLOWLIST` is right and correctly justified
from `command-catalog.ts:576-578`. The gate reasoning is airtight — for MCP. It says nothing about
`Bash(infra-kit setup)`, which is the path the plugin skill uses and the path §1 prong 2 breaks open.
Missing edits: `EXPECTED_GATED_TOOLS` (`command-catalog.test.ts:209` holds `'setup-dependency'`) and
`REQUIRES_INTERACTION_TOOLS` (`mcp-stdio.e2e.test.ts:258` = `new Set(['setup-dependency'])`).

**§4 — `doctor` flips to `mcpExposed: true, mutating: false`. Mechanism SOUND; compensating control BROKEN; duplication UNADDRESSED.**
The nullary-handler argument is real and verifiable (`doctor.ts:1541-1543`), the `audit` precedent is real
(`command-catalog.ts:519-525`), and the plan quotes `command-catalog.test.ts:259-264` accurately about the
gap it inherits. `openWorld: true` is correct. But V1, V2 and V3 all land here, and U-D2 — the *sole*
payment for leaving the P1 gate's population — cannot be built as written.

**§5 — menu-group placement. DEFENSIBLE, under-argued, low stakes.** See §2. The plan concedes the
reversal is negotiable, which is honest. `groupPaths('setup')` must be edited in **two** places, not one
(below).

**§6 — fold before the trio lands. SOUND and well-argued.** The "delete an unpublished name once, free"
asymmetry is right, and the Commit A/B split is the right way to keep the lib work reviewable without
publishing doomed names. One thing to state: Phase 1's acceptance criterion is "`git diff --stat` touches
no `command-catalog.ts`, no `program.ts`, no `resources/`" — but the untracked tree also holds
`src/commands/setup-dependency*/` and `setup-dependency-gate-mutation.test.ts`, which are neither
`lib/dependency-*` nor landable in Commit A (they need catalog entries) nor deletable before Commit B
consumes their bodies. Say explicitly: those files **stay in the working tree across Commit A**.

---

## 5. Test plan — does each entry bite, and what mutation proves it

| # | Bites? | Finding |
| --- | --- | --- |
| U-C1 | ✅ | Real. Mutation: leave any of the four in the catalog. The regex also forbids a catalog entry for the alias, which is the point. |
| U-C2 | ⚠️ | Bites, but **incomplete**: `palette.test.ts:59` holds the same list (`['Setup & Diagnostics', ['init','doctor','setup-dependency-status','audit','version']]`). Edit both or the suite reds; the plan cites only `command-catalog.test.ts:378`. |
| U-C3 | ⚠️ | Weak as written — field assertions on an object. **Strengthen for free:** retarget the untracked `setup-dependency-gate-mutation.test.ts`'s `INSTALLERS` from `['setup-dependency']` to `['setup']`. That file already *performs* the mutation (strips `requiresHumanConfirm` from a catalog copy) and asserts the P1 predicate names the offender — strictly stronger than U-C3, and it **reds on Phase 3 anyway** since it hardcodes the removed name. The plan lists this file in its Evidence base and then never says what happens to it. |
| U-C4 | ❌ | Not a test. "The existing gate test is left unmodified" is a claim about the diff; a test cannot assert its own source is unchanged. **Demote to a Phase 3 acceptance criterion.** |
| U-C5 | ❌ | **False premise.** `EXPECTED_PARITY` keys on `entry.mcpTool` existing, not on `mcpExposed` — so `doctor: 'doctor'` is **already there** at `command-catalog.test.ts:315`. The map does not "gain" it. Rewrite: gains `setup: 'setup'`, **loses** `setup-dependency` and `setup-dependency-status` (`:324-325`). As written U-C5 is a no-op edit that proves nothing about the flip. |
| U-D1 | ✅ | Real. Mutation: add any key to `doctorMcpTool.inputSchema`. |
| **U-D2** | ❌ | **Unimplementable as specified, and its natural weakening is vacuous — see §5a.** |
| U-D3 | ✅ | Real, and the "parse a live payload" half is the good half. Caveat: `setupDependencyStatus()` runs real probes; on CI `brew` is absent, so this needs the `dependency-probe` mocked or it becomes slow and machine-dependent. |
| U-S1 | ✅ | Real. Mutation: reorder. |
| U-S2 | ✅ | The best of the setup tests. Mutation: `return` on first failure. |
| U-S3 | ✅ | Real, and the refusal-vs-failure distinction is the one that would actually be got wrong. |
| U-S4 | ✅ | Real. |
| I-1 | ✅ | Real, and correctly motivated — `palette.ts` skips an unresolvable entry silently, so a stale `program.ts` registration is invisible. |
| I-2 | ⚠️ | Good design (stated over the population, survives a rename). But "reports all five dependency ids" is satisfiable by a stub that returns five ids and nothing useful. Assert the five ids **and** a `present` boolean per id. |
| I-3 | ✅ | Real. |
| I-4 | ✅ | Real. |
| I-5 / I-6 / I-7 | ❌ | Each bites for what it targets, and **all three are green in the §1-prong-2 failure**: a `setup` skill fencing `infra-kit setup` passes U6 (matching rule), passes T1 (no `mcp__` string), passes U3 once `EXPECTED_SKILLS` gains `'setup'`, and passes U15 because U15 is scoped to `DOCTOR_SKILL` (`manifest.test.mjs:470,487`). The packaging gates certify an ungated route to the installer. |
| I-8 | ✅ | Real (resource ↔ snapshot). |
| E-1 | ⚠️ | Right idea, wrong line. The pinned set is `REQUIRES_INTERACTION_TOOLS` at `mcp-stdio.e2e.test.ts:258`; `:277` is inside the helper that consumes it. Edit `:258`. |
| E-2 / E-3 / E-4 | — | Manual, and honestly labelled as the only direct evidence for the central claim. No objection. |

### 5a. Why U-D2 cannot be built as written

`checkTokenStorePerms` is **defined at `doctor.ts:567` and called at `doctor.ts:1451` inside the same
module**. An ESM self-call binds to the module-local const, so `vi.spyOn(doctorModule, 'checkTokenStorePerms')`
cannot intercept it — the repo already has this recorded for named `fs` imports, and it is the same
mechanism. Two outcomes, both bad:

- Written as *"assert the spy was invoked with `false`"* → the spy sees **0 calls** and the test fails on
  **correct** code. Someone then "fixes" it.
- Written as *"assert the spy was never invoked with `true`"* → **vacuously green on the exact mutation it
  targets**, which is the plan's own Principle 5 violated by the plan's own flagship test. And U-D2 is the
  **sole payment** for removing `doctor` from the P1 gate's population (§Q6, §4, §Consequences). If it does
  not bite, the plan's central safety trade is unpaid and the flip is a straight subtraction.

**Two mechanisms that do bite, both available today:**

1. **`expect(doctorMcpTool.handler.length).toBe(0)`** — a runtime property of the registered function,
   two lines, no mocking. It reds the instant anyone writes `handler: (params) => doctor(params)`, which is
   Scenario 1's first mutation, and it composes with U-D1 to cover the second (`fix` added to
   `inputSchema`). This is strictly stronger than the `audit` precedent, which is what §Q6 promises.
2. **Cross-module behavioural**, if a real write assertion is wanted:
   `doctor-corrupt-token-store.test.ts:12-34` already demonstrates the seam — `vi.mock('src/lib/env-tokens', …)`
   **does** intercept, because it is a module boundary. Mock the token-store writer there, call the
   *registered handler* with `{ fix: true, confirmedCommand: true }`, assert zero write calls.

Take (1) as the primary and (2) as optional. Both name their mutation; neither can go vacuous.

---

## 6. Synthesis — the shape that absorbs the antithesis

The owner's constraint is **two names on three surfaces**. It does not require **two operations**, and
that distinction is the whole synthesis. Option A survives with two amendments; this is a REVISE, not a
RETHINK.

**A. `setup`'s default is the init half; the converge is opt-in on the same name — but the gate is not.**

- Bare `infra-kit setup` (and the palette row, which dispatches `[cliPath, ...groupPath]` with zero flags)
  runs the **init half only**: local, additive, offline, idempotent. That is the operation that is safe as
  a menu row, safe as a standing `Bash(infra-kit setup)` fence, and the one the sibling plan's additivity
  argument was written about. §5's reversal of `menuGroup: null` then needs no defending — the reversed
  comment was about *installing software*, and the palette row no longer installs software.
- The dependency converge is `setup --tools …` (or `--install-tools`), MCP `setup({ tools: [...] })`.
- **Critically: `setup` keeps `requiresHumanConfirm` and `_meta` unconditionally.** The plan is right that
  *"a gate selected by an argument is not a gate"* and Option B is rightly rejected on it. Here the
  argument selects **how much work**, never **how much consent** — the confirm token is HMAC-bound to the
  canonical args either way, and an agent that omits `tools` still faces both gates. This keeps Principle 2
  satisfied on the Bash axis (where a fence *can* name the default form) without reintroducing an
  argument-selected gate on the MCP axis.

**B. `doctor` unifies the dependency rows instead of shadowing them.**

The `gh` / `doppler` / `aws` / `portless` rows are **re-derived from the dependency reports** and
`SECTION_MEMBERS` (`report.ts:64`) is edited deliberately — a legible diff that `report-inventory.test.ts`
exists to force — rather than a contradicting `dependencies[]` being bolted alongside them to keep that
test green. `portless` needs an explicit decision recorded either way, because
`probe-argv-single-source.test.ts:41-46` says unifying it changes what the row means; the honest options
are "keep the node_modules row and exclude portless from the unified section" or "change the meaning and
say so." Either is fine. Silence is not.

And §4 must state what happens to the one-way seam (V2): retire it with an argument, or compose from
`lib/dependency-probe` directly so the seam holds.

**C. Phase 7 gets the guard the sibling plan already designed.**

The plugin `setup` skill fences the **init-only** form, and Phase 7 lands the sibling plan's
allow-list pin (`setup → [...]`, `deepEqual`) plus the U15 generalisation (global `MUTATING_INVOCATIONS`
+ per-skill permitted-fence map). Both are already specified in `docs/infra-kit-setup-skill-plan.md`
§"Guard: three independent parts" — this is a scheduling change, not new machinery. Without it, I-5/I-6/I-7
are green over a hole.

---

## 7. Missing pre-mortem — Scenario 4

**What breaks.** Phase 7 ships `plugins/infra-kit/skills/setup/SKILL.md` with
`allowed-tools: Read, Bash(infra-kit doctor --json), Bash(infra-kit setup)`, mirroring the sibling plan's
pinned grant with `init` renamed.

**How it reaches a user.** A skill's `allowed-tools` rule runs **without a prompt** (sibling plan
§Principles 4). Any session that loads `/infra-kit:setup` can now run the dependency converge — installing
or updating `brew`, `aws`, `gh`, `doppler`, `portless` — with no host prompt, no confirm token, and no
`_meta` interaction gate. Every control §3 constructs lives on the MCP path; this is the Bash path.

**Why CI stays green.** U15 reads only `DOCTOR_SKILL` (`manifest.test.mjs:470,487`); U6 is satisfied
because the rule matches the fence; T1 is satisfied because no `mcp__infra-kit__*` string appears; U3 is
satisfied once `EXPECTED_SKILLS` gains `'setup'`. I-5, I-6 and I-7 all pass.

**The guard that catches it.** Synthesis C: fence the init-only form, pin the skill's rule list by
`deepEqual`, and make `MUTATING_INVOCATIONS` global with a per-skill permitted map. Mutation that reds it:
changing the fence to bare `infra-kit setup`, or adding `--tools` to it.

---

## 8. Bottom line

Option A's central insight — a read path that keeps its own **tool name**, because an MCP permission rule
matches on nothing else — is correct, well-argued, and the only thing that answers
`setup-dependency.ts:154-158` on the merits. Keep it. The Q6 override is defensible and the plan is right
to argue it on the merits rather than on authority. §1's alias reasoning and §6's sequencing are both
strong enough to land as written.

What is not paid for: the P1 gate is given up against a compensating test that cannot be built (§5a); the
`dependencies[]` array shadows four rows `doctor` already owns, with documented disagreement (V1); the
plan walks through an invariant a test declares in prose while that test stays green (V2); the init half
has no structured return and the merged tool has no `outputSchema` (§4); and the plan's own final phase
ships an ungated Bash route to the installer that its own packaging tests certify as fine (§7).

All five are fixable inside Option A. **REVISE.**

---

## Appendix — files cited, with what each was checked for

- `apps/infra-kit/cli/src/lib/command-catalog/command-catalog.ts` — entries at `:489`, `:491-497`,
  `:500-508`, `:511-518`, `:519-525`, `:582-601`; `MENU_GROUPS:125`; allowlist `:576-578`;
  `MCP_TOOL_PRESENTATION:646`; `openWorld` rationale `:635`.
- `apps/infra-kit/cli/src/lib/command-catalog/__tests__/command-catalog.test.ts` — `EXPECTED_GATED_TOOLS:208-225`,
  P1 gate `:243-256`, `audit` precedent `:259-274`, `EXPECTED_PARITY:298-326` (note `doctor:'doctor'` at `:315`),
  `groupPaths('setup'):378`.
- `apps/infra-kit/cli/src/lib/command-catalog/__tests__/palette.test.ts:59` — second copy of the setup group list.
- `apps/infra-kit/cli/src/lib/command-catalog/__tests__/__snapshots__/command-catalog.test.ts.snap:265,274`.
- `apps/infra-kit/cli/src/lib/command-catalog/__tests__/setup-dependency-gate-mutation.test.ts` (untracked)
  — `INSTALLERS = ['setup-dependency']`, reds on Phase 3, retargetable to `['setup']`.
- `apps/infra-kit/cli/src/commands/doctor/doctor.ts` — `doctor():1396`, `checkTokenStorePerms` def `:567`
  and same-module call `:1451`, tool `:1520-1544`, dependency-overlapping rows `:1299-1310`, `:1402-1425`,
  `specFor` import `:37`.
- `apps/infra-kit/cli/src/commands/doctor/__tests__/probe-argv-single-source.test.ts` (untracked) — the
  one-way seam `:34-39`, the portless-meaning warning `:41-46`.
- `apps/infra-kit/cli/src/commands/doctor/__tests__/doctor-corrupt-token-store.test.ts:12-34` — the
  working `vi.mock` boundary for the U-D2 replacement.
- `apps/infra-kit/cli/src/commands/doctor/report.ts:64,113`.
- `apps/infra-kit/cli/src/commands/init/init.ts:53-127` — `Promise<void>`, logger-only reporting, no prompts.
- `apps/infra-kit/cli/src/commands/setup-dependency/setup-dependency.ts:150-161,179-183,186-199` (untracked).
- `apps/infra-kit/cli/src/commands/setup-dependency-status/setup-dependency-status.ts:63-84` (untracked).
- `apps/infra-kit/cli/src/lib/plugin-pointer/install-plugin.ts:155-176` — spawns `claude plugin install`.
- `apps/infra-kit/cli/src/lib/logger/index.ts:6,36` — MCP logs go to `/tmp/mcp-infra-kit.log`, not the caller.
- `apps/infra-kit/cli/src/lib/program/program.ts:384,569-585,663-685,711-717`; `setup` name free.
- `apps/infra-kit/cli/src/lib/tool-handler/tool-handler.ts:466` — `confirmedCommand: true` injection.
- `apps/infra-kit/cli/src/mcp/tools/index.ts` — registers `getExposedMcpTools()` only; two comments become
  false under the plan ("doctor … must never be registered here"; "`anthropic/requiresUserInteraction`
  rides here on the two setup-dependency tools").
- `apps/infra-kit/cli/src/mcp/__tests__/mcp-stdio.e2e.test.ts:258,273-285` — `REQUIRES_INTERACTION_TOOLS`.
- `apps/infra-kit/cli/src/types.ts:84-101`.
- `apps/infra-kit/cli/readme.md:72,100-109,111` — the exposed-tools bullet list and "21 tools total" are
  edit sites the plan omits.
- `apps/infra-kit/cli/resources/root/body.md:4,15`; `/CLAUDE.md:23,34`; `.claude/settings.json:12-14`.
- `plugins/infra-kit/__tests__/manifest.test.mjs:19-27` (`EXPECTED_SKILLS`), `:400` (U6), `:470,479,487`
  (U15, doctor-scoped), `:588` (T1).
- `plugins/infra-kit/skills/doctor/SKILL.md:1-5` — the existing `allowed-tools` shape.
- `docs/infra-kit-setup-skill-plan.md` §Principles, §"The standing mutating grant", §"What makes the grant
  acceptable" — the pinned `setup → ['infra-kit doctor --json', 'infra-kit init']` grant and its additivity
  justification.
- `progress.txt:375-386` — the Q6 consensus the plan overrides.
- Repo state: `git log --all -- '*setup-dependency*'` empty; `git tag` = 0; `pnpm view infra-kit version` = 0.4.0.

---

# Round 2 — review of revision 2 (2026-09-10)

> **SUPERSEDED MID-REVIEW — no verdict issued.** After this section was written the owner answered the
> §Open question with **B: flagless `infra-kit setup` installs everything.** Revision 2's additive-only
> default is reversed and revision 3 is being written. **R2.1 and R2.9 are now a record of a design that
> no longer exists**; R2.2–R2.7 are mechanics that do not depend on the answer and carry forward
> unchanged. See **§R2.10** for what B costs, **§R2.11** for the two newly measured facts, and
> **§R2.12** for the deferred round-3 checklist. Nothing here is approved for the Critic.

Read whole, not as a diff — finding 3 cascaded into §2, §5 and §1, and a diff-only read would miss the
part that matters. Option A with revision 2's flagless/`--tools` split was the right shape and five
defects remained, all in the test plan and the edit instructions.

---

## R2.1 — The cascade: all three claims VERIFIED, one needs a word changed

A cascade that resolves three open tensions at once deserved the suspicion. It survives it.

**(a) §5 is no longer a reversal of `command-catalog.ts:580-581`. VERIFIED AT SOURCE.**
`run-session.ts:199` spawns `deps.spawn(process.execPath, [deps.cliPath, ...command.groupPath], …)` —
zero flags — and `buildPaletteItems` (`palette.ts:63-68`) carries only `groupPath` into the row. So the
palette row runs **flagless** `setup`, which under §2 installs nothing. The recorded decision (*"installing
software is a deliberate act rather than something to land on by arrowing a menu"*) is honoured rather
than overridden. This is a real structural consequence, not a rationalisation of a conclusion already
reached — the zero-flag dispatch is the same fact `program.ts:658` already cites for `setup-dependency-status`.

**(b) §1's alias no longer gains blast radius. VERIFIED, with one precision fix.**
Flagless `setup` = init's writers + a read-only probe. Every init writer is additive-and-never-overwrite;
the probe writes nothing. The alias therefore cannot do more damage than `init` did, which is what §1's
rule ("a deprecation alias must never *gain* a blast radius") actually requires.

*Fix:* §1 says the flagless form is *"a superset of what `init` did, **with no new side effect**."* Not
quite — the alias now spawns five `<tool> --version` subprocesses that `init` never spawned. Benign, but
this plan is scrupulous elsewhere about the difference between a write and a read (it is the whole basis
of §3 and §4), and should be here: **say "no new write."**

**(c) The sibling plan's additivity justification survives the rename verbatim. VERIFIED.**
`docs/infra-kit-setup-skill-plan.md` §"What makes the grant acceptable" rests the standing grant on every
writer `init` drives being additive-and-never-overwrite by construction (`plugin-pointer.ts:18-19`, a
managed block for zshrc, an unconditional layer-3 reseed). Adding a read-only probe changes none of those
predicates. The rename is the only delta, and the justification transfers unmodified. Round 1's prong 2 is
**answered structurally**, which is the strongest form of answer available — the grant is safe because the
command is safe, not because a guard catches it. I-9/I-10 are then belt and braces, correctly described as
such at Scenario 4's "guard — two independent parts."

---

## R2.2 — Finding 2: the seam objection is ANSWERED, not relabelled

This is the claim I was asked to decide, and it decides in the plan's favour.

The seam (`probe-argv-single-source.test.ts:34-39`) is about **capability**, not about a module name: *"what
would FIX a failing row belongs to `setup-dependency*`. A doctor that could install is `doctor --fix` by
another door."* The fix-naming fields in the status payload are exactly `action` and `commands`
(`setup-dependency-status.ts:63-74`). §4 excludes both from `DependencyDetail` (`{manager, version,
present, onPath}`) and composes from `lib/dependency-probe` + `dependency-registry` directly. So `doctor`
gains probe **facts** and gains no remediation **capability** — the seam holds by construction, and U-D4
plus the type-level key assertion close the relocation hole the substring needle left open. Relabelling
would be keeping the capability and renaming the import; this is not that.

Two supporting claims also check out:

- **The narrowing is correct.** `doctor.ts:1402`, `:1414`, `:1421` each call `specFor(<id>).probeArgv`,
  pinned by `probe-argv-single-source.test.ts`'s `UNIFIED` list. The work is `detail` + one new row, not
  four rebuilt rows. Round 1 overstated the scope; the correction is accepted.
- **The portless exclusion is already pinned green.** `probe-argv-single-source.test.ts:47-48` asserts
  `DOCTOR_SOURCE` contains `resolvePortlessBin` and **not** `specFor('portless')`, with the reasoning in
  the comment above it. §4 keeps that exclusion and adds no `detail` to the row. Round 1's "silence is not
  fine" is satisfied — the decision was recorded before either of us looked. (Cite `:41-48`; `:41-46` is
  the title and comment, the assertions are `:47-48`.)

*One residual, worth a line:* say explicitly that `DependencyDetail` is a **distinct type**, not a
`Pick<>` of `reportSchema`. A `Pick` re-couples the two and makes a later widening of the source type
invisible at the Pick site — which would defeat the type-level assertion that is carrying the guarantee.

---

## R2.3 — Finding 1: `defineMcpTool` IS the identity, the arity test bites, and it has two one-token evasions the plan does not name

**Identity claim: VERIFIED exactly.** `types.ts:138-142` is

```ts
export const defineMcpTool = <TIn …, TOut …>(tool: McpTool<TIn, TOut>): McpTool<TIn, TOut> => {
  return tool
}
```

No wrapper stands between the authored closure and `doctorMcpTool.handler`. (`createToolHandler` /
`wrapForRegistration` in `src/mcp/tools/index.ts` wrap `tool.handler` *downstream*, at registration; they
do not alter the object the test reads.) So the primary form is buildable and needs no mocking.

**It bites on the named mutation.** `handler: (params) => doctor(params)` → `.length === 1` → red. So does
`({ fix }) => doctor({ fix })`. That is Scenario 1's first mutation, caught in two lines.

**But `Function.prototype.length` counts parameters before the first default and excludes rest.** Two
mutations that a "tidy-up" commit would plausibly produce both evaluate to `0` and pass:

```ts
handler: (params = {}) => doctor(params)      // .length === 0  — PASSES
handler: (...args) => doctor(args[0])         // .length === 0  — PASSES
```

Both are agent-reachable the moment `tool-handler.ts:466` injects the params object. §Known limitations
says only *"asserts arity, not behaviour"*, which does not convey that there are two one-token bypasses.

**Required:** promote the optional second form — `vi.mock('src/lib/env-tokens', …)`, call the *registered*
handler with `{ fix: true, confirmedCommand: true }`, assert zero write calls — from **optional to
required**, and name both evasions in the limitation. The boundary is demonstrated to work in this repo
(`doctor-corrupt-token-store.test.ts:12-34`). §4's sole funding cannot rest on an assertion with two
known bypasses; with the pair, arity catches the common mutation instantly and the behavioural test
catches the clever one.

---

## R2.4 — U-C3 misdescribes the test it retargets, inflating its strength

`setup-dependency-gate-mutation.test.ts` is genuinely the strongest available test for U-C3 and
retargeting `INSTALLERS` (`:35` — cited correctly) is right and non-optional. But the description is wrong
in two ways:

- *"strips `requiresHumanConfirm` from a catalog copy, `:51`"* — the strip is at **`:42`**
  (`requiresHumanConfirm: undefined` inside `withGateRemoved`). `:51` is the `it.each` that consumes it.
- *"adds the name to the low-risk allowlist, `:55`"* — **it does not.** `:55-59` performs **no** mutation;
  it asserts `expect(LOW_RISK_MUTATING_ALLOWLIST).not.toContain(cliName)`. The file performs **one**
  mutation, not two.

U-C3 remains stronger than revision 1's field assertions. It is not stronger *for the stated reason*, and
an overstated coverage claim in a plan is exactly what gets cited later as coverage that does not exist.
Correct the description.

---

## R2.5 — `DOCTOR_CHECK_NAMES` is derived, not a second list — §4 and Phase 4 both state otherwise

`report.ts:113` is

```ts
export const DOCTOR_CHECK_NAMES: readonly string[] = SECTION_MEMBERS.flatMap(([, names]) => { return names })
```

So the new `brew installed` row requires **one** edit (`SECTION_MEMBERS`, `report.ts:64`), not two. §4's
*"requiring a deliberate `SECTION_MEMBERS` edit (`report.ts:64`) and a `DOCTOR_CHECK_NAMES` entry (`:113`)"*
and Phase 4's *"its `SECTION_MEMBERS` / `DOCTOR_CHECK_NAMES` edits"* both send an implementer hunting for
a list that cannot be edited. (Round 1 cited both because revision 1 did; on re-check only `:64` is an
edit site.)

---

## R2.6 — Scenario 4's guard-2 instruction would delete two live needles, and overstates one citation

**The needle list is wrong.** `manifest.test.mjs:479-485` currently holds **five** entries:

```js
const MUTATING_INVOCATIONS = ['--fix', 'infra-kit init', 'audit --fix', 'setup-dependency', 'setup-dependency-update']
```

The plan names three and says *"those become `'infra-kit setup --tools'` and `'infra-kit setup --update'`"*,
which reads as replacing the list. Three corrections:

- `'--fix'` and `'audit --fix'` must **survive** — they are unrelated to this plan and dropping them
  un-fences `doctor --fix` and `audit --fix` for every future skill.
- `'infra-kit init'` must **also survive until 0.6.0**: the hidden alias still resolves, so removing the
  needle un-fences a name that still works.
- The comment at `:475-478` — the caveat that `setup-dependency` is a prefix of `setup-dependency-status`
  and *"if a status-fencing skill ever ships, this needle needs a word boundary"* — becomes dead once
  those names are deleted. Delete it deliberately rather than leaving a caveat about names that no longer
  exist.

**Minor:** the permitted map should be `setup → []`, not `setup → ['infra-kit setup']`. Under the corrected
needle list, flagless `infra-kit setup` matches no needle, so the permitted entry grants nothing — a dead
entry, which is precisely the shape U6 clause 3 exists to forbid.

**One overstatement.** Scenario 4 says the no-prompt mechanic *"is asserted by this repo's own CI at
`manifest.test.mjs:472-474`."* `:471-474` is a **comment** (*"a fenced line obliges an allowed-tools rule
(clause 2), and a rule is a standing grant that runs without a prompt"*). CI cannot assert a host's
prompting behaviour. Reword to *"recorded at `:471-474`, and U15's existence is the repo acting on it."*
The plan is careful about comment-versus-test everywhere else; hold it to that here.

---

## R2.7 — Spot-checks on findings 4 and 5, and on the measured facts

**All corrected line numbers check out**, spot-checked rather than re-derived: `.claude/settings.json:11-14`;
`setup-dependency.ts:181` (`allSucceeded`); `command-catalog.test.ts:209` (`EXPECTED_GATED_TOOLS`),
`:298-326` with `doctor: 'doctor'` at `:315`, `:324-325`, `:378`; `palette.test.ts:59`;
`mcp-stdio.e2e.test.ts:258`; the catalog snapshot at `:265` / `:274`; `src/mcp/tools/index.ts:10-11` and
`:45`; `init.ts:53`; `types.ts:138-142`; `manifest.test.mjs:19-27`, `:400`, `:470`, `:479`, `:487`, `:588`.

**The `InitReport` design (finding 4) is right.** Making `initCore` return one entry per step while the CLI
wrapper logs them keeps human output byte-identical, which is the correct way to add a payload without
touching a surface the owner did not ask to change. Phase 2's acceptance criterion states that explicitly.
The `outputSchema` reusing `setup-dependency`'s `tools` / `changed` / `allSucceeded` names is a good call —
it makes the snapshot diff read as a rename.

**The measured facts are stated correctly and framed honestly.** §1's tarball table, the
`npm pack | tar -xzO | grep -c` re-verification recipe, the "43-file esbuild bundle" note explaining why
listing filenames proves nothing, "0 tags", and "published == local == 0.4.0" all match what was reported.
§Known limitations correctly says the premise *"is discharged only by the Phase 0 tarball check, not by
this document"* rather than claiming it already discharged — that is the right register. The hulyo/travelist
limitation is stated correctly and credits the independent confirmation. **Not re-checked, as instructed.**

---

## R2.8 — Required changes that survive decision B

Every round-1 finding was answered on the merits, two of them by narrowing my scope claims, correctly.
Five defects remained. **All five are B-independent and still required in revision 3** — they live in the
test plan and the edit instructions, not in the default-behaviour decision.

1. **Promote U-D2's second form from optional to required**, and name the two evasions
   (`(params = {}) =>` and `(...args) =>` both yield `.length === 0`). §4's sole funding cannot rest on an
   assertion with two one-token bypasses (R2.3).
2. **Correct Scenario 4's `MUTATING_INVOCATIONS` instruction**: it is five needles, not three; `'--fix'`,
   `'audit --fix'` and (until 0.6.0) `'infra-kit init'` must survive; delete the now-dead prefix caveat at
   `:475-478`; set the permitted map to `setup → []` (R2.6).
3. **Fix U-C3's description of the test it retargets**: the strip is `:42` not `:51`, and `:55-59`
   *asserts* the allowlist exclusion rather than performing a mutation — the file performs one mutation,
   not two (R2.4).
4. **Drop `DOCTOR_CHECK_NAMES` as an edit site** in §4 and Phase 4 — it is `SECTION_MEMBERS.flatMap(…)`
   at `report.ts:113`, so `SECTION_MEMBERS` (`:64`) is the only editable list (R2.5).
5. **Two wording precisions**: §1's alias is a superset "with no new **write**" (it does spawn five
   `--version` probes, R2.1b); Scenario 4's no-prompt mechanic is **recorded** at `manifest.test.mjs:471-474`,
   not "asserted by CI" (R2.6). Optionally add that `DependencyDetail` is a distinct type, not a `Pick<>`
   of `reportSchema` (R2.2).

None of these touches the default-behaviour decision, so all five carry into revision 3 verbatim.

---

## R2.9 — My recommendation on the §Open question (OVERRULED by the owner; recorded, not re-litigated)

I recommended keeping revision 2's answer. The owner chose B. **That is the owner's call and it is
settled** — §R2.10 works out what B costs and what revision 3 has to do about it, not whether B was right.

Recorded for the record, because two of the three arguments become *work items* under B rather than
disappearing:

- T1 (`manifest.test.mjs:588`) forbids **any** file under `plugins/*/skills/` from containing the string
  `mcp__infra-kit__`. Under B the skill cannot fence `Bash(infra-kit setup)` and must route installs
  through the gated MCP tool — but it cannot *name* that tool either. It can only gesture in prose, and
  I-7 reds the moment anyone writes the name down. **This is now a design constraint on the skill body**,
  not an argument against B (§R2.12 item 5).
- The deprecated `infra-kit init` alias now installs software (§R2.10b).

---

## R2.10 — What decision B costs: the cascade reopens, and it was real

The lead asked whether I had found revision 2's cascade shaky. **I had not — I verified all three legs at
source and they held** (R2.1). That is the useful finding now, and it points the other way from "rev 2 was
papering over something": the three resolutions were genuine, so B does not expose a weak argument, it
**spends three real resolutions** to buy install ergonomics. The price was measured. Revision 3 must pay
it explicitly rather than let the reversal land silently.

**(a) §5 becomes a reversal of `command-catalog.ts:580-581` again — and now it is not close.**
`run-session.ts:199` dispatches `[cliPath, ...groupPath]` with zero flags, so under B the palette row
**installs five packages by arrowing a menu** — verbatim what that comment forbids (*"installing software
is a deliberate act rather than something to land on by arrowing a menu"*). Revision 1's argument for the
reversal was assertion, I said so in round 1, and revision 2 dissolved the question rather than answering
it. Under B it has to be answered.

*My recommendation:* `menuGroup: null` for `setup`, making `groupPaths('setup') === ['doctor','audit','version']`.
It honours the recorded decision, and — see (d) — it also deletes the only bare-"setup" string the plan
emits into a human-facing surface. Two problems, one edit. The cost is that the owner's headline command
is absent from the picker, which is a real trade and the owner's to make; revision 1 already noted
`menuGroup: null` "costs only the palette row and nothing else in this plan depends on it."

**(b) §1's alias now gains a blast radius — the plan's own rule, violated. This is the biggest open item.**
§1 states: *"A deprecation alias must never* gain *a blast radius."* Under B, `infra-kit init` → flagless
`setup` → installs `brew`, `aws`, `gh`, `doppler`, `portless`. And this is not hypothetical: the newly
measured consumer facts (§R2.11) make it a live path. An agent in hulyo, travelist or starter-workspace
reads its committed `CLAUDE.md`, follows *"`ik init` — re-runs shell integration and refreshes every
guidance block"*, and gets a five-package converge it was never told about — on a repo whose owner never
ran this plan. Scenario 2's guard (the alias) becomes Scenario 2's hazard.

Revision 3 must choose, and none of the three is free:
1. **The alias maps to a narrower form** (init writes + report). Then it is not an alias, and §1's whole
   "eight lines" economy argument has to be rewritten — but the behaviour is right and the deprecation
   warning can say so.
2. **Hard-remove `init`** (Option D). Still has no guard, and §R2.11 now shows a *measured* instance of
   the non-self-healing premise, so this got worse, not better.
3. **Keep the alias, accept the converge, and warn loudly.** Cheapest to write, worst to receive.

I recommend (1) and think it is close to forced: it is the only option under which the committed
instruction in three consumer repos keeps meaning roughly what it said when it was written.

**(c) The sibling plan's grant instruction inverts — R2.6's fix must be rewritten, not just corrected.**
With `Bash(infra-kit setup)` dropped, the sibling plan's pinned allow-list becomes
`setup → ['infra-kit doctor --json']` and its permitted-mutating map becomes `setup → []`; meanwhile
`MUTATING_INVOCATIONS` must **gain the bare needle `'infra-kit setup'`**, because under B the bare form is
the installer. That is the opposite of what R2.6 told revision 2 to write. Consequence to record: a bare
`'infra-kit setup'` needle means **no skill may fence that line at all**, including in a documentation
example — correct under B, and it must be written down or someone will "fix" a red U15 by adding a
permitted-map entry.

**Status change, and it matters:** under revision 2, I-9/I-10 were belt-and-braces behind a structural fix
(the flagless form could not install). Under B there is no structural fix — the safety rests entirely on
*no fence existing*, which is a property nobody asserts unless I-9/I-10 assert it. **I-9 and I-10 are now
load-bearing**, and Scenario 4 must be rewritten to say so rather than describing a two-part guard whose
first part no longer exists.

**(d) The `setup` name is triple-loaded, and the plan emits one bare "setup" it does not control.**

Measured in this repo, not only in consumers: **`/package.json` itself ships
`"setup": "pnpm run runtime-set-node && pnpm install"`.** So the collision is five repos, not four, and it
is present in the repo where the plan is being written. Three readings of "run setup":

| Invocation | What it does | Failure mode |
| --- | --- | --- |
| `infra-kit setup` / `ik setup` | init writes + install five packages (under B) | — |
| `pnpm run setup` | `runtime-set-node && pnpm install` | succeeds, does something else |
| `pnpm setup` | pnpm builtin — configures the global bin dir and edits a shell profile | succeeds, does something else |

Two of the three "succeed" while doing the wrong thing. Under B the asymmetry points the dangerous way:
the user who *means* `pnpm run setup` and types `infra-kit setup` gets five package installs they did not
ask for.

*Is the plan's mitigation — always emit binary-qualified `ik setup` / `infra-kit setup` — sufficient?*
**Necessary, well-founded, and not sufficient.** Well-founded because `ik` and `infra-kit` are **real
binaries, not shell aliases** — `init.ts:469` records exactly this (*"No `alias ik=…` here: a global
install provides real `infra-kit` and `ik` bins"*), so a qualified form is unambiguous by construction and
cannot be shadowed by a package script. Not sufficient for three reasons:

1. **It does not reach the palette row.** `command-palette.tsx:285` renders `{item.name.padEnd(nameWidth)}`
   where `item.name` is `entry.groupPath.join(' ')` — a **bare `setup`**, with no binary qualifier, in the
   picker a human reads and the search filter at `:69` matches on. `buildPaletteItems` (`palette.ts:63-68`)
   cannot carry a qualifier without changing its shape. This is the one human-facing bare "setup" the plan
   emits, and under B it is also the installer row — which is why (a)'s `menuGroup: null` resolves both.
   *Checked and clean:* `run-session.ts:117` emits `` `infra-kit ${groupPath}` `` and `command-echo.ts:93`
   emits `pnpm exec infra-kit …`; both are qualified.
2. **It cannot govern the human's utterance.** The failure is someone being *told* "run setup" in
   conversation. No emission rule reaches that.
3. **The plugin skill is named `setup` and is invoked as `/infra-kit:setup`.** Under B that skill cannot
   fence the command, so its body must *instruct* a human or agent to run it — which is the highest-risk
   bare-"setup" site in the whole design, and it lives in a file whose guards (T1, U6) police tool names,
   not prose ambiguity.

*Recommendation for revision 3:* a short **§Naming and disambiguation** section that (i) states the
five-repo collision as measured fact, (ii) makes binary-qualified emission a rule with a grep-able test
over `resources/`, `readme.md`, the skill bodies and the deprecation warning, (iii) **decides the palette
row explicitly** rather than inheriting it, and (iv) fixes the exact wording the skill body uses to name
the command, since under B it instructs rather than fences.

---

## R2.11 — The two newly measured facts, folded in

**All four consumer repos read; §1's last unverifiable premise is discharged, and one repo *demonstrates*
it.** `hulyo-monorepo/CLAUDE.md:182,193` and `travelist-monorepo/CLAUDE.md:271,282` carry the current
block wording; `starter-workspace/CLAUDE.md:68,78` carries **older** wording than `resources/root/body.md`
renders today. That last one converts §1's central claim from an inference into an **observed instance**:
a consumer repo is right now carrying a generated instruction that its own upgraded CLI would render
differently, and nothing regenerates it until someone runs the command inside that repo. Revision 3
should cite starter-workspace by line as the evidence and **delete the corresponding §Known-limitations
bullet**, which is now discharged. My round-1 and round-2 statements that this was unverifiable *from this
machine* were correct at the time and are now superseded — no correction needed to the reasoning they
supported, which the evidence confirms.

**starter-workspace is a fourth in-scope consumer, and it is the one plugin changes reach fastest.** It
consumes the plugin via marketplace (`.claude/settings.json:81`) and holds no local skill copies, so
Phase 7's marketplace bump lands there automatically. That sharpens the §Landing hazard the plan already
names (plugin ships instantly, CLI ships only on publish): there is now a **named** repo that receives the
skill the moment it is published, whose CLI is whatever the global install happens to be. Revision 3's
§Landing should name it rather than describe the hazard abstractly.

**Combined with §R2.10b, these two facts interact badly and revision 3 must address the pair.**
starter-workspace holds *stale* guidance naming `ik init`, receives the *new* plugin immediately, and
under B `ik init` installs five packages. That is the concrete sequence to write into Scenario 2.

---

## R2.12 — Deferred to round 3: what I must see in revision 3's text

No verdict until B is in the text. On receipt I will check, in this order:

1. **§1's alias decision under B** — which of R2.10b's three options, argued rather than asserted, with the
   deprecation warning's wording quoted. *This is the item most likely to change my verdict.*
2. **§5 / `menuGroup`** — decided explicitly under B, with the `command-catalog.ts:580-581` comment either
   honoured or overridden on the merits; and `groupPaths('setup')` repinned consistently at **both**
   `command-catalog.test.ts:378` and `palette.test.ts:59`.
3. **Scenario 4 rewritten** — its structural first guard is gone; I-9/I-10 named as load-bearing; the
   allow-list becomes `setup → ['infra-kit doctor --json']`, the permitted map `setup → []`, and
   `MUTATING_INVOCATIONS` gains bare `'infra-kit setup'` while retaining `'--fix'` and `'audit --fix'`
   (R2.6's list correction still applies; its *content* is inverted).
4. **A §Naming and disambiguation section** per R2.10d, including the palette-row decision and a grep-able
   emission test.
5. **The skill body's instruction wording** — under B it instructs rather than fences, cannot name
   `mcp__infra-kit__setup` (T1, `manifest.test.mjs:588`), and must still be unambiguous about which
   `setup`. I want the sentence, not a description of the sentence.
6. **The five R2.8 items applied** — they are B-independent and none should have moved.
7. **U-S5 inverted or deleted** — it asserted "flagless `setup` installs nothing", which is now false by
   design. Whatever replaces it must still pin that `--tools`/`--update` semantics did not silently
   collapse into the default (U-S4's mutation is now easier to make and harder to see).
8. **§Known limitations** — the hulyo/travelist bullet deleted as discharged (R2.11); the
   `Bash`-prefix-rules bullet re-checked, since §3's `Bash(infra-kit setup --tools:*)` rules no longer
   describe the installer's invocation under B.

Mechanics I have already established and will **not** re-derive: `defineMcpTool` is the identity
(`types.ts:138-142`) and the arity assertion's two evasions (R2.3); the seam is answered by construction
(R2.2); `DOCTOR_CHECK_NAMES` is derived (R2.5); `MUTATING_INVOCATIONS` is five needles (R2.6);
`run-session.ts:199` dispatches zero flags; `ik`/`infra-kit` are real bins, not aliases (`init.ts:469`);
all R2.7 line numbers.

---

# Round 3 — review of revision 3 under decision B (2026-09-10)

**Verdict: REVISE.** The *design* under B is right and I would defend `--skip-tools` as the mechanism.
But revision 3 is a partial edit of revision 2: the **ADR still states the opposite of the decision**,
§Option A still describes the reversed design, §2 contradicts itself about the flag surface, **four of my
five round-2 required changes were not applied**, Scenario 4's central safety sentence is wrong on the
mechanism, and the command-vs-skill rejection rests on a misreading of the very test it cites. With ralph
executing on the Critic's approval, a plan whose ADR contradicts its body is not ready to be code.

---

## R3.1 — Item 1: is `--skip-tools` sound, or does it move the problem?

**Sound, and it is the right answer to B — but the plan does not name the class-change it makes.**

Revision 2 carried the additivity invariant in the **default**: a rule that names an argv gets the safe
one for free, and no test is needed to keep it safe. Revision 3 carries it in a **flag**, which means the
invariant is now carried by *tests*. That is a real change in kind, and the plan should say so in one
sentence rather than leave a reader to notice.

I checked the failure direction case by case, and the picture is better than the framing suggests:

| Way the flag goes missing | Fails | Guard | Judgement |
| --- | --- | --- | --- |
| A fenced rule loses `--skip-tools` | **open** — prompt-free installer | **I-9** `deepEqual` pin | Real guard, and it bites |
| The alias is wired to flagless `setup` | **open** — stale consumer block acquires an installer | **U-S7** (behavioural, `dependency-install` mocked) + **I-3** | Two independent guards; this is the plan's best-defended edge |
| A flag is **misspelled** (`--skip-tool`) | **closed** | Commander default | **Checked:** no `allowUnknownOption` / `allowExcessArguments` anywhere in `program.ts` or `entry/cli.ts`, so an unknown option errors and exits non-zero. Fail-safe. **Record this as a checked negative** — it is the failure mode a reader will worry about and it happens to be good news |
| Flag **ordering** with the variadics | **closed** | `--tools <ids...>` stops at the next option; `--skip-tools` + `--tools`/`--update` is a declared usage error (§2) | Fine as specified |
| A human or agent types bare `setup` meaning the additive form | **open** | none possible | The irreducible price of **decision B itself**, not of `--skip-tools` |

So `--skip-tools` does not move the problem; it relocates a default-carried invariant into two
test-carried ones, both of which have real mutations named. **Acceptable trade, not a regression dressed
as a resolution.**

**One exposure the plan does not cover.** Under revision 2, a user writing `Bash(infra-kit setup)` into
*their own* `.claude/settings.json` — a natural rule to write — got something safe. Under B that is a
prompt-free installer, and §3's `ask` list reaches only *this* repo. The four consumer repos have their
own settings files, and `.claude/settings.json` is precisely the file `syncPluginPointer` writes into
(two keys only, by contract). The plan should either add a line to the generated guidance body warning
that `infra-kit setup` installs software, or state the exposure in §Known limitations. It is cheap and it
is the one place B's blast radius escapes the plan's reach.

---

## R3.2 — Item 2: the whole-line matching trap — caught correctly, and the fix is implementable

**The planner's diagnosis is exactly right, and sharper than it looks.** The trap is not in the deny
direction; it is in how the *permit* is written. Working it through against how `manifest.test.mjs`
actually operates (`fencedLines(parsed.body)` yields whole lines; U15 today does
`line.includes(needle)`):

- deny: `line.includes('infra-kit setup')` → the bare line **and** the `--skip-tools` line both flagged.
- permit as **whole line** (`permitted.includes(line.trim())`): bare line not permitted → **red** ✓.
- permit **per needle** (the tempting shape, because the deny loop yields needles): "is needle
  `'infra-kit setup'` permitted for this skill?" → `'infra-kit setup --skip-tools'.includes('infra-kit setup')`
  → **true** → the denied form is silently re-permitted. **This is the bug**, and it is the natural way to
  write it.

The red fixture the plan specifies — a skill fencing bare `infra-kit setup` while permitting
`--skip-tools` — **reds under whole-line and passes under needle-permit**, which is precisely the
discrimination required. **I-10 bites.**

Three refinements, all cheap:

1. **The fixture must live under `FIXTURES_DIR` and be loaded explicitly**, the way U5's red fixtures are
   (`loadFixture`, `manifest.test.mjs:390-394`). `EXEMPT_DIRS` (`:15-17`) excludes it from live corpus
   scans; a fixture placed in `skills/` would redden the live suite instead of the guard.
2. **Cite the precedent with its polarity, not as a match.** `manifest.test.mjs:475-478` documents the
   `setup-dependency` ⊂ `setup-dependency-status` relationship, but it calls substring matching
   *"deliberately the fail-closed direction."* That is true on the **deny** side. The new hazard is the
   **permit** side, where the identical string relationship is fail-**open**. A reader who follows the
   citation finds a comment endorsing the thing the plan is warning about. Say "same string
   relationship, inverted safety polarity."
3. **The permitted whole-line must survive the formatter.** Whole-line equality is byte-exact, and this
   repo has already learned that prettier owns `.md` bytes — the plan itself adds that caution to I-8.
   Same caution belongs on I-10, or the guard reds on a reflow rather than on a real change.

---

## R3.3 — Item 3: Scenario 4's residual — the plan's answer names a gate that is not on the path

**This is a substantive error, not a wording nit.** Scenario 4 concludes:

> *"The only gate that survives `bypassPermissions` is `_meta['anthropic/requiresUserInteraction']` on the
> MCP tool …, plus `risk-predicate` inside the CLI. This is the concrete reason §3 keeps both gates
> unconditional: under B they are not belt-and-braces, they are the last line on the only path an agent
> can reach without a prompt."*

The agent in scenario (2) is routing around a missing Bash grant by spelling the command differently —
`npx infra-kit setup`, `pnpm exec …`, `node …/cli.js setup`. That is the **Bash** path. `_meta` rides on
the `tools/list` entry of the **MCP** tool and is never consulted for a Bash invocation. So on the exact
path the scenario describes, `_meta` provides **zero** protection, and the sole remaining control is
`risk-predicate` — which refuses only the sudo/network-piped recipes (the Homebrew bootstrap and the
first AWS CLI install) and **permits the other three installs**. §3's unconditional gating is not the
answer to this residual; it answers a different path.

**Does the CLI therefore need its own control? No — and the honest answer is stronger than the one the
plan gives.** In `bypassPermissions` the agent can already run `brew install gh` or `pnpm add -g` directly;
it does not need infra-kit to install anything. infra-kit's installing path adds essentially **no marginal
exposure over the ambient risk the mode already grants**. That is the correct argument and it should
replace the current sentence.

And a CLI-side confirm would be actively wrong here, for a reason this repo has already recorded:
`confirmOrExit` calls `process.exit(0)` on decline and skips every `finally`, and the same handlers run
inside the long-lived MCP server — so adding an interactive brake to the installing path would break
non-interactive/CI use *and* reintroduce a known hazard. Say that; it turns "we added no control" from an
omission into a decision.

*Also correct the scope claim while you are there:* `risk-predicate` is described in §3 as "the only
control shipping inside the CLI," which is true, but §Known limitations should state **which three of
five** it permits, so nobody reads it as a general installer brake.

---

## R3.4 — Item 4: adjudication — the text specifies a **skill**, and its stated reason for rejecting the command is **false at source**

**What the text specifies:** a skill. Phase 7 (`:875-880`) and Scenario 4 (`:687-703`) both name
`plugins/infra-kit/skills/setup/SKILL.md`, fencing `--skip-tools`, naming the installing form *in prose*.
The ADR's alternatives list rejects "Plugin command instead of a skill." **The lead's command ruling is
not in the plan.**

**Why the rejection does not hold.** Scenario 4 argues:

> *"T1 (`manifest.test.mjs:588`) forbids any skill from naming an infra-kit MCP tool, so the skill cannot
> say 'call `mcp__infra-kit__setup`' … Prose + the human's own shell is the only spelling that satisfies
> both guards at once."*

The premise is true and the conclusion is false, and the file the plan cites says so **four lines above
the test it quotes** (`manifest.test.mjs:607-613`):

> *"Three of the plugin's strongest guards do not see `commands/` at all: U6 and U12 walk `skillDirs()`,
> and T1 walks `SKILLS_DIR`. **That is not an oversight to route around — T1's scope is precisely what
> LETS a command name an MCP tool, which a skill may never do.** T1b pins both halves of that boundary…"*

T1 is not a wall; it is a **door with a sign on it**. The repo scoped T1 to `SKILLS_DIR` deliberately so
that the case the plan is in — "this text must name an MCP tool" — has a sanctioned home. And the working
example already ships: `plugins/infra-kit/commands/release-create.md:8` names
`mcp__infra-kit__release-create` in a three-line body. **"Prose is the only spelling that satisfies both
guards" is false at source and must be rewritten regardless of which path is chosen.**

**Does the command path work? Costed at source — yes, and every cost is enumerable:**

| Gate | What a `setup` command owes it |
| --- | --- |
| U13 (`:619`) | `EXPECTED_COMMANDS` gains `'setup.md'` |
| U14 (`:630`) | exactly the three keys `argument-hint`, `description`, `name`; `name` == filename stem; **body exactly 3 non-empty lines** |
| U17 (`:665`) | if `argument-hint` names any `--flag`, a workflow body must exist at `resources/workflow/setup.md`. A flagless hint is explicitly legal |
| `check-workflow-resource-published.mjs` | the body must contain `it needs infra-kit <x.y.z> or newer` and an `infra-kit://workflow/<name>` URI; the script parses **every** command (`readCommands()` enumerates the directory, deliberately not a literal) and asserts published `infra-kit@latest` ≥ floor **and** that the published build answers `resources/list` with the URI |

That last row is not a tax — **it is the plan's own §Landing discipline, mechanized.** The plan currently
promises "Commit B publishes, then Commit C ships the plugin" as a convention a human must honour; the
command path turns it into a gate that reds if anyone gets it backwards. That is an argument *for* the
command, and the ADR currently lists the version floor as a cost.

**My adjudication.** I agree with the lead's direction and would go further than the lead framed it:

- **Minimum, non-negotiable:** rewrite the rejection. Whatever is chosen, the plan must not ship a claim
  that T1 forbids the fix when `manifest.test.mjs:609-611` says T1's scope exists to permit it.
- **My recommendation:** a single `plugins/infra-kit/commands/setup.md` and **no `setup` skill.** Three
  lines: read `infra-kit://workflow/setup`; on failure call `mcp__infra-kit__setup` (both gates fire —
  the installing path is now gated rather than narrated); if the server is not connected, stop. This
  **deletes** the untestable prose, **deletes** the `Bash(infra-kit setup --skip-tools)` standing grant
  and therefore I-9, **removes** the urgency behind the U15 generalisation and the entire whole-line
  substring trap (R3.2), and keeps `EXPECTED_SKILLS` at seven so "two commands" reads cleanly on the
  plugin surface too. The cost is that the *additive* path also goes through the gated tool and so
  prompts — the same ergonomic loss the owner already accepted for the palette row, and for the same
  reason.
- **What I would not do:** ship a command *beside* a skill of the same name. Both surface as
  `/infra-kit:setup`; a namespace collision is a poor trade for keeping a grant. If both are wanted, the
  command must be named differently (`setup-tools`), which spends a third plugin entry point against a
  goal that is about having two.
- **One constraint the lead should weigh before ruling finally:** this is not solely this plan's decision.
  `docs/infra-kit-setup-skill-plan.md` §Naming already settled `setup` as a **skill** name (rejecting
  `init` over Claude Code's built-in `/init`, with an auto-invoke mitigation against
  `/oh-my-claudecode:setup`), and its guard design assumes a skill. Switching to a command changes that
  plan's §Naming and voids its guard parts (1) and (3) for `setup`. **Loop that plan's owner in rather
  than switching silently** — this may be the constraint the lead suspected they had missed, and it is
  real, though it is a coordination cost rather than a technical objection.

---

## R3.5 — Item 5: my two deferred items, and the five required changes

**Deferred item 1 — §1's alias under B: SOUNDLY answered, and it is the best section in revision 3.**
The alias maps to `--skip-tools`, not to flagless `setup`; the reasoning ("a deprecation alias must mean
what the name always meant") is stated as a rule, the two alternatives are rejected with mechanism
(a stderr warning does not stop an agent; the MCP gate is not on the CLI path), the warning string is
quoted, and the mutation is caught **twice** — behaviourally by U-S7 and structurally by I-3. This is
answered, not merely addressed.

**Deferred item 2 — §5 / `menuGroup`: SOUNDLY answered, and better than I expected.** The added reason is
correct and I had not made it: `groupPath` is command tokens, flags are not Commander leaves, so
`resolveLeaf` **cannot** address a narrowed form — the palette could only ever show the installing one.
That converts §5 from a judgement into a constraint. `groupPaths('setup')` is repinned consistently in
both places (`command-catalog.test.ts:378`, `palette.test.ts:59`) and U-C2 names "leaving `setup` in
either list" as the mutation. The cost is stated honestly and the reversibility is stated accurately.
*Side effect worth noting:* dropping the row also removes the bare `setup` string from
`command-palette.tsx:285`, which was the one human-facing unqualified spelling I flagged in R2.10d.

**The five round-2 required changes — one applied, four not.**

| # | Required in round 2 | State in revision 3 |
| --- | --- | --- |
| 1 | U-D2's second form **required**, and the two arity evasions named | ❌ **Not applied.** Still "**Optional** second" (`:763`) and §Known limitations still says "the optional second form covers it if review wants belt and braces" (`:1001-1003`). `(params = {}) => …` and `(...args) => …` both yield `.length === 0` and are still unnamed. §4's sole funding still has two one-token bypasses |
| 2 | `MUTATING_INVOCATIONS` is **five** needles; `'--fix'` and `'audit --fix'` must survive | ❌ **Not applied.** `:729-731` still says it "today lists `'infra-kit init'`, `'setup-dependency'` and `'setup-dependency-update'`; **those become** …" — three of five, phrased as a replacement. Verified at `manifest.test.mjs:479-485`: the list is `['--fix', 'infra-kit init', 'audit --fix', 'setup-dependency', 'setup-dependency-update']`. As written, an implementer drops `'--fix'` and `'audit --fix'`, un-fencing `doctor --fix` and `audit --fix` for every future skill |
| 3 | U-C3's description: strip is `:42`, and `:55-59` **asserts** rather than mutates | ❌ **Not applied.** `:758` still says "strips … `:51`; **adds the name to the low-risk allowlist**, `:55`". The file performs **one** mutation. The claim inflates coverage that does not exist |
| 4 | `DOCTOR_CHECK_NAMES` is derived, not an edit site | ❌ **Not applied.** §4 `:540-541` and Phase 4 `:861` both still name it. `report.ts:113` is `SECTION_MEMBERS.flatMap(([, names]) => names)` — one edit site |
| 5 | Two wording precisions | ✅ **Applied.** "no new side effect" is gone, and Scenario 4 now correctly quotes `manifest.test.mjs:472-474` as the comment's own words rather than claiming CI asserts it |

---

## R3.6 — Internal contradictions: revision 3 is a partial edit, and the ADR is the worst of them

These are not nits. A ralph run reads the ADR.

1. **The ADR states the opposite of the decision** (`:905-910`): *"a `setup` … whose **flagless** form is
   additive-only"* and *"The plugin gets a `setup` **skill** … **fencing the flagless form**."* Both are
   revision 2's design and both are false under B, contradicting §1, §2, §5 and Scenario 4. The ADR is
   the section a future reader and an executing agent trust most. **Fix first.**
2. **§Option A's own description is still revision 2** (`:124-130`): *"flagless = init writes + read-only
   dependency report"*, *"`init` survives as a … alias for **flagless `setup`**"*, *"the `setup` skill
   fences the flagless form only."* Three statements, all now false. Its **Pros** paragraph (`:132-137`)
   likewise still argues from the flagless/`--tools` split.
3. **§2 contradicts itself about the flag surface.** `:400-412` gives the four-flag table including
   `--skip-tools`; `:462-463` then says *"**Flag surface.** `--tools [ids...]`, `--update [ids...]`. **No
   others.**"* — omitting the linchpin flag. Delete the stale duplicate.
4. **§1's "Why an alias" still says "hulyo and travelist"** (`:255-256`) while the section's own evidence
   table lists four repos and the *stale* one is starter-workspace.
5. Test-plan header says *"Revision-2 changes are marked (rev2)"* while (rev3) marks exist. Trivial, but
   it is the sort of drift a reader uses to gauge whether the rest was swept.

---

## R3.7 — Consumer evidence: verified, and the plan is under-selling it

Spot-checked starter-workspace as asked. **All four claimed drifts confirmed**, and there is a fifth,
better one the plan does not cite:

- `/Users/arthur/projects/starter-workspace/CLAUDE.md:63` carries **`<!-- infra-kit:version 0.3.14 -->`** —
  a machine-readable generation stamp, against a published CLI at **0.4.0**.
- `:68` — `edit text *outside* the markers` (vs `_outside_` elsewhere) ✓
- `:78` — `ik init — (re)install shell integration and regenerate these agent-instruction files` ✓ older wording
- `grep -c "audit --fix"` → **0** ✓
- `grep -c "release remove"` → **0** ✓

**Cite the version marker.** "This block says it was generated by 0.3.14; the published CLI is 0.4.0" is
one line and is stronger evidence than enumerating four drifts, because it is the artifact's own
self-report and cannot be argued with. §1's premise is not merely supported — it is stamped.

---

## R3.8 — Still missing: §Naming and disambiguation (R2.10d / R2.12 item 4)

Not addressed anywhere in revision 3. Under B it matters **more**, not less, because the wrong command now
points at an installer. Restating the measured facts so they are not lost:

- **Five repos**, not four, ship `"setup": "pnpm run runtime-set-node && pnpm install"` — including
  `/package.json` in this repo.
- `pnpm setup` is a pnpm builtin.
- So "run setup" has three readings; two succeed while doing something else; and under B the person who
  *meant* `pnpm run setup` and typed `infra-kit setup` gets five package installs.
- The mitigation is well-founded — `ik` and `infra-kit` are **real bins, not aliases** (`init.ts:469`), so
  a qualified form cannot be shadowed by a package script.

`menuGroup: null` incidentally removed the palette's bare `setup` (R3.5). **The remaining unqualified
site is the one the plan creates on purpose**: the skill's prose naming the installing form. The plan
specifies *that* there will be prose and never specifies the words. If the command synthesis (R3.4) is
adopted this disappears entirely; if the skill is kept, **the sentence must be in the plan and pinned**,
because prose is the only part of this design no test can reach.

---

## R3.9 — Required changes

1. **Rewrite the ADR and §Option A to describe B** — flagless installs; the alias maps to `--skip-tools`;
   the plugin grants only `--skip-tools`; `menuGroup: null`. And delete §2's stale second "Flag surface"
   line that omits `--skip-tools` (R3.6).
2. **Apply the four unapplied round-2 changes** — U-D2's second form becomes **required** with the two
   arity evasions named; `MUTATING_INVOCATIONS` corrected to five needles with `'--fix'` / `'audit --fix'`
   retained; U-C3's `:42` / `:55-59` description fixed; `DOCTOR_CHECK_NAMES` dropped as an edit site
   (R3.5).
3. **Fix Scenario 4's safety sentence** — `_meta` is not on the Bash path it describes; the real answer is
   that in `bypassPermissions` the ambient risk dominates and infra-kit adds no marginal exposure, and a
   CLI-side confirm is contraindicated by the `confirmOrExit`-skips-`finally` hazard (R3.3).
4. **Rewrite the command-vs-skill rejection** — `manifest.test.mjs:609-611` says T1's scope exists
   *precisely to let a command name an MCP tool*; "prose is the only spelling" is false at source. Then
   decide, with the sibling plan's owner looped in (R3.4).
5. **Add §Naming and disambiguation**, and — if the skill is kept — put the actual prose sentence in the
   plan (R3.8). Plus three cheap refinements to I-10: fixture under `FIXTURES_DIR`, cite the prefix
   precedent with its inverted polarity, and note the formatter caution on whole-line matching (R3.2).

---

# Round 4 — final architect pass on revision 4 (2026-09-10)

**All line numbers below were read this pass** against the live 1224-line file. Round-3's stale citations
are withdrawn; where the lead's re-verification showed a finding already fixed, it is not repeated.

**Verdict: REVISE.** The design is settled and I have no architectural objection left — the command shape,
`init`-preserved-not-aliased, `menuGroup: null`, and the Scenario 4 axis correction are all right, and the
Phase 6 → 7 resource ordering is correctly sequenced. But **the plan's flagship test names a seam that
cannot observe the write it asserts about**, and it would ship green — the exact defect class Principle 6
forbids, on the one test that funds §4. That plus four literal-execution defects must land before code.
None is a design change; all are text or test-target fixes.

---

## R4.1 — FALSE AT SOURCE: U-D2(b) mocks a module the write does not go through

**This is the finding of the round.** `U-D2(b)` (`:901`) and §5a (`:985-987`) both specify:

> *"(b) `vi.mock('src/lib/env-tokens', …)`, call the registered handler with `{fix:true, confirmedCommand:true}`,
> assert zero write calls … it uses a boundary **demonstrated to work** in this repo:
> `doctor-corrupt-token-store.test.ts:12-34` mocks `src/lib/env-tokens` and the interception holds."*

Read at source this pass:

- `doctor.ts:571` — `const chmodPath = deps.chmodPath ?? fs.chmodSync`. The `--fix` write is
  **`fs.chmodSync`**, off the `node:fs` default import.
- `src/lib/env-tokens/index.ts:1` exports exactly
  `getTokenStorePath, readTokenStore, removeToken, setToken, writeTokenStore` — **no chmod, and nothing
  else on the `--fix` write path.**

So mocking `src/lib/env-tokens` intercepts the path *resolution* and never the chmod. A test written
literally to U-D2(b) asserts "zero write calls" on a mock that records **zero calls whether or not the
mutation is present**. It is buildable, it goes green, and it is **vacuous on the exact mutation it
targets** — which is worse than revision 1's U-D2, because that one at least failed loudly. And U-D2 is
the *sole* payment for removing `doctor` from the P1 gate's population, so §4 would ship unfunded for the
third revision running.

The cited demonstration is real but proves the wrong thing: `doctor-corrupt-token-store.test.ts` mocks
`env-tokens` to intercept **reads** (`readTokenStore`, `getTokenStorePath`). U-D2(b) needs to observe a
**write**.

**Two mechanisms that do bite, both available:**

1. **`vi.spyOn(fs, 'chmodSync')`.** `doctor.ts` uses a *default* import (`fs.chmodSync`), so the spy lands
   on the namespace object's method and the internal call sees it. This is the documented exception to the
   repo's own "`vi.spyOn` cannot intercept named `fs` imports" lesson — the lesson is about
   `import { writeFile }`; a default import is exactly the shape that *is* interceptable.
2. **Real-filesystem assertion.** With `HOME` pointed at a temp dir, create a store at `0644`, call the
   registered handler with `{fix:true}`, assert the mode is **still `0644`**. No mocking, and it asserts
   the machine effect rather than a call count.

Note the DI seam (`deps.chmodPath`, `doctor.ts:567`) is **not** usable here: `doctor()` calls
`checkTokenStorePerms(options.fix ?? false)` at `:1451` with no `deps`, so nothing reachable from
`doctorMcpTool.handler` can inject it. Say that too, or the next reader will try it.

---

## R4.2 — `init` and `setup --skip-tools` are behaviourally identical, but I-3 and U-S5 pin them apart

The plan's own text makes them the same operation:

- `:362-364` — `init` does "the additive writes of `init.ts:53-127`, and nothing else that writes. It
  **additionally probes and reports** — five `--version` spawns, read-only."
- `:507` — `--skip-tools` is a "**read-only probe** — report what is missing and the argv that would fix
  it, install nothing", on top of §2 step 1's init half.
- `:514-516` states the equivalence outright: *"`init` is removed at 0.6.0, and without `--skip-tools` that
  removal **deletes a capability rather than renaming one**."* That argument only works if they are the
  same capability.

But the tests pin an **implementation** distinction:

- `I-3` (`:918`) — `init` "runs the **preserved init path** (not `setup`)".
- `U-S5` (`:908`) — the mutation is "`program.ts` wiring `init`'s action to `setup()` **instead of the
  preserved init path**".

An agent following this literally hits a fork with no good branch: share one implementation
(`runSetup({ skipTools: true })`, the obviously correct design) and I-3 fails on its face; or write a
second copy of the procedure to satisfy I-3, which duplicates a list the plan owns — Principle 4 — and
guarantees `init` and `--skip-tools` drift.

**Fix:** state that `init` and `setup --skip-tools` share one implementation and differ only in the
deprecation notice, and restate I-3's assertion **behaviourally** — `init` never reaches
`lib/dependency-install` — which is precisely what U-S5 already asserts and is the property that actually
matters. The "preserved, not aliased" framing survives intact as a statement about *contract*; it should
stop being a statement about *call graph*.

---

## R4.3 — Phase coverage holes: two tests land in no phase, one lands in the wrong one

Checked every phase's accept list against every test id.

- **U-S7 is in no phase.** Phase 2 accepts "U-S1..U-S6" (`:1004`); U-S7 is numbered **above** U-S6 in the
  table (the order is U-S5, U-S7, U-S6 at `:908-910`), so the range excludes it. No other phase names it
  (Phase 3 `:1009`, Phase 4 `:1016`, Phase 5 `:1021`, Phase 7 `:1038`). **`--skip-tools` — the flag §1's
  deprecation message points at and the only successor to `init`'s contract — has exactly one test, and it
  is unassigned.** Phase 2's work list (`:1003-1004`) also omits `--skip-tools`, naming only
  "`--tools` / `--update`", so the flag is never assigned to a phase at all.
- **U-S5 is in the wrong phase.** It asserts `infra-kit init` makes zero calls into `lib/dependency-install`
  — but `init` is not re-registered until **Phase 3** (`:1007-1008`). It cannot pass at the end of Phase 2,
  where Phase 2's criterion places it. Move it to Phase 3 beside I-3, which catches the same mutation
  structurally.
- **Phase 1's criterion is unsatisfiable as written.** `:999` requires "`pnpm run qa` green", while
  §Preconditions `:1176-1177` records that `vendor check` **runs first in root qa and is already red on
  HEAD**. An implementer either stalls or — much worse — "fixes" `vendor/`, which this repo has recorded
  as the thing that kills the whole gate. Restate as "green except the pre-existing `vendor check` red",
  or name the narrower command actually expected to pass.
- **Per-phase vs per-commit greenness is never stated.** Phases 2–5 are all inside Commit B, and the tree
  is legitimately red between them — e.g. Phase 3 renames the catalog entry to `setup` while
  `REQUIRES_INTERACTION_TOOLS` (`mcp-stdio.e2e.test.ts:258`) is not repinned until Phase 4's E-1. Phase 1's
  "qa green" criterion implies per-phase greenness is the norm, so an agent will stop at the end of Phase
  3. One sentence fixes it: the suite is expected green at **commit** boundaries, not phase boundaries.

**Everything else about the ordering is sound**, and one part is notably good: **Phase 6 correctly owes the
served `infra-kit://workflow/setup` resource** (`:1026-1029`), before Phase 7 ships the command that the
publish gate would otherwise refuse. That is the dependency the command shape introduced, and the plan
caught it without prompting.

---

## R4.4 — Residual staleness: "alias", and a driver that cites a grant that no longer exists

Smaller than round 3's ADR problem, same class, and load-bearing because the two words imply different
implementations (R4.2).

- `:339` heading — "**Why an alias for `init`.**" — and `:344` "An alias breaks the circularity for about
  eight lines", sitting **eight lines above** `:352`, which reads "**`init` is preserved, not aliased — and
  the plan should stop calling it an alias.**"
- `:600` (§5), `:637` (§6, Commit B contents), `:1137` (ADR **Consequences**), `:1147` (ADR
  **Follow-ups**) all still say "the hidden `init` alias" — the last two inside the ADR whose own clause 4
  (`:1094`) says "preserved, not aliased".
- **ADR Drivers clause 3** (`:1104-1105`): *"Both gates — the P1 catalog gate and **the plugin's standing
  `allowed-tools` grant** — must stay funded."* Under revision 4 there is **no** plugin standing grant; the
  command carries no `allowed-tools` at all, which is the whole point of Scenario 4. The same stale driver
  appears in the RALPLAN-DR summary's driver 3 (`:115-118` region). Both should read: the P1 gate, and the
  publish gate binding the command to a served resource.
- §1's table heading still reads "the four **removed** names" (`:330`) while its first row says `init` is
  preserved.

---

## R4.5 — Test plan, adversarial pass: what bites and what I checked

Beyond R4.1, I re-checked the entries carrying weight.

| # | Bites? | Note |
| --- | --- | --- |
| U-D2(a) | ✅ | `defineMcpTool` is the identity (`types.ts:138-142`, re-read); the two arity bypasses are now named at `:901` and `:1195-1197`. Correct and honest |
| U-D2(b) | ❌ | **R4.1** — wrong seam, vacuous as written |
| U-S5 | ✅ | Real mutation, correct invariant; wrong phase (R4.3) and over-specified as call-graph (R4.2) |
| U-S7 | ✅ | Bites; **unassigned to any phase** (R4.3) |
| U-C3 | ✅ | Reason now corrected to `:42` strip / `:55-59` assertion — my round-2 finding applied accurately |
| I-3 | ⚠️ | Bites on the dangerous mutation, but its "not `setup`" clause is the R4.2 fork |
| I-5 / I-6 / I-7 / I-9 | ✅ | I-9 is now a restatement of an **existing** guard (U14's `deepEqual` on `COMMAND_FRONTMATTER_KEYS`, `manifest.test.mjs:617`) rather than new machinery. **Verified: a command cannot carry `allowed-tools`** — the standing-grant problem is deleted by a test that already ships, which is the strongest structural move in the plan |
| I-10 | ✅ | With the permitted map at `{}`, the whole-line/needle trap is **dissolved rather than solved** — nothing is ever permitted, so the match style cannot matter. Cleaner than revision 3. Worth one carried-forward line: *if* a permitted entry is ever added, it must match whole fenced lines, because `'infra-kit setup'` ⊂ `'infra-kit setup --skip-tools'` re-permits the denied form |
| I-12 | ✅ | Correctly binds the command to floor + served URI; this is what makes §Landing's ordering a gate rather than a convention |
| I-13 | ✅ | The regex `/(^\|\s)setup\b/` unqualified by `ik `/`infra-kit ` is checkable without judgement |

---

## R4.6 — The two judgement calls the lead asked for

**(a) Is the consumer-settings limitation overstated now that the instance is `deny`? Mildly — and the
plan mostly self-corrects.** The bullet at `:1198-1210` states the correction explicitly, names `deny`,
and narrows the surviving claim to *"consumers demonstrably write their own infra-kit Bash rules, in
spellings (`pnpm exec`, `ik`) that §3's list does not use and Scenario 4 names as unmatched."* That claim
is true and it is the one Scenario 4 needs. What does not survive is the framing: a `deny` instance
proves consumers **author** rules; it does **not** raise the likelihood that a consumer writes an `allow`
rule for `setup`. So the over-permission hazard is real but **unevidenced**, and "This is not
hypothetical" (`:1200-1201`) is doing work the evidence no longer supports. One word — say the
over-permission direction is *unevidenced* — and inspection-not-enforcement remains exactly the right
mitigation. **Follow-up grade, not blocking.**

**(b) Does U14's three-line body make the G-U6 gap tolerable? Yes — and the plan's reason is weaker than
the true one.** `:1211-1214` argues the file is "small enough for that gap to stay tolerable." The
stronger argument is that **U6's subject matter does not exist for commands**: U6 asserts
`allowed-tools` ↔ fenced-corpus equality in both directions, and a command can have no `allowed-tools`
(U14's key-set `deepEqual`). There is no equality to check, so the gap is *inapplicable*, not *uncovered*.
The only residue is a fenced line in a command body with no rule behind it — which is inert, because a
command grants nothing and any Bash the agent then runs prompts normally. Restating it that way turns a
hedge into a proof. **Follow-up grade.**

---

## R4.7 — Verdict

**REVISE.** Must land before code:

1. **U-D2(b) targets the wrong module and is vacuous** — the `--fix` write is `fs.chmodSync`
   (`doctor.ts:571`), and `src/lib/env-tokens/index.ts:1` exports no chmod. Use `vi.spyOn(fs, 'chmodSync')`
   on the default import, or a real-FS mode assertion; note that `deps.chmodPath` is unreachable from the
   handler (R4.1).
2. **Delete §2's stale second "Flag surface" at `:568`** — *"`--tools [ids...]`, `--update [ids...]`. No
   others."* — which contradicts the four-row table at `:500-507` and omits `--skip-tools` entirely.
3. **Reconcile `init` with `setup --skip-tools`** — they are the same operation by the plan's own text, so
   say they share one implementation and restate I-3 behaviourally ("never reaches
   `lib/dependency-install`") instead of "not `setup`" (R4.2).
4. **Fix phase coverage** — assign U-S7 (and `--skip-tools` itself) to Phase 2; move U-S5 to Phase 3 where
   `init` is actually wired; state that the suite is green at **commit** boundaries, not phase boundaries
   (R4.3).
5. **Phase 1's "`pnpm run qa` green" is unsatisfiable** — `vendor check` runs first and is already red on
   HEAD, as §Preconditions itself records. Restate the criterion (R4.3).
6. **Finish the "alias" → "preserved" sweep** (`:330`, `:339`, `:344`, `:600`, `:637`, `:1137`, `:1147`)
   and fix ADR Drivers clause 3 + RALPLAN-DR driver 3, which still cite a plugin standing grant that the
   command shape deleted (R4.4).

**Follow-ups, explicitly not blocking:** the `deny`-vs-`allow` wording in §Known limitations (R4.6a); the
stronger G-U6 argument (R4.6b); the carried-forward whole-line note on I-10 should a permitted entry ever
be added (R4.5).

**Are the phases executable as written? Almost — items 4 and 5 are the two that would actually stop an
agent**, and item 3 is the one that would make it build the wrong thing while passing review. The
commit decomposition (A: libs, B: CLI surface + resource + publish, C: plugin command) is sound, the
Phase 6 → 7 resource ordering is correct, and every acceptance criterion except Phase 1's is checkable
without judgement. Fix those five and the plan is executable literally, which is the standard that
matters given what happens next.

---

# Round 5 — scoped pass on revision 6 deltas (2026-09-10)

Narrow by instruction: only the three deltas and what they touch. Line numbers read this pass against the
live file. **Verdict: APPROVE-FOR-CRITIC** — zero must-fix. Three follow-ups for §Cut/deferred.

## R5.1 — Delta 2: U-D2(b) bites, for the first time in four specifications

Attacked on all four axes the lead named; it survives all four.

- **Collision — impossible, not merely unlikely.** `chmodSync` has **exactly one call site in the whole
  file**: `doctor.ts:619` (`chmodPath(entry.target, entry.expected)`) resolving through `:571`
  (`deps.chmodPath ?? fs.chmodSync`). Nothing else in a full `doctor()` run chmods anything, so
  path-matching is strictly stronger than it needs to be and call-count matching would also have worked.
- **`loose.length === 4` — confirmed by arithmetic.** `TOKEN_FILE_MODE = 0o600`, `TOKEN_DIR_MODE = 0o700`
  (`:274-275`); the audit list (`:589-593`) is `[userConfigDir, projectsDir, projectDir, target]`, i.e.
  three `dirname` walks up plus the file. Against `0755` dirs and a `0644` file all four differ, all four
  are non-null, so `:601`'s early return is bypassed and the fix loop at `:617-619` emits four calls.
- **Tmpdir modes are irrelevant.** `<tmp>` itself is **never audited** — only `.infra-kit`, `projects`,
  `api` and the file. The lead's fourth worry does not arise.
- **The mock boundary reaches `getTokenStorePath` end-to-end.** `doctor.ts:38` is
  `import { getTokenStorePath, readTokenStore } from 'src/lib/env-tokens'` — a named import from a
  first-party module, so `vi.mock` replaces what that binding resolves to. Entry point is irrelevant:
  `doctor()` and `checkTokenStorePerms` read the same binding.
- **The two-direction, path-matching design is what finally funds §4.** Assertion 1 is the positive
  control that was missing from all three prior specs — it proves the fixture actually reaches the write,
  so assertion 2's silence is evidence rather than an artifact of a fixture that never triggered. The
  mutation analysis is correct: `handler: (params) => doctor(params)` makes assertion 2 observe assertion
  1's four calls, and both arity bypasses red it identically because (b) never inspects the signature.

**One thing to state in the plan (loud failure, so not a blocker):** the mock factory must supply
**`readTokenStore` as well as `getTokenStorePath`**. `doctor.ts:38` imports both, and
`checkTokenStorePresent` / `checkEnvTokensConfigured` / `checkEnvTokenValid` all call `readTokenStore`
during the same run — a factory supplying only the path resolver throws mid-run.
`doctor-corrupt-token-store.test.ts:12-21` supplies both for exactly this reason, and partially mocks
`src/integrations/doppler` with `importOriginal` for the same class of problem. One sentence prevents a
fourth U-D2 round.

## R5.2 — Delta 3: all four spot-checked, and the `body.md` decision is the best of them

- **`mcp-stdio.e2e.test.ts:253`** reads `expect(actual).not.toContain('doctor')`. Inversion is right and
  deletion would have been wrong — it is the drift guard, and `:254`'s `expect(actual.size)
  .toBeGreaterThan(20)` still holds after the net catalog change.
- **I-12** — `scripts/check-workflow-resource-published.mjs` exists at that path; retargeting the test at
  the script rather than restating its logic avoids a second copy of a gate this plan does not own.
- **Phase 5's absolute `dist/cli.js` with `pnpm exec` excluded by name** matches two recorded repo
  lessons at once (consumer repos run the global binary; `pnpm exec` sets `npm_command`). Correct.
- **§0 rule 1's `body.md` strings — right, and right for the stated reason.** `:4` →
  `` `ik audit --fix --root` `` (regeneration), `:15` → `` `ik setup` `` with the installs named
  explicitly. Neither string claims the other's job, so no consumer's block tells an agent that
  refreshing documentation runs a package installer. This is the one Phase-5 decision that prints into
  four repos and cannot be taken back, and the split is the correct resolution.

## R5.3 — The `release-create` gate: a real benefit, at no added dependency

Verified: `apps/infra-kit/cli/resources/workflow/release-create.md` exists and is **clean in git** —
tracked, unmodified, already on main. `commands/release-create.md:8` floors at `0.5.0` against a
published `0.4.0`, so `check-workflow-resource-published.mjs`'s first assertion is red today. Publishing
`0.5.0` at Phase 6 discharges it, and the script's second assertion (the published build answers
`resources/list` with the URI) is satisfied by code already on main. **Phase 6 acquires no dependency on
in-flight work.** Worth stating in the plan as an incidental benefit.

## R5.4 — Delta 1: 0.7.0 is arithmetically tight and measured on the wrong clock

The sweep is complete — the only surviving `0.6.0` mentions (`:25-26`, `:1239-1240`) are the passages
describing the move.

**Two problems, neither blocking.** First, arithmetic: the observed drift is **exactly two minors**
(`starter-workspace` at `0.3.14` against a published `0.4.0`), and the window is set at exactly two
minors (0.5.0 → 0.7.0). Zero margin against the single data point that motivated the change.

Second, and more interesting: **the two clocks are not coupled.** A version window is measured in CLI
releases; the thing that goes stale is the *committed block*, which advances only when someone runs
`init` / `audit --fix` **in that repo**. starter-workspace's block sits at 0.3.14 not because it is "two
versions behind" but because nobody has run the regenerating command there since 0.3.14 — and nothing in
0.5.0 or 0.6.0 makes them more likely to. So `:1243`'s *"the smallest window the observed drift
justifies"* overstates what the number can do: **any** version number is a guess about someone else's
behaviour in a repo this plan cannot write to.

**The marker-gated condition is better in kind and, uniquely here, feasible** — because the consumer set
is *closed*: four repos, all readable, and §Landing step 3 already sweeps all four and reads `CLAUDE.md`.
The plan already cites the marker at `CLAUDE.md:63` / `:177` / `:266` / `:18`. So state the removal
condition as a measurement using machinery that already exists: **remove `init` in the first minor at or
after 0.7.0 *and* not until a sweep shows every consumer block's `infra-kit:version` marker reading
≥ 0.5.0.** Keep 0.7.0 as the floor; add the marker as the gate. One sentence, in §Follow-ups where
*"Removing `init` at 0.7.0"* (`:1364`) already sits.

Honest caveat to record with it: the closed-set assumption is what makes this feasible. If infra-kit ever
gains a consumer outside these four, the sweep is no longer complete and the version number is the only
remaining instrument.

**Not a must-fix:** the removal happens in a future release, outside this plan's seven phases, so nothing
about it blocks code.

## R5.5 — Round-4's six blockers: all landed, two better than specified

Confirmed at source: U-D2(b) retargeted (R5.1); §2's duplicate "Flag surface" gone (only `:588` survives);
`init` / `--skip-tools` reconciled **behaviourally** — I-3 (`:1006`) now asserts "installs nothing when
run" and names the discarded implementation-distinction explicitly, and U-S7 (`:997`) states that U-S5 and
U-S7 are "deliberately the same assertion over two entry points — that is what lets one implementation
serve both", which is exactly the resolution; Phase 2 enumerates **"U-S1, U-S2, U-S3, U-S4, U-S6 and
U-S7"** rather than a range, *with the reason stated* ("U-S7 sorts above U-S6 and a range silently
excludes it"), and U-S5 moves to Phase 3 beside I-3; Phase 1 drops `pnpm run qa`, names the known-red
`vendor check` and excludes it by name, and substitutes three narrow commands including
`eslint … --no-cache`; and the stale ADR/RALPLAN driver citing a plugin standing grant is gone (`grep`
for it returns nothing). U-S7 also folds in the round-4 checked negative that `allowUnknownOption` appears
nowhere, so misspellings error rather than install.

## R5.6 — Verdict

**APPROVE-FOR-CRITIC.** No must-fix items.

**Follow-ups for §Cut/deferred (none blocking):**
1. Add the marker-gated condition beside the 0.7.0 floor in §Follow-ups (R5.4).
2. State that U-D2(b)'s mock factory must supply `readTokenStore` alongside `getTokenStorePath` (R5.1).
3. `:1244-1245` reads *"This changes the `0.7.0` figure used in earlier revisions"* — earlier revisions
   used **0.6.0**; the sentence names the new figure where it means the old one, which makes the one
   sentence explaining the change say nothing.
