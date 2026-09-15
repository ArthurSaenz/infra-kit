> Status: critic review — advisory, not authorization.

# Critic review — SetupDependency plan (as revised by the Architect)

Read-only pass over `docs/archive/mcp/mcp-setup-dependency-plan.md` and
`docs/reviews/setup-dependency-architect-review.md`. Nothing outside this file was edited. Every
in-repo claim below was re-derived from the working tree at `/Users/arthur/projects/infra-kit`
(branch `main`, dirty) — I took nothing from either document on trust. CLI paths are relative to
`apps/infra-kit/cli` unless they begin with `plugins/`, `docs/` or `.claude/`.

The brief for this pass is: judge whether a plan incorporating F1–F7 and V1–V5 would be sound. It
would not be — not because those findings are wrong (I confirmed all seven) but because the
Architect's revision leaves the plan's **factual premise** (P2) unexamined, and P2 is false. Four
further defects are load-bearing and appear in neither document.

---

## 0. Independent verification of the Architect's findings

I re-checked all seven. Summary before the detail, so the Planner knows what is settled:

| Finding | My verdict | New evidence I add |
|---|---|---|
| F1 — `allowed-tools` is a grant | **CONFIRMED, and understated** | The repo asserts it in its own CI test — see C1 |
| F2 — TTY guard inert in agent contexts | **CONFIRMED, and wrong in the other direction too** | See C2 |
| F3 — `install-manager` helpers are module-private | **CONFIRMED** | `install-manager/index.ts` exports exactly 4 symbols |
| F4 — one `packageName` conflates five names | **CONFIRMED** | — |
| F5 — PM-3's invariant is weaker than the existing test | **CONFIRMED** | `command-catalog.test.ts:86-87` |
| F6 — `doctor` probes four, and brew zero | **CONFIRMED** | — |
| F7 — `CI=1` defeats the TTY guard for brew | **CONFIRMED** | Compounds with C2 |

And the orchestrator's ground truth, verified: `.claude/hooks/hooklib.mjs:50-53` — `block(message)`
writes to stderr and `process.exit(2)`. Exit 2 blocks; exit 1 does not (`bash-launcher.mjs:1-3`
exists precisely because of that asymmetry). **A hook block denies the agent. It does not ask a
human.** Nobody is prompted.

### The `permissions.ask` question — VERIFIED, and it is the one channel that survives bypass

The brief asked me to check whether `permissions.ask` genuinely prompts and survives
`bypassPermissions`. It does, and this is now sourced:

- **It prompts.** An `ask` rule causes Claude Code to *"prompt for confirmation whenever Claude Code
  tries to use the specified tool"* — `https://code.claude.com/docs/en/permissions.md`.
- **It survives `bypassPermissions`.** Ask rules are listed under *"Actions no mode auto-approves"*,
  with the explicit statement that *"Claude Code doesn't auto-approve the following in any mode,
  including `bypassPermissions`"* — `https://code.claude.com/docs/en/permission-modes.md`.

Unlike the third-party report the brief flagged, this is a `permissions` **rule**, not a hook schema,
so it does not depend on any of that report's unverified mechanics. It is a scoped pattern
(`Bash(infra-kit setup-deps-install:*)`) in the same `permissions` block this repo already uses for
`deny`.

**Two things it does NOT settle, both of which the plan must carry as gaps rather than assume away:**

- **Hook `permissionDecision: "ask"` is UNDOCUMENTED.** The official hook output format shows
  `"deny"`; no `"ask"` value appears. Do not build on it.
- **Hook-based `deny` under `bypassPermissions` is UNDOCUMENTED.** The docs state that deny **rules**
  hold in every mode including `bypassPermissions`; they say nothing about whether a PreToolUse
  hook's `deny` decision is honoured the same way. **That means `block-deploy.mjs:3` —
  *"Denies via permissionDecision JSON, which holds under bypassPermissions"* — is an in-repo
  assertion past the documented surface.** It may well be true; it is not citable. The Architect's
  §3a leans on that sentence as the deciding property of its recommended layer, and the plan must not
  inherit the claim without the caveat. Nor is exit-2 blocking under `bypassPermissions` documented.

`.claude/settings.json` today carries only `permissions.deny` (six entries) plus the `PreToolUse` hook
chain. There is no `ask` rule anywhere in this repo yet — but adding one is a documented mechanism,
which is more than can be said for the layer the Architect recommended.

---

## 1. Principle–option consistency (V1–V3 confirmed or refuted independently)

### V1 — CONFIRMED, and the Architect underclaimed it

P1: *"Execution authority comes from a human… Anything that mutates the host needs a channel where a
person sees the argv."* Phase 3 implements P1 with an `allowed-tools` narrowing, which is a grant
that **suppresses** that prompt. The Architect proved this from Anthropic's documentation.

**It is also proved inside this repository, by a test that runs in CI.**
`plugins/infra-kit/__tests__/manifest.test.mjs:472-474`:

> *"Verbs that change the machine. The doctor skill may name these in prose, never in a fence: a
> fenced line obliges an allowed-tools rule (clause 2), and **a rule is a standing grant that runs
> without a prompt.** Keeping them unfenced is what keeps the grant out of the plugin."*

`MUTATING_INVOCATIONS = ['--fix', 'infra-kit init', 'audit --fix']`, asserted by test **U15** at
`:477-486` with the failure message *"a mutating command inside a fence would be granted without a
prompt"*. U6 (`:400`) enforces the converse: every fenced command **obliges** an `allowed-tools` rule.

So Phase 3 as written is not merely mistaken about Claude Code semantics — it **inverts a tested
authoring contract of the very plugin it proposes to extend**. A `SKILL.md` fencing
`infra-kit setup-deps-install brew` would be obliged by U6 to carry a grant, and that grant is what
U15 exists to keep out. The correct plugin-side change is the opposite of Phase 3: add
`setup-deps-install` / `setup-deps-update` to `MUTATING_INVOCATIONS`.

This also settles V4 (the plan's uneven verification standard) more sharply than the Architect put
it: the refutation was not merely "cheaply checkable in the docs" — it was **already written down,
one directory away from the file the plan cited as its precedent.**

### V2 — CONFIRMED, with one budget item neither document names

`command-catalog.test.ts:148-167` asserts, for `self-update` and `mcp`: `mcpTool` null, `mcpExposed`
false, **`menuGroup` null**, and absence from `allMenuPaths()`. `run-session.ts:199` spawns
`[deps.cliPath, ...command.groupPath]` with `stdio: 'inherit'` and **zero flags** — verified.
§3.5 adopts `mcpTool: null` while rejecting `menuGroup: null`, citing the same comment for the first
half and ignoring the second. V2 holds.

§3.5's own defence is self-defeating exactly as the Architect says, and there is a third reason
`menuGroup: 'setup'` is expensive: the no-arg multi-select picker it depends on must be wrapped in
`withEscape`, or `src/lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts` reddens. That
test is a structural AST sweep (*"every CALL to an `@inquirer/*` PROMPT must sit lexically inside a
`withEscape(...)` callback"*), it is all-or-none by design, and it has already caught
`worktrees-add.ts` wrapping two prompts and calling a third raw. The plan budgets nothing for it.

### V3 — CONFIRMED, and the Architect's fix is right

P5 demands one list of probe argv; Phase 4 defers it on a `SECTION_MEMBERS` rename risk that §3.4's
own design nullifies (`doctor` keeps its check **names**; only the argv move). `report.ts:60-119`
confirms the shape: `SECTION_MEMBERS`, `DOCTOR_CHECK_NAMES` derived from it at `:109`, `FIXABLE_NAMES`
at `:119`. Substituting argv inside `doctor.ts:1385-1420` touches none of them. The deferral has no
cost basis. Fold Phase 4 into Phase 1.

### V6 — NEW, and it is the plan's most serious defect. P2 is factually false.

P2 states: *"Read-only detection is a different risk class from execution, **and the catalog already
says so**. `audit`, `version`, `dev-status`, `env-status` are exposed; **every `mutating: true`
host-shaping command is not.**"*

That second clause is the entire evidentiary basis for choosing the verb axis, and it is wrong.
`command-catalog.test.ts:39-63` lists the 23 exposed tools. **Thirteen of them are mutating**, and
three are decisive:

1. **`worktrees-add` is exposed, mutating, and UNGATED** — it is a `LOW_RISK_MUTATING_ALLOWLIST`
   member (`command-catalog.ts:550-560`), so `requiresHumanConfirm` is unset and there is **no
   confirm gate at all**. Its own description (`worktrees-add.ts:375`) says it will *"run `pnpm
   install` in each"*, and `worktrees-add.ts:331` is `await $({ cwd: worktreePath })`pnpm install``.
   **An agent can today, over MCP, with zero confirmation, cause this host to execute arbitrary
   package lifecycle scripts.** That is a strictly larger and less bounded capability than
   `brew install gh`.
2. **`local-deploy-all` and `local-deploy-selected` are exposed** — deploys driven from the
   developer's own machine.
3. **`worktrees-remove` is exposed and deletes gitignored files**, with the reasoning stated in the
   test itself (`command-catalog.test.ts:115-118`): exposure is justified by *"the tool's own
   invariants"*, not by the verb.

So the catalog does **not** draw its line on the verb. It draws it on **bounded blast radius**, and
it says so in prose the plan never quotes. The Architect reached the same conclusion from
`worktrees-remove` alone (antithesis (b)); `worktrees-add`'s ungated `pnpm install` makes it
unarguable.

**Consequence for the plan's structure, not just its option choice.** P2 is not decoration — it is
the premise from which §1's option table, the ADR's "Why chosen", and Q2's framing all descend. A
revision that keeps P2 and merely bolts on the Architect's layers is incoherent. **P2 must be
rewritten to state the real rule the catalog follows** — *exposure is bounded by a tool's own
invariants, not by whether it mutates* — and every downstream conclusion re-derived from it.

### Not violated

P4 (*a guessed install is worse than a printed one*) is threaded correctly throughout, and §3.1's
`unknown → print only` row is the right expression of it. But see §3: it is untested, which is how
P4 quietly degrades to advice.

---

## 2. Fair treatment of alternatives — D on evidence, E on taste

**Option D was invalidated on evidence, and the evidence holds.** `tool-handler.ts:315-348`
falls through to `buildConfirmGate` when the provider rejects, outruns `formDeadlineMs`, resolves
`null`, or hands `elicit()` an inexpressible shape, *"with today's behaviour and no thrown error."*
`resolveGateState:113-126` requires `canForm ∧ hasProvider ∧ formable`. Finding D is correct and
Option D is properly dead. This is the plan at its best.

**Option E was invalidated on taste.** §1's rejection is two sentences of precedent-counting: *"It is
strictly more host-mutating than `doctor --fix` and the same class as `self-update`… Adopting it
means rewriting four comments."* Three problems:

- **The count is wrong** (V6). The catalog holds nine exposed mutating tools beyond the four
  restrictive ones the plan cites, including one that runs `pnpm install` ungated. Adopting a bounded
  installer would rewrite **zero** comments: `self-update` stays barred because it mutates the running
  CLI, `env-token-*` because credentials are a different class, `doctor --fix` because it is
  host-inspecting, `release-deliver` because prod is irreversible. None of those reasons reach
  `brew install gh`.
- **"Same class as `self-update`" is asserted, not argued.** `self-update`'s comment bars *"an
  agent-triggered unattended global package install"* of **itself** — a CLI rewriting its own binary
  mid-run. `npm install -g portless` is not that. The plan treats a surface similarity as an identity.
- **The strongest argument for E is answered nowhere.** The Architect's (c): the agent already holds
  `Bash`. Barring the MCP tool does not remove the capability, it removes the **audited** path — the
  pinned argv from a reviewed table, `cwd: homedir()`, `packageManagerInstallEnv`, refusal on
  `unknown`, refusal on manager mismatch, structured logging. Refusing exposure pushes the agent to
  raw `curl … | bash` with none of those. This argument appears in neither §1, nor the pre-mortem,
  nor the ADR's alternatives. A plan may reject an argument; it may not omit the best one against it.

**Q2 pre-loads the choice.** *"Do you accept execution staying CLI-only, or do you want the precedent
overturned?"* — one branch is the status quo, the other is described as overturning four standing
decisions and *"accepting that the token gate is the only thing between an agent and `curl | bash`"*.
That is not a choice, it is a warning with a checkbox. And its premise is false twice: the precedents
do not say what Q2 says (V6), and the token gate is not the only available control (a computed risk
predicate refuses the dangerous recipes without any gate).

**Re-pose Q2 on the real axis**, as the Architect says — verb versus risk — and state the tradeoff
neutrally on both sides, including (c).

---

## 3. Risk-mitigation clarity — one mitigation is real, two are not

**PM-1 (brew sudo-timestamp lottery) — mitigation BROKEN, by three independent mechanisms.**
The mitigation is *"refuses when `mcpMode.enabled`, and independently refuses when
`process.stdin.isTTY !== true`."* The second predicate fails in both directions:

- **Fails closed where you wanted it open** (F2): agent Bash tools have no TTY, so every
  agent-initiated invocation refuses.
- **Fails OPEN where it matters most — and this repo has already written the trap down.**
  `src/lib/mcp-mode/mcp-mode.ts:6-11`, verbatim: *"This exists because `process.stdin.isTTY` CANNOT
  answer that question: `commands/mcp/mcp.ts` spawns the server with `stdio: 'inherit'`, so a
  terminal-launched `infra-kit mcp` hands the child a real TTY stdin and an isTTY-keyed guard does
  not fire."* `worktrees-add.ts:56-58` repeats the rule as a standing instruction: *"The guard lives
  in `withEscape` keyed on `isMcpMode()`, **never** `process.stdin.isTTY`."*
- **Bypassed entirely on a real TTY** (F7): `CI=1` flips `install.sh` non-interactive regardless.

So §4's headline claim — *"Two independent guards because they fail for different reasons"* — is
false as stated. They are not peers. `isMcpMode()` is sound; `stdin.isTTY` is a heuristic this
codebase has explicitly ruled out for exactly this purpose. **A plan that adds a second
`stdin.isTTY`-keyed guard is re-introducing a documented defect.** Keep a TTY check only as a
*human-presence signal for the CLI path* (§5), never as an MCP guard, and say which is which.

**PM-2 (detection false-positive → split-brain) — mitigation REAL but UNTESTED.**
Per-tool `identify()` with an explicit `unknown` branch, `unknown → print, never execute`, is a
genuine mechanism. §6 tables `identify()` across five tools × four path shapes. But **nothing asserts
that the `unknown` branch refuses to spawn** rather than falling through to a best guess. P4's entire
load sits on that branch. An untested refusal path is how a principle becomes a comment.

**PM-3 (status tool becomes execute tool) — mitigation REAL but WEAKER than what exists.** F5 stands:
`command-catalog.test.ts:86-87` already asserts `toEqual([...EXPECTED_EXPOSED_TOOLS].sort())` plus
`toHaveLength(23)`, which no rename can escape; PM-3's prefix-scoped rule can be escaped by renaming
to `deps-install`. Extend the existing tests.

**PM-4 — MISSING, and it is the one the CLI fallback dies on.**
`confirm-or-exit.ts:5-8`: *"When `confirmedCommand` is truthy (CLI `--yes` **or an MCP call, which
always injects `confirmedCommand: true`**) the prompt is skipped and execution proceeds."*
So `infra-kit setup-deps-install brew --yes` runs with **no prompt at all**, and an agent holding
`Bash` can type that as easily as the bare form. The plan's §4 names `confirmOrExit` as the CLI
confirmation and the Architect's §3e names it as the human channel; neither notices that it is
opt-out by a flag the agent controls. **`setup-deps-install` must not honour `confirmedCommand` for
any recipe classified dangerous** — otherwise the CLI confirmation is agent-satisfiable in exactly the
way the plan (correctly) rejects the confirm token for being.

---

## 4. Acceptance criteria — audited phase by phase

The test: *can it be mechanically checked, and would it fail if the thing it tests were broken?*

| Phase | Criterion | Verdict |
|---|---|---|
| 0 | *"existing `install-manager` and `self-update` tests pass unmodified"* | **Vacuous under the Architect's replacement.** Adding exports to `index.ts` cannot break behaviour, so the criterion cannot fail. It tests nothing. Needs: new table tests exercising the four newly-exported predicates against the F4 name matrix. Under the plan's *original* Phase 0 the criterion is worse than vacuous — F4 shows it would pass while generating `brew upgrade aws` |
| 1 | *"reports all five tools on this host with correct manager attribution"* | **Unfalsifiable and unrunnable in CI.** "Correct" has no independently-known expected value; the host's state is not fixed; CI has no brew. Split into (a) fixture-driven assertions over the §6 tables, and (b) a recorded manual host run captured as evidence, with the expected answer written down *before* the run |
| 1 | *"the MCP tool appears in `tools/list` with `readOnlyHint` true"* | **Sound.** Would fail if broken. Keep. Note `readOnlyHint` is derived from `mutating` (`command-catalog.ts:678-696`), so this also pins the catalog field |
| 1 | (missing) | **Blocked.** `openWorld` is undecidable until `stale`'s source is fixed, and `getExposedMcpTools` **throws at registration** without an `MCP_TOOL_PRESENTATION` row (`command-catalog.ts:678-683`). Neither is budgeted |
| 2 | *"both guards refuse … under `script -q /dev/null`"* | **Mechanically checkable, but it certifies the wrong guard.** Per §3, the TTY guard is unsound for the MCP case and inert for the agent case. Passing this criterion proves a guard that does not cover either real threat is wired |
| 2 | *"at least one real install verified end-to-end on this host"* — target `gh` as *"the cheapest real tool"* | **Un-runnable as written.** `doctor` already probes `gh installed` (`doctor.ts:1385-1420`), so it is presumably present; the step requires uninstalling it first and states no undo |
| 3 | *"a session run shows the host permission prompt naming the exact command"* | **Unpassable** (F1) — the grant is what removes the prompt — and the phase additionally reddens U15/U6 (§1). Delete |
| 4 | *"`SECTION_MEMBERS` and all check names byte-identical to HEAD"* | **Checkable but near-vacuous** — it asserts you did not edit a file you had no reason to edit. It does not test the thing P5 wants. Replace with: the three (four, per F6) probe argv literals appear in exactly one module, asserted structurally |

**Cross-cutting:** the plan has **no per-phase verification steps** — no commands, no expected output,
no "this is what red looks like". Deliberate mode needs them. Add, per phase, the literal
`pnpm --filter … run test <file>` / `pnpm run qa` invocations and the observable that distinguishes
pass from fail.

---

## 5. The question the Architect raised and nobody answered: what IS the human gate?

With the skill lane dead, here is the complete inventory of channels in reach, each with what it
actually does. This is the section the Planner should copy into the plan, because the plan's error was
never a wrong choice among these — it was never enumerating them.

| Channel | Does a human see the argv? | Agent-satisfiable? | Survives `bypassPermissions`? |
|---|---|---|---|
| Confirm token (round 2) | No | **Yes** — token handed to the caller | n/a |
| `formProvider` elicitation | Only where `elicitation.form` is declared | Degrades to the token gate, silently (`tool-handler.ts:315-348`) | n/a |
| `allowed-tools` narrowing | **No — it removes the prompt** | Grant applies to the model | n/a |
| Hook `block()` → exit 2 / `permissionDecision: 'deny'` | **No — it refuses the agent** | No | Claimed yes (`block-deploy.mjs:3`) — **undocumented**; the docs cover deny *rules*, not hook deny decisions |
| **`permissions.ask` rule** | **Yes — it prompts on the matched argv** | No | **YES — documented** (`permission-modes.md`: no mode auto-approves an ask rule, `bypassPermissions` included) |
| `confirmOrExit` in the user's terminal | Yes | **Yes, via `--yes`** (PM-4) unless the flag is refused | Unaffected — it is CLI-side |
| MCP prompt (`/` menu) | Yes, human-initiated by construction (`mcp/prompts/index.ts:6-12`) | **No** — an agent cannot fetch a prompt | n/a; but prior sessions saw resource/prompt tools in only 1 of 4 hosts |
| **Plugin slash command** (`plugins/infra-kit/commands/release-create.md`) | Yes — the human types `/infra-kit:release-create` | **No** | n/a |
| **The host's default Bash permission prompt** | **Yes — it names the exact argv** | No | **No — bypassPermissions is defined by suppressing it** |

Three things fall out, and all three contradict the plan and partly the Architect.

**(1) The human-in-the-loop mechanism the plan wants already exists, and Phase 3 is the only thing
that would destroy it.** An agent proposing `Bash(infra-kit setup-deps-install gh)` with **no**
`allowed-tools` grant and **no** deny rule gets the ordinary permission prompt, which shows the human
the argv and takes their answer. That is precisely P1. The plan invented a channel to obtain a
property it already had, and the invention removed it. **The correct Phase 3 deliverable is a
negative one:** ship no grant for the installer, add `setup-deps-install` / `setup-deps-update` to
`manifest.test.mjs`'s `MUTATING_INVOCATIONS`, and if a skill ships at all, narrow it to
`Bash(infra-kit setup-deps-status)` only.

**(2) The Architect's §3d missed the repo's own production shape for this exact problem.** It
proposes a prompt + resource pair, then correctly caveats that resource tools surfaced in only 1 of 4
host sessions. But `plugins/infra-kit/commands/release-create.md` is a **slash command** — no
`allowed-tools`, human-typed by construction — whose body says *"Read the MCP resource
`infra-kit://workflow/release-create` and follow it exactly"* **and carries an explicit fallback**:
*"If that resource cannot be read — this session may expose no resource tools… call the
`mcp__infra-kit__release-create` tool directly."* That is the delivery-reliability problem already
solved, in production, for the repo's most dangerous existing workflow. A `setup-deps` slash command
is a smaller, better-evidenced Phase 3 than either the SKILL.md or a bare prompt.

**(3) A `permissions.ask` rule is the one channel that both prompts a human and survives
`bypassPermissions`, and it is the layer the Architect's §3a should have recommended instead of a
hook deny.** The Architect chose the hook because it is *"the only mechanism discussed in this review
that survives that mode"* — but that property rests on `block-deploy.mjs:3`, which is undocumented
(§0), and the mechanism it describes **denies the agent rather than asking a human**
(`hooklib.mjs:50-53`, exit 2). An `ask` rule has the documented version of the property the Architect
wanted *and* is an ask rather than a deny. It shares the hook's one real limitation — it lives in
`.claude/` and so does not travel with the binary — and the Architect's §3b analysis of why that is
survivable (a bare machine has no infra-kit either, so a human is unavoidably present at bootstrap)
transfers to it unchanged.

**So: can execution be agent-initiated?** Yes — under normal permission mode, with a real human
prompt, provided you do not grant it away; and **under `bypassPermissions` too, if and only if a
`permissions.ask` rule covers the argv.** Everything else in the table either fails to reach a human
(`deny`, exit 2), is agent-satisfiable (`--yes`, the confirm token), or is undocumented under that
mode. **Rank the controls by what travels with the binary — code-side refusals (`isMcpMode`, the risk
predicate, `unknown → print`) first, then the `ask` rule, then the hook deny as defence in depth — and
state that for a host with neither project config nor a human present, the refusal must be computed.**

**Does this change the option?** Option B's *conclusion* survives for the two bootstrap recipes
(Homebrew's `install.sh`, aws's `curl | bash`) — those must never be MCP-reachable. But once P2 is
corrected (V6), Option B is no longer the safest option, it is merely the most restrictive one, and
the Architect's §2 risk predicate is better on every axis the plan itself named: it is more
responsive to the request, it keeps the four safe recipes on the audited path instead of pushing the
agent to raw Bash, and it refuses the two dangerous ones **by computation** rather than by prose.
**My recommendation is the risk axis (B′), with the verb axis retained as the user's call in a
neutrally-posed Q2.** I am not directing that choice — the plan must present both honestly, which it
currently does not.

---

## 6. Deliberate-mode floor, and the mutation-test set

**The floor is met.** The pre-mortem is present with three entries in mechanism / blast-radius /
mitigation form, and the test plan is genuinely expanded (unit, integration with a fake spawner, e2e,
mutation, observability, gates). §0's external verification is the strongest work in the document.
This is why the verdict is ITERATE and not REJECT.

**The mutation set is wrong in one slot.** Judged against F7 and §3:

- **#1 (catalog invariant) — KEEP**, retargeted at the existing allowlist test per F5. The instinct
  is right: an exposure test that passes today for every entry can be vacuously true.
- **#2 (`mcpMode` guard) — KEEP.** This is the sound guard, and mutating it must redden
  "spawner never called."
- **#3 (TTY guard) — REPLACE.** As specified it certifies a predicate that fails open for
  terminal-launched MCP (`mcp-mode.ts:6-11`), fails closed for every agent context (F2), and is
  bypassed by `CI=1` on a real TTY (F7). Proving it "bites" proves nothing about any real threat. Worse,
  §6's own stated conclusion — *"if only one mutation reddens, they are redundant and the second
  should be removed"* — would be actively harmful here: they are not redundant, they are unequal, and
  the framing invites deleting the wrong one.

**Replace #3 with two mutations that carry real load:**

- **The `unknown` branch** — force `identify()` to return a concrete manager where the fixture says
  `unknown`; the "never spawns on unknown" assertion must redden. P4's entire weight is here and
  nothing tests it today (§3, PM-2).
- **`confirmedCommand` refusal** — set `confirmedCommand: true` on a dangerous recipe; the "prompted
  anyway / refused" assertion must redden. This is PM-4, and without it `--yes` is a silent bypass.

**And add, if the risk predicate ships:** one mutation per conjunct (no-sudo, no-network-fetched-script,
manager-present, manager-owns-binary), since a four-way conjunction with one dead term is
indistinguishable from a three-way one.

**One more test-plan gap:** the brew child-env scrub must assert absence of `CI`, `INTERACTIVE`,
`HAVE_SUDO_ACCESS` and `SUDO_ASKPASS`, not only `NONINTERACTIVE` (F7). The Architect is right that
this is a design requirement, not a test detail — the scrub belongs in `dependency-install`.

---

## 7. What I am NOT asking the Planner to change

So the revision does not overcorrect:

- §0's verification of findings A, B, C and D. All four are correct, correctly sourced, and finding D
  is the kind of discovery that earns its place in a design document.
- §3.2's module decomposition — pure registry / injected probe / sole-spawner executor. Keeping one
  module as the only thing that spawns is the right chokepoint.
- Separating `present` from `onPath` (finding A).
- The pre-mortem's *form* — mechanism, blast radius, named mitigation. Two mitigations need
  replacing; the discipline should not.
- The observability requirement (log the resolved argv, the detected manager, and **which** guard
  refused). PM-1's nondeterminism is undiagnosable without it.
- Q1 and Q3. Both are real, both are correctly posed, and Q1 in particular is the right instinct —
  challenging the user's own supplied recipe on evidence.

---

## Round 1 verdict — SUPERSEDED by the Round 2 section below. All 14 items were applied; retained for the record.

VERDICT (round 1): ITERATE

1. **Rewrite P2 to state the rule the catalog actually follows**, and re-derive §1, the ADR and Q2
   from it. The false clause is *"every `mutating: true` host-shaping command is not [exposed]"*.
   Cite: 13 of the 23 tools in `command-catalog.test.ts:39-63` are mutating; `worktrees-add` is
   exposed **and ungated** (`LOW_RISK_MUTATING_ALLOWLIST`, `command-catalog.ts:550-560`) and runs
   `pnpm install` (`worktrees-add.ts:331`, described at `:375`); `local-deploy-all` /
   `local-deploy-selected` are exposed; `worktrees-remove` is exposed with its justification stated at
   `command-catalog.test.ts:115-118`. The real rule: **exposure is bounded by a tool's own
   invariants, not by whether it mutates.**
2. **Delete Phase 3 and replace it with three concrete items:** (a) ship **no** `allowed-tools` grant
   for install/update — the host's default Bash permission prompt *is* the P1 channel, and a grant is
   what removes it; (b) add `setup-deps-install` and `setup-deps-update` to
   `plugins/infra-kit/__tests__/manifest.test.mjs:475`'s `MUTATING_INVOCATIONS`; (c) if a plugin
   surface ships, make it a **slash command** modelled on
   `plugins/infra-kit/commands/release-create.md` (no `allowed-tools`, resource-first with a
   direct-tool fallback), not a SKILL.md. State that Phase 3 as originally written would redden U15
   and U6.
3. **Delete the `process.stdin.isTTY` guard from §4 as an MCP guard.** Key the MCP refusal on
   `isMcpMode()` alone and cite `src/lib/mcp-mode/mcp-mode.ts:6-11` and `worktrees-add.ts:56-58`
   (*"never `process.stdin.isTTY`"* — a terminal-launched `infra-kit mcp` has a real TTY stdin).
   Retain a TTY check **only** as a human-presence signal on the CLI path, labelled as such, and state
   that it is defeated by `CI=1` (F7).
4. **Add PM-4 to the pre-mortem: `--yes` defeats the CLI confirmation.** Cite
   `confirm-or-exit.ts:5-8` (*"CLI `--yes` or an MCP call, which always injects
   `confirmedCommand: true`"*). Mitigation: `setup-deps-install` must **not** honour `confirmedCommand`
   for any recipe classified dangerous, with a mutation test.
5. **Re-pose Q2 on the verb-vs-risk axis, neutrally**, and answer the Architect's unaddressed argument
   (c) in §1's option table, the pre-mortem, and the ADR alternatives: the agent already holds `Bash`,
   so barring the MCP tool removes the audited path (pinned argv, `cwd: homedir()`,
   `packageManagerInstallEnv`, refusal on `unknown`, structured logging), not the capability. Give
   Option E/B′ a fair statement of pros as well as cons. Recommend the risk axis; leave the decision
   with the user.
6. **Adopt a five-layer shape, ranked by what travels with the binary**: code-side refusals
   (`isMcpMode`, risk predicate, `unknown → print`) first, then a **`permissions.ask` rule** covering
   `Bash(infra-kit setup-deps-install:*)` / `-update`, then the hook deny as defence in depth, then the
   human channel (slash command), then printed argv. **Prefer the `ask` rule over the Architect's §3a
   hook deny as the host-boundary layer**: it is documented to prompt in every mode including
   `bypassPermissions` (`code.claude.com/docs/en/permission-modes.md`), whereas a hook denies the agent
   without asking anyone (`hooklib.mjs:50-53`) and its survival under `bypassPermissions` — asserted at
   `block-deploy.mjs:3` — is **past the documented surface**. Carry that caveat verbatim; do not repeat
   Phase 3's error of asserting a channel's behaviour. State that neither layer travels with the binary,
   and that for a host with neither project config nor a human present the refusal must be computed.
7. **Replace Phase 0** with the additive export of `isWithin`, `hasSegment`, `isBrewKegOf`,
   `npmPrefixFromSelfPath` from `src/lib/install-manager/index.ts` (which today exports exactly four
   symbols); leave `detectInstallManager` alone; give `DependencySpec` five separate name fields
   (`binName`, `brewFormula`, `brewInstallSpec`, `kegName`, `npmPackage`) per F4. Give the phase a
   **non-vacuous** acceptance criterion: new table tests over the four predicates against the F4 name
   matrix.
8. **Fix every acceptance criterion flagged in §4 of this review.** Specifically: split Phase 1 into
   fixture-driven CI assertions plus a recorded host run with the expected answer written down first;
   name a Phase 2 install target that is actually absent, with a stated and recorded undo; replace
   Phase 4's byte-identity criterion with a structural assertion that the probe argv literals exist in
   exactly one module. Add, per phase, the literal commands to run and the observable that
   distinguishes pass from fail.
9. **Fix the mutation set:** keep #1 (retargeted at `command-catalog.test.ts:86-87`'s allowlist per F5)
   and #2 (`isMcpMode`); **drop the TTY mutation and its "if only one reddens, delete the second"
   rationale**; add mutations for the `unknown` branch and for `confirmedCommand`; add one per conjunct
   if the risk predicate ships. Widen the brew child-env scrub **and its assertions** to `CI`,
   `INTERACTIVE`, `HAVE_SUDO_ACCESS`, `SUDO_ASKPASS`, and site the scrub in `dependency-install` as a
   design requirement.
10. **Budget the wiring the plan omits:** an `MCP_TOOL_PRESENTATION` row for `setup-deps-status` with
    an evidence-cited `openWorld` (`getExposedMcpTools` **throws at registration** without it —
    `command-catalog.ts:678-683`); `EXPECTED_EXPOSED_TOOLS` plus `toHaveLength(23) → 24`; and
    `withEscape` around any new `@inquirer` picker, or
    `src/lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts` reddens.
11. **Decide where `stale` comes from before Phase 1** — it determines `openWorld`, whether the status
    tool makes network calls, and whether the long-lived MCP server acquires a hang risk. A
    registry-pinned floor is pure and `openWorld: false`; an upstream check needs a timeout and a cache.
12. **Set `menuGroup: null` on `setup-deps-install` and `setup-deps-update`**, per `self-update`'s
    two-part reasoning asserted at `command-catalog.test.ts:157-167` and the zero-flag palette dispatch
    at `run-session.ts:199`. Not a fallback — the default.
13. **Fold Phase 4 into Phase 1** (V3), and correct the duplicated-probe count from three to four —
    `portless installed` is a real check (`report.ts:79`) — while stating that the registry's **brew**
    probe is new surface, not unification (F6).
14. **Retract the Phase 3 authorization claim explicitly**, in §1, §5 and §7, rather than silently
    editing it away. The plan asserted a mechanism's behaviour without checking it, one directory away
    from a CI test that says the opposite (`manifest.test.mjs:472-474`); the retraction is what stops
    the next reader re-deriving the same error.

---

# Round 2 — verdict pass on revision 2

Re-read `docs/archive/mcp/mcp-setup-dependency-plan.md` in full. This is a verdict pass, not a fresh review: I
checked whether my 14 items landed *in the text*, hunted for contradictions bred by three rounds of
editing, judged §5.2's non-circularity argument on its own merits, and re-tested the deliberate-mode
floor. Everything asserted below was re-derived from the working tree.

## R2.1 — Did the 14 land?

**All 14 landed substantively. None is cosmetic or partial.** The ones I checked hardest, because
they were the easiest to fake:

- **#1 (P2).** Not merely deleted — replaced with the correct rule *and a better citation than I gave*.
  §0 R2 and §3 P2 now cite `command-catalog.test.ts:233-249`, which I had not found. I verified it:
  it filters `entry.mutating && entry.mcpExposed && entry.mcpTool?.requiresHumanConfirm !== true`,
  subtracts `LOW_RISK_MUTATING_ALLOWLIST`, and asserts the remainder is empty, under the doc comment
  *"The P1 invariant, fail-closed… opting out of the gate becomes a deliberate, greppable allowlist
  edit, never a silently-typed `false`."* The plan's use of it in R2, PM-3 and §5.6 is accurate. This
  is the plan finding a stronger fact than the review that asked for it, which is the right direction.
- **#2 (Phase 3).** All five sub-deliverables present, including the negative one (b) and the
  `MUTATING_INVOCATIONS` edit (c).
- **#8 (acceptance criteria).** Phase 1 split into (a) CI-fixture and (b) recorded host run with the
  expected answer written down first; Phase 4's byte-identity criterion replaced with a structural
  one. Both are real fixes. **Except the Phase 2 target — see R2.3.**
- **#9 (mutations).** The TTY mutation and its "delete the redundant guard" rationale are gone, with
  the reason stated. Items 3, 4 and 5 added. **Item 6 is new and does not work — see R2.4.**
- **#14 (retraction).** §0 R1–R3 do this properly, as retractions rather than edits.

## R2.2 — Damage from the revisions: one real hole, and it is in the load-bearing claim

Revision 1 had install/update **CLI-only**, so a `Bash(...)`-shaped host-boundary rule covered the
whole surface. Revision 2 moved install/update **onto MCP** (Option B′) but kept the layer-ii rule in
its revision-1 shape. The two halves no longer meet.

**§7 Phase 3(a) writes the ask rule as `Bash(infra-kit setup-deps-install:*)` and `…-update:*`. The
plan's own primary invocation path is an MCP tool call, which is not a Bash tool call.** A permission
rule scoped to the `Bash` tool cannot govern a different tool's invocation — that much is structural
and needs no citation. So under the recommended option, an agent calling
`mcp__infra-kit__setup-deps-install` meets layer ii **not at all**.

This propagates into three places that now overclaim:

- **§9 Consequences:** *"Where the rule is present, the human is prompted in every mode."* False for
  the MCP path, which is the path the ADR selects.
- **§2 conclusion 1** reasons entirely about `Bash(infra-kit setup-deps-install gh)`. Correct as far
  as it goes, and silently not about the chosen path.
- **§3 driver 1** and **§10 Q2** both offer the ask rule as the thing that "prompts a human on top of"
  the predicate. On MCP, nothing is on top of the predicate.

This is not fatal to Option B′ — the computed predicate, layer i, is untouched and still travels with
the binary, and the plan is right that layer i is what carries the design. It is fatal to the specific
sentence that says a human is prompted.

**And the obvious fix — "just add an MCP-scoped ask rule" — does not work either.** I had this checked
against the documentation, and MCP permission rules differ from Bash rules in three ways that matter,
each of which the plan would otherwise have discovered the hard way:

- **Syntax is `mcp__<server>__<tool>`, and a rule carrying parentheses is SILENTLY SKIPPED.** Writing
  the Bash-shaped `mcp__infra-kit__setup-deps-install(...)` out of habit produces a rule that loads,
  matches nothing, and reports nothing. A booby trap for exactly the argv-shaped rule this plan wants.
- **Tool-name granularity only.** There is no parameter matching in settings rules (the CLI's
  `--disallowedTools` is the separate mechanism). So an MCP ask rule on `setup-deps-install` prompts
  on **every** call, safe recipes included — a real design consequence, not a detail.
- **Whether an MCP `ask` rule prompts under `bypassPermissions` is UNDOCUMENTED, and reported as
  likely not to.** The documented bypass exception list is what carried the Bash-rule claim in §0; it
  is not confirmed to extend to MCP ask rules.

**There is, however, a mechanism that does prompt under `bypassPermissions` for an MCP tool:
`anthropic/requiresUserInteraction: true`. This is now VERIFIED** — the team lead fetched
`code.claude.com/docs/en/mcp.md` directly rather than taking it at second hand. What the page says:

- Placement is `_meta` on the tool's `tools/list` entry —
  `"_meta": { "anthropic/requiresUserInteraction": true }` — and *"the value must be the JSON boolean
  `true`; any other value is ignored."*
- Claude Code *"shows that tool's permission prompt on every call, even in `acceptEdits`, `auto`, and
  `bypassPermissions` permission modes, and doesn't offer a 'don't ask again' option for it. **Allow
  rules that match the tool don't skip the prompt either.**"*
- In `dontAsk` mode, which never prompts, Claude Code **denies the call**.
- Under `--permission-prompt-tool`, an `allow` result for a flagged tool is converted to a deny. The
  Agent SDK's `canUseTool` callback does receive them and can approve.

It is strictly better than an ask rule here, for a reason the plan itself would recognise: **it lives
in the server's own tool registration, so it travels with the binary.** That is layer i's defining
property, not layer ii's — so adopting it does not merely patch the hole, it **reorders the five-layer
ranking**, giving the design a human prompt that survives both `bypassPermissions` and a machine with
no `.claude/` config.

**Two caveats from the same page mean it cannot be the sole control**, and both must be stated in the
plan rather than implied: it *"requires Claude Code v2.1.199 or later. **Earlier versions ignore it**
and apply the standard permission flow"* — silent degradation — and it is a Claude Code extension, not
MCP spec, so any other host ignores it entirely. **The risk predicate therefore remains the fail-closed
floor**; the annotation is the human prompt layered on top of it wherever the host honours it.

A third consequence worth naming: in `dontAsk` mode and under `--permission-prompt-tool`, the flagged
tools are **denied**, so `setup-deps-install` is simply unavailable over MCP there. That fails safe and
is the right outcome, but it is an availability property the plan should record rather than discover.

The procedural point stands regardless of this one verifying: R1, the Bash-rule scope, and this were
the same error in three revisions — a channel's coverage asserted without checking it. **No
authorization channel enters the design until its documentation has been read.**

**No other contradiction found.** I specifically checked the seams named in the brief:

- §2's table row *"Host's default Bash permission prompt — survives bypassPermissions: **No**"* against
  §7's acceptance *"the ask rule prompts in default **and** bypass mode"* — **consistent**; different
  rows, correctly distinguished. The earlier contradiction is repaired.
- §3 driver 1, §9 drivers, §10 Q2 all now say the same thing about *why* layer i outranks layer ii
  (independence from host config, not the absence of a prompt) — **consistent**, and consistently
  correct.
- §5.6's `requiresHumanConfirm: true` against P1 (*"never from a token"*) — **not a contradiction**;
  §5.6 states plainly that the gate is not the control and exists to satisfy the fail-closed test
  without a false low-risk claim. That reasoning is sound and correctly cited.

## R2.3 — Phase 2's real-install target fails for the exact reason the last one did

§7 Phase 2 replaced `gh` with `gnupg`, reasoning that `doctor` already probes `gh installed` so it is
presumably present. Measured on this host:

```
gpg:        /opt/homebrew/bin/gpg
brew gnupg: /opt/homebrew/Cellar/gnupg/2.5.20/INSTALL_RECEIPT.json
```

**`gnupg` is already installed.** The revision swapped one present tool for another present tool, so
the criterion is un-runnable for the identical reason. Two further problems:

- **`gnupg` has no `DependencySpec` row.** §5.1's five-name table covers `brew`, `aws`, `gh`,
  `doppler`, `portless`. `gnupg` appears only as a step inside doppler's install recipe
  (§5.2's table: `brew install gnupg` → `brew install dopplerhq/cli/doppler`). So
  `infra-kit setup-deps-install gnupg` — the literal command in Phase 2's and Phase 3's acceptance
  steps — is **not a valid invocation of the design as specified**. And its names diverge exactly the
  way the five-name table exists to capture: the binary is `gpg`, the formula is `gnupg`.
- **The stated undo removes a working tool.** `brew uninstall gnupg` on a machine where it is
  installed and depended upon is a destructive acceptance step, not a neutral one.

Pick a target that is genuinely absent on the host, has its own registry row, and whose undo restores
the machine exactly — or make the real-install acceptance explicitly conditional, run against whichever
of the five the recorded Phase 1 host run reported missing.

## R2.4 — The non-circularity argument: sound, but its guarantee is under-specified and its mutation test is vacuous

**The argument is TRUE of the design as written, and for a slightly better reason than the plan gives.**

Checked against §5.2's own recipe table: the Homebrew bootstrap fails *no sudo* **and** *no
network-fetched script*; the aws first install fails *no network-fetched script*. Both are static
recipe properties. So neither bootstrap refusal depends on `identify()` being right — correct.

And "detection can only narrow, never widen" holds structurally, because the predicate is a pure
conjunction: adding conjuncts 3 and 4 can only remove recipes from the executable set. Correct.

**But the plan's stated reason is the weaker one.** It says the static conjuncts are *"evaluated first
and independently"*. Evaluation order is not what secures the property — a pure `&&` chain is
order-independent. What actually secures it is that **`recipesFor(manager)` is itself keyed on
detection**, so a misdetection does not merely filter, it *selects a different recipe* — and the static
conjuncts are then applied **to whichever recipe was selected, unconditionally**. That is why a
misdetection cannot promote the bootstrap into the executable set: even if detection selected it, the
static check still runs on it. The plan's empirical version ("looking at the table, misdetection only
substitutes one safe recipe for another") is true today and would stop being true the moment a recipe
row changed. State the structural version instead.

**Two consequences the Planner must fix:**

1. **§5.1 does not declare the fields §5.2 depends on.** §5.2 calls the first two conjuncts *"static
   registry literals that no probe touches"*, but §5.1's field list is `probeArgv`, `versionFrom`,
   `platforms`, `prerequisites`, `identify`, `recipesFor` — **no `needsSudo`, no
   `fetchesNetworkScript`**. (Revision 1 had `needsSudo`/`needsTty`; the revision dropped them.) The
   argument's precondition is absent from the data model it claims to be reading.
2. **Mutation 6 is vacuous as worded.** It says: *"**reorder** or short-circuit the predicate so a
   detection result can reach a recipe that already failed a static conjunct."* Reordering a pure
   conjunction is a semantic no-op — that mutation cannot redden anything, which is precisely the
   failure mode mutation testing exists to catch. The mutation that carries real load is the second
   clause only, sharpened: **make the static conjuncts conditional on detection** — e.g. skip
   conjuncts 1–2 whenever `identify()` returns a concrete manager — and assert that the property
   *"no `identify()` output makes a sudo-requiring or network-fetched recipe executable"* reddens. That
   assertion must be a sweep over all five tools × all manager classifications, not a single fixture,
   or it proves one row rather than the invariant.

So: is item 6 a real test or a restatement? **Half of it is a real test and half is a no-op**, and as
written the no-op comes first. Fix the wording and it becomes the strongest item in the set.

## R2.5 — One more omitted budget item, same class as the three already caught

`command-catalog.test.ts:225` asserts `expect(gated).toEqual([...EXPECTED_GATED_TOOLS].sort())` — an
exhaustive list, like the exposure allowlist. §5.6 gives `setup-deps-install` and `setup-deps-update`
`requiresHumanConfirm: true`, so **`EXPECTED_GATED_TOOLS` must gain both entries** or Phase 2 cannot go
green. §5.6 budgets `MCP_TOOL_PRESENTATION`, `EXPECTED_EXPOSED_TOOLS` / `23 → 26`, and `withEscape`,
but not this.

## R2.6 — Deliberate-mode floor: met

**Pre-mortem (PM-1..PM-4): adequate.** Each has a mechanism, a blast radius, and a mitigation that
names something that works. Specifically: PM-1's mitigation is now a computed predicate plus the
five-variable env scrub rather than the broken TTY guard; PM-2's carries the mutation test that was
missing; PM-3 extends the two inescapable existing tests; PM-4 is new and its mitigation — refuse
outright, so there is no prompt to skip — is the right shape rather than a stronger prompt.

**Test plan: adequate.** Unit / integration with a fake spawner / e2e / six mutations / observability /
gates, with the "no test in this suite runs `curl`" line kept. The observability requirement now logs
*which* refusal fired, which is what PM-1 needs. Subject to R2.4's fix to item 6 and R2.5's budget
item, this clears the floor comfortably.

**Two things I am noting but not requiring**, so the Planner does not treat them as blockers:

- **P3 is now vestigial.** *"Absence beats a flag… Applies to the recipes we bar, not to the tool as a
  whole."* But a recipe is not a catalog entry, so there is no absence mechanism available to it — the
  recipes are barred by a computed predicate, which is the opposite of absence. P3 survives from
  revision 1 without a job. Harmless; delete it or say what it now governs.
- **`requiresHumanConfirm: true` makes both tools unreachable on v1-SDK clients.** Prior sessions
  established that such clients validate `structuredContent` while ignoring `isError`, so the gate
  payload is refused. That fails safe (the tool never runs) and does not change the design, but it is a
  consequence of §5.6's choice that §9 does not list.

## R2.7 — What revision 2 got right, said plainly

The three retractions in §0 are the right way to revise a plan under review — the errors are preserved
with their reasoning so the next reader cannot re-derive them. §2's channel inventory is now the most
useful page in the document and is accurate row by row. The move to the risk axis is argued rather than
asserted, driver 2 is answered where it was previously absent, and Q2 presents both axes with real
costs on each side before recommending. §5.6's decision to take `requiresHumanConfirm` rather than
widen `LOW_RISK_MUTATING_ALLOWLIST` — on the grounds that the allowlist asserts a low-risk claim that
would be false here — is a genuinely good call that no review asked for.

---

VERDICT: ITERATE

1. **Cover the MCP path — and not with a Bash-shaped ask rule.** §7 Phase 3(a) currently writes only
   `Bash(infra-kit setup-deps-install:*)` / `…-update:*`, which cannot govern an
   `mcp__infra-kit__setup-deps-*` tool call — the primary path of the recommended option. Required
   changes:
   - **Adopt `anthropic/requiresUserInteraction: true` on both MCP tool definitions as the layer for
     the MCP path.** VERIFIED against `code.claude.com/docs/en/mcp.md`: set as
     `_meta: { "anthropic/requiresUserInteraction": true }` on the `tools/list` entry (the value must
     be the boolean `true`; anything else is ignored), it prompts on every call in `acceptEdits`,
     `auto` and `bypassPermissions`, and **allow rules matching the tool do not skip the prompt**.
     Unlike every layer ii–iv it lives in the server's own registration, so **it travels with the
     binary** — promote it in the five-layer ranking alongside the code-side refusals and say why: it
     has layer i's independence-from-host-config property *and* asks a human.
   - **Budget the SDK question rather than assuming it:** whether `@modelcontextprotocol/server`'s
     `registerTool` can set `_meta` on the `tools/list` entry is a thing to check, not to assume.
   - **State both degradation paths explicitly, not by implication:** it requires Claude Code
     **v2.1.199 or later — earlier versions ignore it silently** and apply the standard flow, and it is
     a Claude Code extension rather than MCP spec, so **any other host ignores it**. Therefore **the
     risk predicate stays the fail-closed floor** and the annotation layers a human prompt on top of it
     only where the host honours it. Say that complementarity in one line, and revisit any §3 / ADR
     driver resting on "the MCP boundary has no human channel", which is now false for Claude Code
     ≥ v2.1.199.
   - **Record the availability consequence:** in `dontAsk` mode and under `--permission-prompt-tool`, a
     flagged tool is **denied**, so install/update are unavailable over MCP there. Fails safe; state it.
   - **Keep the Bash ask rule for the CLI path**, and state that the two cover different paths rather
     than duplicating.
   - If an MCP ask rule ships as well, record its three constraints: syntax is `mcp__<server>__<tool>`;
     **a rule containing parentheses is silently skipped** (so no argv-shaped rule is possible);
     matching is tool-name granularity only, so **safe recipes prompt too**; and its behaviour under
     `bypassPermissions` is **undocumented and reported as likely not to fire** — which is why it
     cannot be the primary MCP-path control.
   - **Correct the three places that overclaim:** §9 Consequences (*"Where the rule is present, the
     human is prompted in every mode"*), §2 conclusion 1 (reasons only about the Bash form), and §3
     driver 1 / §10 Q2 (offer the rule as sitting "on top of" the predicate on the MCP path).
   - **Add the procedural rule this document has now needed three times:** no authorization channel
     enters the design until its documentation has been read. R1, the Bash-rule scope, and this are
     the same error in three revisions.
2. **Fix mutation 6.** Drop *"reorder"* — reordering a pure conjunction is a semantic no-op and cannot
   redden. Specify the mutation as *making the static conjuncts conditional on detection* (skip
   conjuncts 1–2 when `identify()` returns a concrete manager), and require the assertion to be a sweep
   over all five tools × all manager classifications, not a single fixture.
3. **Add `needsSudo` and `fetchesNetworkScript` to §5.1's `DependencySpec` field list** as recipe-level
   literals. §5.2's non-circularity argument requires them and §5.1 no longer declares them.
4. **Restate §5.2's guarantee structurally.** Replace *"evaluated first and independently"* with the
   reason that actually holds: the static conjuncts are applied to **whichever recipe `recipesFor`
   selected, unconditionally**, so a misdetection that selected the bootstrap would still be refused by
   them. The current empirical justification stops being true the moment a recipe row changes.
5. **Replace the Phase 2 / Phase 3 real-install target.** `gnupg` is already installed on this host
   (`/opt/homebrew/Cellar/gnupg/2.5.20`), so it is un-runnable for the identical reason `gh` was; it has
   no `DependencySpec` row, so `infra-kit setup-deps-install gnupg` is not a valid invocation of §5.1's
   model (its binary is `gpg`, its formula `gnupg` — the very divergence the five-name table exists for);
   and `brew uninstall gnupg` removes a working tool. Either name a target genuinely absent here with a
   restoring undo, or make the step conditional on whichever of the five the recorded Phase 1 host run
   reported missing.
6. **Budget `EXPECTED_GATED_TOOLS`.** `command-catalog.test.ts:225` asserts it exhaustively
   (`toEqual([...EXPECTED_GATED_TOOLS].sort())`); §5.6's `requiresHumanConfirm: true` on both new tools
   requires both entries, and §5.6 lists the other three budget items but not this one.

---

# Round 3 — verdict pass on revision 3

Scoped as agreed: I did not re-verify items 1–6, which the team lead pre-checked and which I spot-read
as substantive (mutation 6 now negates "reorder" rather than containing it; §5.2's guarantee is stated
structurally at line 330; `needsSudo` / `fetchesNetworkScript` are declared as recipe literals in §5.1;
`portless` replaces `gnupg` with the rejection history recorded; `EXPECTED_GATED_TOOLS` budgeted; the
MCP rule syntax and the SDK `_meta` support both verified against primary sources). This pass covers
only (a)–(d).

## R3.1 — (a) Has the annotation displaced the predicate? **No. Cleanly handled.**

This was the risk I flagged when the annotation was promoted, and the plan closes it in four places
rather than one:

- **§2 conclusion 3:** *"(i-a) remains the fail-closed floor, and (i-b) does not replace it… The two
  are complementary, not alternatives — **the annotation supplies the human, the predicate supplies the
  guarantee.**"* That last clause is the cleanest statement of the relationship anywhere in the
  document.
- **§7 Phase 3(a-MCP):** *"a gate where honoured and a no-op elsewhere, **never a substitute for
  §5.2**."*
- **§5.2** is untouched and still owns the refusal.
- **§1 finding D** gained the right disclaimer — *"This does not mean the MCP boundary has no human
  channel"* — which stops a reader carrying revision 2's conclusion forward.

Complementarity is stated, not inferred. Satisfied.

## R3.2 — (b) Are both silent-degradation paths explicit? **Yes, in five places.**

The v2.1.199 floor and the non-Claude-Code-host case both appear, together, in §2 conclusion 2 caveat
(i) (*"earlier versions ignore it and apply the standard permission flow… so any other host ignores it
too: **it fails OPEN, silently**"*), §2 conclusion 3, §7 Phase 3(a-MCP), §9 Consequences, and §10 Q4.
Neither is left to inference anywhere it matters. The `dontAsk` and `--permission-prompt-tool` deny
behaviours are recorded as caveats (ii) and (iii), and the fail-open/fail-safe direction is named each
time. Satisfied — this is more thorough than I asked for.

I also note the plan surfaces a reported regression (anthropics/claude-code#58757) claiming bypass mode
hard-blocks rather than prompts, correctly labels it *"issue tracker, not docs"*, and observes it fails
safe. That is the right handling of a source of that weight.

## R3.3 — (c) The seams after the re-ranking: three of four repaired, **§9 not fully swept**

I predicted §3 driver 1 and §9 "Why chosen" would be left resting on the old ranking. Both were
repaired, correctly:

- **§3 driver 1** is rewritten to the right claim — the MCP boundary *does* now have a human channel for
  Claude Code ≥ v2.1.199, and what the driver actually rests on is that the channel is **host-specific
  and version-gated**. Good; that is the honest version.
- **§9 "Why chosen"** now reads *"it pairs that with `requiresUserInteraction` — which also travels and
  asks a human in every mode where it is honoured"*.

**But §9 "Drivers" (1) was missed, and it now contradicts the paragraph two below it and §2 outright.**
Line 647:

> *"A computed refusal is **the only control that travels with the binary** — a `permissions.ask` rule
> does prompt a human in every mode… but it lives in project config."*

Against §2 conclusion 3 (line 161), whose entire justification for ranking i-b alongside i-a is that
the annotation *"lives in our own server registration and therefore **ships with the binary**"*; and
against §9's own "Why chosen" (line 660), *"which **also travels**"*. §9 contradicts itself two
paragraphs apart, and the stale half is the load-bearing one — driver 1 is the justification for the
whole layering, and it also still frames the ask rule as the counterexample, which was revision 2's
framing before layer i-b existed.

§3 driver 1 already contains the correct replacement wording: *"the only control **honoured on every
host and in every mode**"*. §9 driver 1 should mirror it.

Two smaller residues in the same unswept sweep:

- **§9 "Decision" omits the annotation entirely** (line 619-620): it names the predicate,
  `requiresHumanConfirm`, `menuGroup: null`, the absent grant, and the ask rule — but not
  `_meta["anthropic/requiresUserInteraction"]`, which is revision 3's single most important addition and
  the only human gate on the primary path. The ADR's Decision paragraph is what survives the plan; it
  should state what is being decided.
- **§5.2's heading** — *"The risk predicate — the control that travels with the binary"* — carries the
  same definite article. Defensible as section scoping, but it reads as the old exclusivity claim.

## R3.4 — (d) Contradictions introduced by promoting the annotation: one sequencing gap

Beyond R3.3, one substantive item. **§7 Phase 3(a-MCP) leaves it undecided which phase actually ships
the annotation:** *"Ships in Phase 2's registration if it lands there; called out here so the two halves
of layer ii are decided together."* Meanwhile Phase 2's acceptance criteria do not mention `_meta`, and
the assertion that it is present in the `tools/list` snapshot lives in **Phase 3's** acceptance.

That matters because §7 names Phases 0+1+2 the **"minimum useful slice… this is where the user's request
is satisfied"** — an explicit invitation to stop there. As written, stopping after Phase 2 ships
MCP-exposed install/update with the predicate in place but **no human gate at all**: the annotation
unasserted (and possibly absent), and none of Phase 3's ask rules written. The predicate still refuses
the two dangerous recipes, so this is the Q4 residual rather than a new risk — but it is the residual at
its maximum, in the slice the plan tells the reader is sufficient.

The fix is one sentence, and it is cheap because the work is trivial: `_meta` is one carrier field plus
one pass-through at a single `registerTool` call site (§5.6, verified). Either move it and its snapshot
assertion into Phase 2, or state that Phase 2 must not land without Phase 3(a-MCP).

(Also in that paragraph: a-MCP is layer **i-b**, but its closing clause says *"so the two halves of
layer **ii** are decided together"* — the two halves belong to a-ask. Wording only; fix it in passing.)

## R3.5 — Deliberate-mode floor and the design itself

**Unchanged and adequate.** PM-1..PM-4 are intact with working mitigations; the test plan retains its
six mutations with item 6 now non-vacuous and swept across all five tools × every manager
classification; observability still distinguishes which refusal fired.

**And to be plain about the design, since none of the above touches it:** the layering is now sound and
better-evidenced than at any prior revision. `requiresUserInteraction` genuinely closes the hole the
first two rounds concluded could not be closed — a human gate at the MCP boundary that allow rules
cannot suppress and `bypassPermissions` does not skip — and the plan resists the obvious temptation to
let that retire the predicate. Q4 is a good addition: it puts the one decision that is genuinely the
user's, framed honestly, with the fallback named (Option B, install/update back to CLI-only) rather than
implied. The three items below are a consistency sweep of §9 plus one sequencing sentence. **No design
change is requested.**

---

VERDICT: ITERATE

1. **Fix §9 "Drivers" (1)** (line 647). *"A computed refusal is the only control that travels with the
   binary"* contradicts §2 conclusion 3 (layer i-b *"ships with the binary"*, line 161) and §9's own
   "Why chosen" (*"which also travels"*, line 660). Mirror the wording §3 driver 1 already uses: the
   computed refusal is the only control **honoured on every host and in every mode**. Drop the ask rule
   as the sole counterexample and name the annotation's version/host gating alongside it. Optionally
   soften §5.2's heading, which carries the same stale definite article.
2. **Add the annotation to §9 "Decision"** (line 619-620). It names the predicate,
   `requiresHumanConfirm`, `menuGroup: null`, the absent grant and the ask rule, but omits
   `_meta["anthropic/requiresUserInteraction"]` — revision 3's most important addition and the only
   human gate on the primary path. One clause.
3. **Decide which phase ships the annotation, and say so.** §7 Phase 3(a-MCP) says *"Ships in Phase 2's
   registration if it lands there"* while its `tools/list` assertion sits in Phase 3's acceptance — so
   stopping at the plan's own declared "minimum useful slice" (0+1+2) ships MCP-exposed install/update
   with no human gate at all. Either move `_meta` and its snapshot assertion into Phase 2's acceptance,
   or state that Phase 2 must not land without Phase 3(a-MCP). While there, correct that paragraph's
   *"the two halves of layer ii"* — a-MCP is layer i-b.

---

# Round 4 — final verdict pass on revision 4

Scoped to the three Round 3 items and to whether any of them introduced a new contradiction. Nothing
else was re-opened.

**Item 1 — landed.** §9 Drivers (1) now reads *"A computed refusal is the only control **honoured on
every host and in every mode**"*, and names both limits rather than only the ask rule's: the annotation
*"also ships with the binary but is ignored below Claude Code v2.1.199 and on non-Claude-Code hosts"*,
the ask rule *"prompts in every mode but lives in project config"*. That matches §3 driver 1 and no
longer contradicts §2 conclusion 3 (line 161) or §9 "Why chosen" (line 669). §5.2's heading is softened
to *"the control honoured on every host and in every mode"*. The one surviving *"travels with the
binary"* in "Why chosen" is about the **option**, and its very next clause is *"it pairs that with
`requiresUserInteraction` — which also travels"* — internally consistent, and not something I flagged.

**Item 2 — landed.** §9 Decision now declares
`_meta["anthropic/requiresUserInteraction"]: true` as *"the only human gate on the primary path"*, ahead
of `requiresHumanConfirm`, with the prompt-in-every-mode and allow-rule-immunity properties stated and
the version floor carried. The ask-rule clause is corrected to *"cover both the MCP tool names and the
Bash argv"*.

**Item 3 — landed, and better than what I asked for.** Layer i-b moved into **Phase 2**, under an
explicit heading (*"Layer i-b ships HERE, not in Phase 3"*) with the reasoning recorded rather than the
change made silently: *"A gate whose acceptance lives in a later phase is a gate that can be skipped by
shipping on time."* Phase 2's acceptance asserts `_meta` on both tools **and negatively** — *"on neither
`setup-deps-status` nor any other tool"* — which is stronger than the positive assertion I specified and
catches a mis-scoped declaration. Phase 3's header now reads *"layers ii and iv"* with *"Layer i-b
landed in Phase 2, by design"*; the duplicate snapshot assertion is gone with a pointer back to Phase 2;
and the *"two halves of layer ii"* wording is gone with the a-MCP paragraph, leaving a-ask correctly
labelled layer ii.

**No new contradiction introduced.** I re-checked every `_meta`, `layer i-b`, and travels/ships/honoured
occurrence across §2, §5.2, §5.6, §7 and §9: the phase attribution is now single-sourced to Phase 2, the
layer labels agree everywhere, and the three degradation caveats are stated identically in each place
they appear.

**Verdict rationale.** I certified the design sound in Round 3 and requested no design change; these
three were my own scoped consistency list and all three are discharged. The plan's remaining
uncertainty is uncertainty it names and hands to the user — Q1 (whether a global portless is wanted at
all), Q2 (verb axis versus risk axis, with a recommendation and the fallback stated), Q3 (own versus
adapt), and Q4 (whether the non-Claude-Code / pre-v2.1.199 residual is acceptable, with Option B named
as the remedy if not). That is a planning artifact doing its job, not a defect.

For the record, the load-bearing corrections this loop produced, none of which existed in revision 1:
the `allowed-tools` grant inversion (R1); P2's factual refutation and the move to the risk axis (R2);
the `stdin.isTTY` guard that failed open (R3); PM-4's `--yes` bypass; the Bash-rule/MCP-path
conflation; and `requiresUserInteraction`, which closed the hole the first two rounds had concluded
could not be closed. Every one of them was found by reading a source rather than by reasoning from a
prior document, which is the procedural rule §2 now records.

---

VERDICT: APPROVE
