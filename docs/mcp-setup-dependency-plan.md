> Status: pending approval — planning artifact, not authorization to implement.

# SetupDependency — installing and updating external developer tooling

Scope: detect, install, and update five external tools (`brew`, `aws`, `gh`, `doppler`, `portless`),
including detection of **how** each is already installed.

Revision 2, after architect and critic review. Where the two reviews conflict the critic's item is
taken; each such point is flagged inline as *(architect dissent)*.

## 0. Retractions from revision 1

Stated as retractions rather than silently edited, so the next reader does not re-derive the errors.

**R1 — `allowed-tools` is a GRANT, not a prompt. Revision 1's entire authorization story was backwards.**
It "grants permission for the listed tools during the turn that invokes the skill, so Claude can use
them without prompting you for approval." Phase 3 proposed narrowing `allowed-tools` to the install
argv *in order to obtain* a prompt; that narrowing is precisely what **removes** the prompt, and the
phase's acceptance criterion was therefore unpassable. Worse, this repo already asserts the rule in its
own CI: `plugins/infra-kit/__tests__/manifest.test.mjs:472-474` — *"a rule is a standing grant that runs
without a prompt"* — with test U15 (`:477-486`) failing any fenced mutating command in the doctor skill.
Revision 1 cited `plugins/infra-kit/skills/doctor/SKILL.md` as precedent; every entry in that skill's
`allowed-tools` is read-only, which is the one case where grant and prompt are indistinguishable. The
claim was load-bearing, cheaply checkable, and one directory away from a test saying the opposite.

**R2 — P2 was factually false, and it was the hinge of the option choice.**
Revision 1 asserted "every `mutating: true` host-shaping command is not [exposed]". It is not true.
`command-catalog.test.ts:39-63` lists 23 exposed tools and **13 are mutating**. Decisively:
`worktrees-add` is exposed, mutating, and **ungated** — a member of `LOW_RISK_MUTATING_ALLOWLIST`
(`command-catalog.ts:551-561`) — and it runs `await $({ cwd: worktreePath })`pnpm install``
(`worktrees-add.ts:331`), i.e. arbitrary package lifecycle scripts on this host, today, over MCP, with
no confirmation. `local-deploy-all` / `local-deploy-selected` are exposed. `worktrees-remove` is exposed
and deletes gitignored files, justified in the test itself (`command-catalog.test.ts:115-118`) by *"the
tool's own invariants"*. **The catalog's real rule: exposure is bounded by a tool's own invariants, not
by whether it mutates** — enforced fail-closed at `command-catalog.test.ts:233-249`, where every
mutating+exposed tool must carry `requiresHumanConfirm` **or** be a justified allowlist member. A
mechanism for exposing a mutating tool already exists; revision 1 did not need to invent one, and its
count of "three standing precedents barring this" over-counted.

**R3 — the `process.stdin.isTTY` MCP guard re-introduced a documented defect.**
`src/lib/mcp-mode/mcp-mode.ts:6-11`, verbatim: *"`process.stdin.isTTY` CANNOT answer that question:
`commands/mcp/mcp.ts` spawns the server with `stdio: 'inherit'`, so a terminal-launched `infra-kit mcp`
hands the child a real TTY stdin and an isTTY-keyed guard does not fire."* `worktrees-add.ts:56-58`
repeats it as a standing rule: *"keyed on `isMcpMode()`, **never** `process.stdin.isTTY`."* The guard
fails **open** for terminal-launched MCP, fails **closed** for every agent Bash context (which has no
TTY), and is bypassed by `CI=1` on a real TTY. Revision 1's claim of "two independent guards" was false:
they are unequal, not peers.

## 1. Verified external facts (revision 1's §0; all four survived review)

**A. AWS CLI — the user's command is correct.** `curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash`
is the AWS-documented **recommended** method for macOS and Linux. Installs to `$HOME/.local/share/aws-cli`
with a symlink in `$HOME/.local/bin`; **no sudo**. Update is `aws update`. Consequence: `$HOME/.local/bin`
is often absent from `PATH`, so status must separate `present` from `onPath`.

**B. Homebrew — needs sudo, and fails nondeterministically rather than hanging.** `install.sh:116-127`
sets `NONINTERACTIVE=1` itself when stdin is not a TTY *and* when `$CI` is set. Under `NONINTERACTIVE`,
`have_sudo_access()` (`:235-267`) appends `-n`, runs `sudo -l mkdir`, and on macOS a non-zero result is a
hard `abort "Need sudo access on macOS…"`. `trap '/usr/bin/sudo -k' EXIT` (`:514-516`) fires only when the
timestamp was not already active. See PM-1.

**C. Doppler — brew-installed must use brew.** `doppler update` is the vendor self-updater;
`brew upgrade doppler` is the Homebrew path. For a keg, brew is correct — the self-updater against a keg
is the split-brain `install-manager` already refuses for infra-kit (`canSelfSpawn: false` for homebrew).
Keg dir is `Cellar/doppler`, not `Cellar/dopplerhq`. *Residual:* I found no authoritative statement that
`doppler update` **refuses** under brew; the design never calls it on a detected keg, so the uncertainty
is unreachable in code.

**D. `formProvider` is not a portable human gate.** `resolveGateState` (`tool-handler.ts:113-126`)
returns `'form'` only under `canForm ∧ hasProvider ∧ formable`, and `buildFormOrGate` (`:315-348`)
**falls through to `buildConfirmGate`** when the provider rejects, outruns `formDeadlineMs`, resolves
`null`, or hands `elicit()` an inexpressible shape — *"with today's behaviour and no thrown error"*. It
degrades to the agent-satisfiable token gate exactly on hosts where you cannot observe it. Option D is
dead on evidence. **This does not mean the MCP boundary has no human channel** — see §2 on
`requiresUserInteraction`, which is a different mechanism: host-enforced rather than server-negotiated,
and it fails open on unknown hosts rather than degrading into a token the agent already holds.

Platform: every brew path is macOS/Linuxbrew only. Host is darwin.

## 2. What actually authorizes execution — the inventory revision 1 never made

Each row is annotated with **which invocation path it covers** — MCP tool call or Bash — because the two
are disjoint and revision 2 conflated them (see the note below the table).

| Channel | Path | Human sees the argv? | Agent-satisfiable? | Survives `bypassPermissions`? |
|---|---|---|---|---|
| Confirm token (round 2) | MCP | No | **Yes** — token handed to the caller | n/a |
| `formProvider` elicitation | MCP | Only where `elicitation.form` is declared | Degrades to the token gate, silently | n/a |
| **`_meta["anthropic/requiresUserInteraction"]`** | **MCP** | **Yes — the tool's own permission prompt, every call** | **No** | **Yes — documented**, but see the version caveat |
| `allowed-tools` narrowing | Bash | **No — it removes the prompt** | Grant applies to the model | n/a |
| Hook `block()` → exit 2 / `permissionDecision: 'deny'` | Bash | **No — it denies the agent; nobody is asked** | No | Asserted in-repo (`block-deploy.mjs:3`); **undocumented** |
| `permissions.ask` rule | **Bash only** | **Yes — prompts on the matched argv** | No | **Yes — documented** (`permission-modes.md`) |
| `confirmOrExit` in the user's terminal | Bash | Yes | **Yes, via `--yes`** — see PM-4 | Unaffected (CLI-side) |
| MCP prompt (`/` menu) | MCP | Yes, human-initiated by construction | **No** — an agent cannot fetch a prompt | n/a; surfaced in 1 of 4 prior host sessions |
| Plugin slash command (`commands/release-create.md`) | Bash | Yes — the human types it | **No** | n/a |
| Host's default Bash permission prompt | Bash | **Yes — names the exact argv** | No | **No** — bypass is defined by suppressing it |

**A `Bash(...)` ask rule does not gate MCP tool calls.** Under Option B′ the **primary** path is the MCP
tool `setup-deps-install`, which never goes through Bash — so revision 2's Phase 3(a) rule covered only
the *fallback* path (a human or agent shelling out) and left the primary path ungated. Layer (ii) is
therefore split by path, below, and Phase 3 now writes **both** an MCP-scoped and a Bash-scoped rule.

**MCP ask-rule syntax — VERIFIED** (`permissions.md`). Rules address MCP tools as
`mcp__<server>__<tool>`, so `mcp__infra-kit__setup-deps-install` names exactly that tool;
`mcp__infra-kit` or `mcp__infra-kit__*` would cover the whole server. One granularity limit matters
here: **argument matching is impossible in a settings file** — *"When Claude Code loads a settings file,
it skips any `mcp__` rule that has parentheses"*, listing the skipped rule in the invalid-settings dialog
and in `claude doctor`. Parameter matching exists only as a deny via the `--disallowedTools` CLI flag. So
an MCP ask rule is **all-or-nothing per tool**: it cannot ask only for the dangerous recipes. That is
acceptable because §5.2 already refuses those by computation, but it is why the rule cannot replace the
predicate.

**Procedural rule, adopted after this loop:** *no authorization channel enters the design until its
primary documentation has been read.* Three channels were asserted and then corrected —
`allowed-tools` (R1), the `bypassPermissions` blanket claim, and the Bash-rule/MCP-path conflation —
before `requiresUserInteraction` and the MCP rule syntax were verified against `mcp.md` and
`permissions.md`. The cost of each correction was a redesign, not an edit.

Three conclusions.

1. **The human-in-the-loop channel already existed and Phase 3 was the only thing that would have
   destroyed it.** An agent proposing `Bash(infra-kit setup-deps-install gh)` with **no** grant gets the
   ordinary permission prompt, which shows the human the argv and takes their answer. That is P1. Ship
   no grant.
2. **Two mechanisms prompt a human and survive `bypassPermissions` — one per path.**
   **MCP path — `_meta["anthropic/requiresUserInteraction"]: true`, VERIFIED against primary docs.** An
   MCP server sets it on the tool's `tools/list` entry; the value must be JSON `true`. It is listed under
   "Actions no mode auto-approves" — *"Tools that require user interaction: the built-in
   `AskUserQuestion` tool and MCP tools marked `requiresUserInteraction`"* — and *"the actions no mode
   auto-approves still prompt in this mode"* (`permission-modes.md`). Claude Code *"shows the tool's
   permission prompt on every call"*, offers no "don't ask again", and **allow rules do not skip it**
   (`mcp.md`). **This is a genuine human gate at the MCP boundary — the thing this review loop had
   concluded did not exist.**
   Four caveats, all documented, and the first is why it does not displace the computed refusal:
   **(i) it requires Claude Code v2.1.199+, and "earlier versions ignore it and apply the standard
   permission flow"** — it is a Claude-Code `_meta` extension, not an MCP-spec guarantee, so any other
   host ignores it too: **it fails OPEN, silently.** (ii) `dontAsk` mode **denies** rather than prompts.
   (iii) Under `--permission-prompt-tool`, an `allow` is converted to a deny. (ii) and (iii) are an
   **availability** property, not a safety one: install and update are simply unavailable over MCP in
   those contexts, with the printed argv and the CLI as the fallback (§5.6). (iv) The
   Agent SDK's `canUseTool` callback does receive and may approve these calls.
   **The failure modes split cleanly: it fails CLOSED where it is honoured and OPEN where it is not** —
   which is precisely why it supplements the computed refusal instead of replacing it. A reported regression
   (anthropics/claude-code#58757) claims bypass mode hard-blocks rather than prompts — issue tracker, not
   docs; carried as a watch item, and it fails in the safe direction.
   **Bash path — a `permissions.ask` rule.** Ask rules "prompt for confirmation whenever Claude Code
   tries to use the specified tool" (`permissions.md`) and sit under the same "no mode auto-approves"
   list. It is a `permissions` **rule**, in the block this repo already uses for its six `deny` entries,
   so it depends on no undocumented mechanics. There is no `ask` rule in this repo yet. **It does not
   gate the MCP path.**
   **An ask rule is not a hook deny, and the plan must not conflate them:** a hook `block()` writes to
   stderr and exits 2 (`hooklib.mjs:50-53`) — it *refuses the agent without asking anyone*. Different
   products. Two things stay **undocumented and must not be built on**: hook `permissionDecision: "ask"`
   is not a documented value, and hook **deny decisions** under `bypassPermissions` are undocumented
   (the docs cover deny *rules*) — so `block-deploy.mjs:3`'s "holds under bypassPermissions" is an
   in-repo assertion past the documented surface, as is exit-2 blocking in that mode.
3. **Layers, ranked by what travels with the binary:**
   **(i-a) code-side refusals** — `isMcpMode()`, the risk predicate, `unknown → print`;
   **(i-b) `_meta["anthropic/requiresUserInteraction"]` on install/update** — ranked *alongside* (i-a),
   not below it, because it has layer i's defining property: it lives in our own server registration and
   therefore **ships with the binary**, while also prompting a human in every mode — which no other
   code-side mechanism does. It is additionally **immune to the grant problem that killed Phase 3**:
   allow rules cannot suppress it, and `dontAsk` fails *closed*, to deny;
   **(ii) `permissions.ask` rules** on `mcp__infra-kit__setup-deps-install` / `…-update` **and**
   `Bash(infra-kit setup-deps-install:*)` / `…-update:*` — host config, does not travel; ahead of the
   hook deny because **an ask rule asks a human while a hook deny refuses the agent without asking
   anyone**;
   (iii) the `block-deploy`-style hook deny, as defence in depth **only**; (iv) the slash command;
   (v) printed argv.
   **(i-a) remains the fail-closed floor**, and (i-b) does not replace it: the annotation degrades
   silently below Claude Code v2.1.199 and is ignored entirely by non-Claude-Code hosts, so a control
   that ships *and is honoured* inside the CLI is still required. The two are complementary, not
   alternatives — **the annotation supplies the human, the predicate supplies the guarantee.**
   Layers ii, iii and iv live in `$CLAUDE_PROJECT_DIR/.claude/` and do **not** travel — the machine
   being set up is precisely the one with no `.claude/settings.json` yet. Layer i-b travels but fails
   open on an unknown host. Only layer i-a is honoured by construction on every host and in every mode,
   which is why it is the floor — not any claim that prompts are impossible.
   *(Architect dissent: §3a/§3f ranked the hook deny first, its deciding property being
   `block-deploy.mjs:3`. That property is undocumented, and the mechanism denies rather than asks; the
   `ask` rule has the documented version of the property the architect wanted, and asks.)*

## 3. RALPLAN-DR summary

### Principles

- **P1 — Authorization comes from a human seeing the argv, or from a computed refusal; never from a
  token.** Round 2 of the confirm gate is agent-satisfiable, so the gate is a speed bump.
- **P2 — Exposure is bounded by a tool's own invariants, not by whether it mutates.** The catalog's
  actual rule (R2), enforced at `command-catalog.test.ts:233-249`.
- **P3 — Absence beats a flag** for anything that must never be exposed (`env-token-*` carries no
  `mcpTool` at all). Applies to the recipes we bar, not to the tool as a whole.
- **P4 — A guessed install is worse than a printed one.** Inherited from `install-manager`'s `unknown`
  branch; it must be *tested*, or it degrades to advice.
- **P5 — One list of probe argv.** `doctor` already probes four of the five.

### Decision drivers

1. **Is the refusal computed?** — a computed refusal is the only control honoured on every host and in
   every mode. **The claim that the MCP boundary has no human-authorization channel is now FALSE for
   Claude Code ≥ v2.1.199**, where `requiresUserInteraction` prompts on every call in every mode and
   allow rules cannot suppress it. What remains true, and is what this driver actually rests on, is that
   the channel is **host-specific and version-gated**: it degrades silently on older Claude Code and is
   ignored outright by every non-Claude-Code host, while a `permissions.ask` rule lives in project
   config the machine being set up may not have. Independence from the host — not the absence of any
   prompt — is why the computed refusal is the floor.
2. **Does the surface keep the agent on the audited path?** The agent already holds `Bash` and can run
   `brew install gh` or `curl … | bash` today. Barring the MCP tool removes the **audited** path — pinned
   argv from a reviewed table, `cwd: homedir()`, `packageManagerInstallEnv`, refusal on `unknown`,
   refusal on manager mismatch, scrubbed child env, structured logging — **not the capability**. This
   argument went unanswered in revision 1 and is the strongest one against the verb axis.
3. **Is the blast radius bounded per recipe?** Exactly one of the eight recipes is genuinely dangerous.

### Options

**Option A — CLI-only, no MCP surface.** *Pros:* strongest guarantee. *Cons:* the agent cannot even
report that `gh` is missing; and per driver 2 it pushes the agent to raw `Bash` with none of the
controls. Strictly worse than B on the axis it claims to win.

**Option B — read-only status on MCP; install/update CLI-only** (revision 1's choice). *Pros:* most
restrictive. *Cons:* rests on the now-false P2; bars four safe operations to contain one dangerous one;
maximally exposed to driver 2. Survives only for the two bootstrap recipes.

**Option B′ — risk-axis: expose status, install and update; a computed predicate decides which recipes
may execute.** ⬅ **RECOMMENDED**
*Pros:* refuses the dangerous recipes **by computation** rather than by prose, so the refusal holds on a
bare machine that carries no `.claude/` config at all; keeps the six safe recipes on the audited path; is responsive to
what the user asked for; and overturns **zero** existing comments — `self-update` stays barred because
it mutates the running CLI, `env-token-*` because credentials are a different class, `doctor --fix`
because it is host-inspecting, `release-deliver` because prod is irreversible, and the brew bootstrap
stays barred by predicate. Directly analogous to `worktrees-remove`, exposed on exactly this reasoning.
*Cons:* the predicate is new code and a four-way conjunction with a dead term is indistinguishable from
a three-way one (mitigated by per-conjunct mutation tests); a bug in `identify()` widens what executes
(PM-2); and it accepts that an agent can install `gh` without a human, which is a real, deliberate
increase over today.

**Option D — elicitation `formProvider`.** **INVALIDATED on evidence** (finding D).

**Option E — expose install/update with no predicate, relying on the confirm gate.** **REJECTED.** The
gate is agent-satisfiable and `command-catalog.ts:660-662` states the annotations are advisory and that
the spec forbids treating them as security. E without a computed refusal has no control at all.

## 4. Pre-mortem

**PM-1 — the brew sudo-timestamp lottery.**
*Mechanism:* the bootstrap reached non-interactively. `install.sh:118-127` sets `NONINTERACTIVE=1` from a
non-TTY **or from `$CI` on a real TTY**; `have_sudo_access` then runs `sudo -n -l mkdir`. Success depends
on a cached sudo timestamp from an unrelated command — and this repo has one (`sudo <node> <cli.js>
service install` for portless :443). `trap sudo -k EXIT` then clears it, so the retry differs again.
*Blast radius:* a half-created `/opt/homebrew` with root-owned directories on a machine that can no
longer `brew install` without manual `chown`.
*Mitigation:* the risk predicate refuses the bootstrap on two conjuncts (needs sudo; fetches a script
over the network) — a **computed** refusal, not a guard. Plus a scrubbed child env (§5) removing `CI`,
`NONINTERACTIVE`, `INTERACTIVE`, `HAVE_SUDO_ACCESS`, `SUDO_ASKPASS`. We never set `NONINTERACTIVE`.

**PM-2 — detection false-positive creates a split-brain install.**
*Mechanism:* `identify()` misreads a bin path. An `aws` from the shell script lives at
`$HOME/.local/bin/aws` → `$HOME/.local/share/aws-cli/…` — not a keg, not an npm prefix, so it must
resolve `unknown`. A heuristic resolving `homebrew` runs `brew upgrade awscli`, installing a **second**
aws into `/opt/homebrew/bin`; PATH order then decides which binary `aws --version` reports, including in
`doctor`. Symmetrically, `gh` under a `node` keg is the false positive `isBrewKegOf` exists to prevent.
*Blast radius:* two installs of one tool, a version report that does not match the binary the user runs,
and an "update" that appears to do nothing.
*Mitigation:* per-tool `identify()` with an explicit `unknown` branch; `unknown → print, never execute`.
**With a mutation test** — nothing in revision 1 asserted the branch refuses to spawn, and P4's entire
weight sits on it. `unknown` also fails the predicate's "manager already present" conjunct, so the
refusal is doubly derived.

**PM-3 — the exposure set drifts.**
*Mechanism:* revision 1 proposed a prefix-scoped invariant (`cliName` starts with `setup-deps-`), which a
later rename to `deps-install` silently escapes.
*Mitigation:* **extend the existing tests**, which cannot be escaped: `command-catalog.test.ts:86-87`
asserts `toEqual([...EXPECTED_EXPOSED_TOOLS].sort())` and `toHaveLength(23)`; the fail-closed gate test
at `:233-249` reds any mutating+exposed tool that is neither gated nor allowlisted. Both must be updated
deliberately for Phase 2 to go green, which is the point.

**PM-4 — `--yes` defeats the CLI confirmation. NEW.**
*Mechanism:* `confirm-or-exit.ts:4-7`, verbatim: *"When `confirmedCommand` is truthy (CLI `--yes` or an
MCP call, which always injects `confirmedCommand: true`) the prompt is skipped and execution proceeds."*
So `infra-kit setup-deps-install brew --yes` runs with **no prompt**, and an agent holding `Bash` types
that as easily as the bare form. `worktrees-add`'s own MCP description already says the CLI confirmation
is auto-skipped for MCP calls — this is established behaviour, not a hypothetical.
*Blast radius:* the CLI fallback — the plan's last human channel — is agent-satisfiable in exactly the
way the confirm token is, which is why revision 1 rejected the token.
*Mitigation:* `setup-deps-install` / `setup-deps-update` **must not honour `confirmedCommand` for any
recipe the predicate classifies dangerous**. Those recipes are refused outright rather than prompted, so
there is no prompt to skip. Mutation-tested.

## 5. Design

### 5.1 The dependency model

`src/lib/dependency-registry/dependency-registry.ts` — pure data and pure predicates; no `fs`, no
`spawn`, no `process.env` reads, matching `install-manager`'s discipline.

`DependencySpec` carries **five separate name fields**, because for these tools the identifiers diverge
and one `packageName` would *generate* PM-2's bug (`brew upgrade aws` — a formula that does not exist):

| tool | `binName` | `brewFormula` | `brewInstallSpec` | `kegName` | `npmPackage` |
|---|---|---|---|---|---|
| aws | `aws` | `awscli` | `awscli` | `awscli` | — |
| doppler | `doppler` | `doppler` | `dopplerhq/cli/doppler` | `doppler` | — |
| gh | `gh` | `gh` | `gh` | `gh` | — |
| portless | `portless` | — | — | — | `portless` |
| brew | `brew` | — | — | — | — |

Plus `probeArgv`, `versionFrom(stdout)`, `platforms`, `prerequisites`, `identify(binRealPath, env)` →
manager classification with an explicit `unknown` branch, and `recipesFor(manager)`.

Each **recipe** returned by `recipesFor` additionally carries two literals — **`needsSudo: boolean`** and
**`fetchesNetworkScript: boolean`** — set in the registry, never derived from a probe. They are the two
static conjuncts of §5.2, and the non-circularity argument there depends on them being recipe-level
literals rather than anything detection produces.

Ordering is a topological sort: `gh` and `doppler` require `brew`; `doppler` additionally requires
`gnupg` (binary signature verification — a real prerequisite, ordered, not assumed); `aws` and
`portless` have none.

### 5.2 The risk predicate — the control honoured on every host and in every mode

A recipe is **MCP-executable** iff, as a *checked property computed from §5.1 and the probe result*:

> requires no sudo **∧** fetches no script over the network **∧** targets a manager that is already
> present **∧** that manager currently owns this binary (or the binary is absent and the manager is the
> canonical one for it)

**Is the predicate circular — refusing the dangerous recipes because we labelled them dangerous?**
Partly, and the circularity is confined to the harmless side. The first two conjuncts are properties of
the **recipe**: static registry literals that no probe touches. **Both dangerous recipes fail on those
two**, so the bootstrap refusals never depend on detection being right. The last two consume
`identify()` output, which is where PM-2 lives — but a misdetection there can only substitute **one safe
recipe for another** (`brew upgrade awscli` against a script-installed aws), never promote a
sudo-requiring or network-fetched recipe into the executable set.

**Design requirement, stated structurally rather than temporally — a pure conjunction is
order-independent, so "evaluated first" would guarantee nothing: the two static conjuncts are applied
UNCONDITIONALLY to whichever recipe `recipesFor` selected.** No branch may make `needsSudo` or
`fetchesNetworkScript` contingent on `identify()`'s output, on the manager, or on probe state. That is
the property that actually holds, and it is what makes detection able only to narrow the executable set
and never widen it. It is testable as written, and gets its own mutation (§8, #6).

| recipe | outcome |
|---|---|
| `brew install gh` / `brew install gnupg` → `brew install dopplerhq/cli/doppler` | executable |
| `brew upgrade <formula>` (gh, doppler, awscli) | executable |
| `npm install -g portless` | executable |
| `aws update` | executable |
| Homebrew bootstrap (`curl … install.sh`) | **refused, printed** — fails *no sudo* and *no network script* |
| aws first install (`curl … \| bash`) | **refused, printed** — fails *no network script* |
| anything on `unknown` | **refused, printed** — fails *manager already present* (P4) |

Not a hand-set boolean per recipe: every conjunct is derived, and each gets its own mutation test.

### 5.3 Module layout

- `src/lib/dependency-registry/` — the table and the predicate. Pure.
- `src/lib/dependency-probe/` — injected `runCommand`, `resolveBinPath`, `realpath`; returns
  `DependencyState { id, present, onPath, binRealPath, version, manager, stale }`. `present` and `onPath`
  are separate fields (finding A).
- `src/lib/dependency-install/` — the **sole spawner**. Owns the `isMcpMode()` refusal, the predicate
  check, the `confirmedCommand` refusal (PM-4), the child-env scrub, `cwd: homedir()`,
  `packageManagerInstallEnv(env)`, and the never-retry-with-sudo rule.
- `src/commands/setup-deps-status|setup-deps-install|setup-deps-update/{index.ts,<name>.ts}`

Three top-level sibling commands, per the standing rule and the `env-token-*` / `worktrees-*` shape.

### 5.4 `install-manager` seam — additive only

Revision 1's "one field, not a rewrite" was wrong: `PACKAGE_NAME` is baked into module-level constants
(`install-manager.ts:14` `LATEST`, `:114`, `:179-199` `WRAPPER_MATCHERS`), so parameterizing means
converting both matcher arrays into factories — a reshape of a hot, table-tested module.

Instead: **export `isWithin`, `hasSegment`, `isBrewKegOf`, `npmPrefixFromSelfPath`** from
`src/lib/install-manager/index.ts` (which today exports exactly four symbols). Zero behaviour change,
trivially reverted. **`detectInstallManager` is left alone** — it answers "how do I update *myself*",
and the registry never asks that, since §5.1 owns per-tool recipes. `identify()` composes the newly
exported predicates.

### 5.5 Relationship to `doctor` — shared, one direction, in Phase 1

The registry owns probe argv; `doctor` consumes it, never the reverse, and never imports the recipes.
`doctor` keeps its check **names**, so `report.ts`'s `SECTION_MEMBERS` (`:60-85`), `DOCTOR_CHECK_NAMES`
(`:109`) and `FIXABLE_NAMES` (`:119`) are untouched and the change is a mechanical argv substitution
inside `doctor.ts:1385-1420`. Because that risk is zero under this design, revision 1's Phase 4
deferral had no cost basis: **it folds into Phase 1.**

Two corrections: the duplication is **four** probes, not three — `portless installed` is a real check
(`report.ts:79`). And `brew` is probed by nobody today, so the registry's brew probe is **new surface,
not unification**.

`setup-deps-status` is not a `doctor` clone: `doctor` answers "does this exit 0"; the status surface
answers "which manager owns this binary, what version, is it stale, and what is the exact argv to fix
it".

### 5.6 Catalog wiring

```
{ cliName: 'setup-deps-status',  menuGroup: 'setup', mcpTool: setupDepsStatusMcpTool,
  mcpExposed: true,  mutating: false, groupPath: ['setup-deps-status'] },
{ cliName: 'setup-deps-install', menuGroup: null,    mcpTool: setupDepsInstallMcpTool,
  mcpExposed: true,  mutating: true,  groupPath: ['setup-deps-install'] },
{ cliName: 'setup-deps-update',  menuGroup: null,    mcpTool: setupDepsUpdateMcpTool,
  mcpExposed: true,  mutating: true,  groupPath: ['setup-deps-update'] },
```

`menuGroup: null` on install and update is the **default, not a fallback**, per `self-update`'s two-part
reasoning asserted at `command-catalog.test.ts:157-167` and the zero-flag palette dispatch at
`run-session.ts:199`.

Install and update are mutating and exposed, so `command-catalog.test.ts:233-249` requires either
`requiresHumanConfirm` or allowlist membership. They take **`requiresHumanConfirm: true` and are NOT
added to `LOW_RISK_MUTATING_ALLOWLIST`** — the allowlist asserts low risk, which would be a false claim
here. The gate is not the control (finding D); the predicate is. The gate is the sanctioned way to
satisfy the fail-closed test without widening the escape hatch.

Budgeted wiring revision 1 omitted, each a hard failure:
- **`MCP_TOOL_PRESENTATION` rows for all THREE tools** (`command-catalog.ts:573`) — `getExposedMcpTools`
  **throws at registration** without one (`:678-683`). Three rows, not one: `openWorld` is *declared*,
  never derived, because an import-graph derivation produces false negatives on exactly the tools that
  reach the network through `zx` (`command-catalog.ts:562-571`), so each row carries its own call-site
  citation. Values: `setup-deps-status` → **`false`** (see `stale` below); `setup-deps-install` and
  `setup-deps-update` → **`true`**, cited to the recipe rows that download — `brew install` / `brew
  upgrade` fetch formulae and bottles, `npm install -g` fetches from the registry, and `aws update`
  fetches an upstream build.
- `EXPECTED_EXPOSED_TOOLS` plus `toHaveLength(23) → 26` — three new exposed tools, so three rows above.
- **`_meta: { "anthropic/requiresUserInteraction": true }` on `setup-deps-install` and
  `setup-deps-update`** — layer i-b, and the only human gate that covers the MCP path. Not on
  `setup-deps-status`. The value must be the JSON boolean `true`; any other value is ignored.
  **SDK support VERIFIED, no workaround needed:** `@modelcontextprotocol/server@2.0.0`'s `registerTool`
  config accepts `_meta?: Record<string, unknown>` on the **preferred, non-deprecated** Standard Schema
  overload (`dist/createMcpHandler-CLhGwQTn.d.mts:3300-3308`) — the exact overload
  `src/mcp/tools/index.ts` already lands on via `z.object(...)`. So this is a carrier field on
  `CatalogMcpTool` plus one pass-through at the single `server.registerTool` call site, beside
  `withConfirmToken`. Assert its presence in the e2e `tools/list` snapshot: a silent drop is invisible at
  runtime, because a host that does not honour it behaves identically to one where the field was never
  sent.

  **Two gates fire in series on the same call, and that is intended — neither is redundant.** They live
  on different sides of the wire and answer different questions. **Order:** (1) the host sees the
  annotation and prompts the *human* before the `tools/call` request is ever sent; (2) the request
  reaches our server, `createToolHandler` returns the round-1 `confirmation_required` soft-stop; (3) the
  agent re-calls with the `confirmToken`; (4) **the host prompts the human again**, because the
  annotation prompts on *every* call and offers no "don't ask again"; (5) the handler runs. So a
  successful install costs the human **two** prompts. That is a real UX cost and should be recorded as
  expected rather than filed as a bug. The gate is not kept for redundancy: it is what
  `command-catalog.test.ts:233-249` requires of any mutating exposed tool that is not on
  `LOW_RISK_MUTATING_ALLOWLIST`, and it is the only one of the two that exists on hosts which ignore the
  annotation. If the double prompt proves intolerable in practice, the resolution is to argue these two
  tools onto the allowlist — a deliberate, greppable edit — not to drop the annotation.

  **Availability, not safety:** a flagged tool is **denied** in `dontAsk` mode and under
  `--permission-prompt-tool` (an `allow` there is converted to a deny). So `setup-deps-install` and
  `setup-deps-update` are simply **unavailable over MCP in those contexts** — intended behaviour, not a
  defect; the fallback is the printed argv and the CLI. **The annotation's failure modes split cleanly:
  it fails CLOSED where it is honoured** (`dontAsk`, `--permission-prompt-tool` → deny) **and OPEN where
  it is not** (Claude Code < v2.1.199, non-Claude-Code hosts → ignored silently). That asymmetry is
  exactly why the computed refusal stays the floor.
- **`EXPECTED_GATED_TOOLS`** (`command-catalog.test.ts:225`) is asserted exhaustively against every
  exposed tool carrying `requiresHumanConfirm`, so both new names must be added or Phase 2 cannot go
  green.
- Any new `@inquirer` picker must sit inside `withEscape(...)`, or
  `src/lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts` reddens — it is a structural AST
  sweep, all-or-none, and has already caught `worktrees-add`.

**`stale` is decided before Phase 1, because it determines the status tool's `openWorld`:** a
**registry-pinned floor version** — pure, no network, `openWorldHint: false`, no hang risk in the
long-lived MCP server. An upstream check would mean network calls, a timeout, and a cache; deferred to a
follow-up. Install and update are `openWorld: true` regardless of that choice — they download by
definition.

## 6. Sudo and non-interactivity

The MCP refusal keys on **`isMcpMode()` alone** (R3). `process.stdin.isTTY` is retained **only** as a
human-presence hint on the CLI path, labelled as such — and it is defeated by `CI=1`, which flips
`install.sh` non-interactive from a real terminal (`install.sh:118-121`), so it is a hint and never a
control.

`dependency-install` scrubs the brew child env of `CI`, `NONINTERACTIVE`, `INTERACTIVE`,
`HAVE_SUDO_ACCESS` and `SUDO_ASKPASS` — a design requirement, not a test detail, since each is a
separate documented path into a non-TTY sudo attempt (`install.sh:118-125`, `:240-249`).

Per tool: **brew** bootstrap — refused by predicate on MCP; on the CLI it runs only where a human can
answer sudo, and we never set `NONINTERACTIVE`. **aws** — user-scope path needs no sudo and is
non-interactive-safe, but is still a network-fetched script, so first install is refused on MCP while
`aws update` is executable; we never pass `--system`; status reports *installed but not on PATH* rather
than a failed install. **gh** / **doppler** — `brew install`, no sudo, `longRunning: true`. **portless** —
`npm install -g portless`, sudo only if the prefix is not user-writable, and we **never auto-retry with
sudo**; inherits `cwd: homedir()` (so no repo's `.npmrc` can redirect `registry=` and run that package's
lifecycle scripts) and `packageManagerInstallEnv(env)`.

`confirmOrExit` remains the last thing before a spawn with nothing acquired before it (it
`process.exit(0)`s on decline and skips every `finally`) — and it is **not consulted at all** for a
predicate-refused recipe (PM-4). Printed argv reuses `formatUpdateCommand` (`install-manager.ts:143-151`)
so it is copy-pasteable, and honours the standing rule that printed portless commands are
`<node> <abs cli.js>`.

## 7. Phases

Each phase names the literal command to run and the observable that distinguishes pass from fail.

**Phase 0 — additive exports.** Export the four path predicates from `install-manager/index.ts`.
*Verify:* `pnpm --filter infra-kit run test src/lib/install-manager`. *Acceptance (non-vacuous):* new
table tests exercising each of the four predicates against the §5.1 five-name matrix — including
`isBrewKegOf('/opt/homebrew/Cellar/node/…/bin/gh', 'gh') === false` and
`isBrewKegOf(awsScriptPath, 'awscli') === false`. Red looks like: a predicate accepting a path from a
different tool's row.

**Phase 1 — registry + probe + `setup-deps-status` + doctor unification.** Includes former Phase 4.
*Verify:* `pnpm --filter infra-kit run test src/lib/dependency-registry src/lib/dependency-probe src/commands/doctor`, then `pnpm run qa`.
*Acceptance, split:* **(a) CI, fixture-driven** — the §8 tables pass; `setup-deps-status` appears in
`tools/list` with `readOnlyHint: true` and `openWorldHint: false`; the four probe argv literals appear in
**exactly one module**, asserted structurally (replacing revision 1's near-vacuous "byte-identical
`SECTION_MEMBERS`" criterion, which only asserted a file was not edited); `doctor`'s check names are
unchanged and `report.ts`'s two tests pass unedited. **(b) Host run, recorded** — the expected answer for
all five tools is **written down before the run**, then compared. Not a CI criterion; CI has no brew.

**Phase 2 — `dependency-install` + the risk predicate + install/update, exposed.** ← **minimum useful
slice** (0+1+2); this is where the user's request is satisfied.
*Verify:* `pnpm --filter infra-kit run test src/lib/dependency-install src/lib/command-catalog src/mcp`, then `pnpm run qa`.
**Layer i-b ships HERE, not in Phase 3.** Phase 2 is the phase that makes install/update MCP-reachable,
so it is the phase that must carry the only human gate on that path: **declare
`_meta["anthropic/requiresUserInteraction"] = true` on `setup-deps-install` and `setup-deps-update`**
(documented to prompt on every call in `acceptEdits`, `auto` and `bypassPermissions`, with allow rules
unable to skip it — `mcp.md`; silently ignored below Claude Code v2.1.199 and on non-Claude-Code hosts,
so it is a gate where honoured and a no-op elsewhere, never a substitute for §5.2). An earlier draft
left the annotation's `tools/list` assertion in Phase 3 while calling 0+1+2 the minimum useful slice —
which meant shipping on schedule would have exposed install/update **with no human gate at all**, the
exact outcome this design exists to prevent. A gate whose acceptance lives in a later phase is a gate
that can be skipped by shipping on time.
*Acceptance:* the two bootstrap recipes are refused **with the argv printed** under `isMcpMode()`; the
`unknown` path never spawns; `confirmedCommand: true` does not execute a dangerous recipe; **`_meta`
carrying `anthropic/requiresUserInteraction: true` is present on both tools — and on neither
`setup-deps-status` nor any other tool — in the e2e `tools/list` snapshot**; every mutation
in §8 reddens its assertion.
**Real-install step — target `portless`**, measured absent on this host while `brew`, `aws`, `gh`,
`doppler` and `gpg` are all present. Earlier drafts named `gh` and then `gnupg`; both are installed here
(`gnupg` at `/opt/homebrew/Cellar/gnupg/2.5.20`), so both were un-runnable for the same reason, and
`gnupg` additionally has no `DependencySpec` row of its own — its binary is `gpg`, its formula `gnupg`.
`portless` is the right target on three counts: it is genuinely absent, its recipe
(`npm install -g portless`) passes all four conjuncts so it exercises the *executable* path rather than a
refusal, and its undo — `npm uninstall -g portless` — removes nothing that was working. **Split the
criterion:** the CI-runnable half is a **dry run** (predicate verdict + resolved argv + intercepted
spawn, no process started); the real install is a **manual step**, run once, with the undo executed and
both recorded. Note the dependency on Q1: if the answer there is that a global portless is not wanted,
this acceptance target moves to a container with a genuinely absent tool.

**Phase 3 — host boundary and plugin surface (layers ii and iv, and one negative deliverable).** Layer
i-b landed in Phase 2, by design.
(a-ask) **Add `permissions.ask` rules covering BOTH paths** to `.claude/settings.json`, in the same
`permissions` block as the six existing `deny` entries — layer ii. Four entries:
`mcp__infra-kit__setup-deps-install`, `mcp__infra-kit__setup-deps-update`,
`Bash(infra-kit setup-deps-install:*)`, `Bash(infra-kit setup-deps-update:*)`. **A `Bash(...)` rule does
nothing for MCP tool calls and vice versa** — writing only the Bash pair was revision 2's gap. Syntax
verified (§2): MCP rules are `mcp__<server>__<tool>` and **must carry no parentheses**, since Claude Code
skips any parenthesised `mcp__` rule at settings load and reports it in `claude doctor`; argument
matching on an MCP tool exists only as a deny via `--disallowedTools`. So the MCP rule is all-or-nothing
per tool, which is fine because §5.2 already refuses the dangerous recipes by computation. These are
*asks*, deliberately not hook denies — a hook `block()` refuses the agent without asking anyone
(`hooklib.mjs:50-53`).
(a1) **`init` writes it, at project scope only.** `init.ts:315` already writes
`path.join(root, '.claude', 'settings.json')` for the plugin pointer, so the file and the consent are
established. `init.ts:301-313` justifies that pointer's no-opt-out design on the grounds it is *inert if
wrong*; an **ask** rule qualifies on the same test — its failure mode is one extra prompt, never a
silent refusal — which is exactly why an ask rule may ship this way and a `deny` may not. **Never
user-scope**, and never without the repo already being an infra-kit repo (`init.ts:305-308` refuses to
write `.claude/` outside one).
(a2) **`doctor` gains a `setup-deps ask rule present` row**, so absence is visible rather than assumed —
this is the layer that does not travel, so the check is the only thing that notices. Budget the
`SECTION_MEMBERS` (`report.ts:60-85`) and `DOCTOR_CHECK_NAMES` (`:109`) edits, without which two tests
fail, and add it to `FIXABLE_NAMES` (`:119`) so `doctor --fix` installs the rule.
(b) Ship **no** `allowed-tools` grant for install/update — an ungranted Bash call gets the ordinary
permission prompt, and a grant is what removes it (R1).
(c) Add `setup-deps-install` and `setup-deps-update` to `MUTATING_INVOCATIONS`
(`plugins/infra-kit/__tests__/manifest.test.mjs:475`).
(d) If a plugin surface ships at all, make it a **slash command** modelled on
`plugins/infra-kit/commands/release-create.md` — no `allowed-tools`, human-typed by construction,
resource-first with an explicit direct-tool fallback — not a `SKILL.md`. Any skill that ships narrows to
`Bash(infra-kit setup-deps-status)` only.
*Verify:* `node --test plugins/infra-kit/__tests__/manifest.test.mjs`;
`pnpm --filter infra-kit run test src/commands/init src/commands/doctor src/mcp`; and **two** manual
sessions under `bypassPermissions` on Claude Code ≥ 2.1.199 — one where the agent calls the **MCP tool**
`setup-deps-install`, one where it proposes the **Bash** form — each of which must still raise a prompt.
Running only the Bash one is what revision 2's gap looked like.
*Acceptance:* U15 and U6 pass; no grant for any mutating invocation exists in the plugin; both manual
sessions prompt in default **and** bypass mode (the `_meta` snapshot assertion itself is Phase 2's, and
the MCP-path session here is what proves the declared field actually reaches a host); `init` on a fresh repo produces the ask rule and `doctor` reports it present, then reports
it absent once it is hand-deleted. Whether a hook deny ships later is a separate call —
`permissionDecision` under `bypassPermissions` is undocumented, so it is defence in depth at most.
*(Architect dissent: §3a/§3d/§3f proposed the hook deny as the primary host-boundary layer plus an MCP
prompt + resource pair. The `ask` rule is taken for the boundary because it is documented and asks
rather than denies; the slash command is taken for delivery because `release-create.md` is this repo's
**production** answer to the same problem and carries a fallback for hosts where resource tools do not
surface — prior sessions saw them in 1 of 4.)*

## 8. Test plan

**Unit (pure).** Registry: topological ordering (doppler → gnupg → brew); `platforms` gating; the
five-name matrix, asserting `brewFormula` for aws is `awscli` and `brewInstallSpec` for doppler is the
tapped form. Risk predicate: each of the four conjuncts independently falsified. `identify()`:
table-driven over five tools × npm-global prefix, brew keg (**including** the `gh`-under-`node`-keg and
`aws`-script shapes that must yield `unknown`), and not-found.

**Integration (fake spawner, real wiring).** `dependency-probe` with injected `runCommand`: version
parsing and the `present ∧ ¬onPath` case (finding A). `dependency-install` with an injected spawner:
the spawner is **never called** when `isMcpMode()` and the recipe is dangerous; never called on
`unknown`; never called when `confirmedCommand: true` on a dangerous recipe; `cwd === homedir()`; the
child env is `packageManagerInstallEnv`'s output; the brew child env contains **none** of `CI`,
`NONINTERACTIVE`, `INTERACTIVE`, `HAVE_SUDO_ACCESS`, `SUDO_ASKPASS`; no sudo retry on a simulated
`EACCES`. *Mocked:* every spawn and every fetch. *Real:* registry, ordering, predicate, argv
construction. No test in this suite runs `curl`.

**E2E.** `src/mcp/__tests__/mcp-stdio.e2e.test.ts`: all three tools in `tools/list`; a bootstrap-recipe
call returns a refusal with printed argv and the server spawns nothing.

**Mutation tests** (copy the `mcp-confirm-gate-mutation.test.ts` harness):
1. **Exposure invariant** — retargeted at `command-catalog.test.ts:86-87`'s allowlist plus the
   fail-closed gate test at `:233-249`, not a prefix rule (which a rename escapes).
2. **`isMcpMode()`** — neuter to `false`; "spawner never called" must redden.
3. **The `unknown` branch** — force `identify()` to return a concrete manager where the fixture says
   `unknown`; "never spawns on unknown" must redden. P4's entire weight is here.
4. **`confirmedCommand` refusal** — set it true on a dangerous recipe; the refusal assertion must redden
   (PM-4).
5. **One per predicate conjunct** — a four-way conjunction with one dead term is indistinguishable from
   a three-way one.
6. **Unconditional application of the static conjuncts** (§5.2). **Not a reorder** — a pure conjunction
   is order-independent, so reordering is a no-op that could never redden and would be a false green.
   The mutation is to make a static conjunct **conditional on detection**: e.g. skip the
   `fetchesNetworkScript` check when `identify()` returns `homebrew`, or read `needsSudo` from the probe
   result instead of the registry literal. The assertion must sweep **all five tools × every manager
   classification** (`npm`, `pnpm`, `yarn`, `bun`, `volta`, `homebrew`, `unknown`) and hold that no
   combination makes a `needsSudo` or `fetchesNetworkScript` recipe executable. A single fixture would
   pass a mutation that only misbehaves on one classification.

Revision 1's TTY mutation is **dropped**, along with its "if only one reddens, delete the second"
rationale: the two guards were never redundant, they were unequal, and that framing invites deleting the
sound one.

**Observability.** Log, at info, the resolved argv, the detected manager, and **which** refusal fired
(`isMcpMode` / predicate conjunct / `unknown` / `confirmedCommand`) — PM-1's nondeterminism is
undiagnosable otherwise. Never log the child environment.

**Gates.** Full `pnpm run qa` (sonarjs cognitive-complexity ≤ 15; tsc catches what vitest misses). A full
`qa` rewrites manifests and the vendor mirror — shasum before/after and diff before committing — and
`vendor check` runs first in root qa and is already red on HEAD.

## 9. ADR

**Decision.** Ship `setup-deps-status`, `setup-deps-install` and `setup-deps-update` as MCP-exposed
tools whose execution is bounded by a **computed risk predicate** (§5.2), which refuses the two
network-fetched bootstrap recipes and every `unknown` classification by computation. Install and update
**declare `_meta["anthropic/requiresUserInteraction"]: true`** — the only human gate on the primary
path, prompting on every call in every mode on Claude Code ≥ v2.1.199, and immune to allow-rule
suppression. They also carry `requiresHumanConfirm: true` to satisfy the fail-closed catalog test
without claiming low risk, and carry `menuGroup: null`. No `allowed-tools` grant ships for either verb;
`permissions.ask` rules cover both the MCP tool names and the Bash argv at the host boundary.

**Drivers.** (1) A computed refusal is the only control **honoured on every host and in every mode**.
The annotation also ships with the binary but is ignored below Claude Code v2.1.199 and on
non-Claude-Code hosts; a `permissions.ask` rule prompts in every mode but lives in project config the
machine being set up may not have yet. (2) The agent already holds `Bash`; barring the tool removes the audited path, not the
capability. (3) The catalog bounds exposure by a tool's invariants, not by the verb (R2) — `worktrees-add`
is exposed, ungated, and runs `pnpm install`.

**Alternatives considered.** A (CLI-only) — loses driver 2 outright. B (verb axis, revision 1's choice) —
rests on the false P2; survives only as the treatment of the two bootstrap recipes, which B′ reproduces
by computation. D (elicitation) — invalidated on evidence; degrades silently to the token gate. E
(expose with no predicate) — the gate is agent-satisfiable and the annotations are advisory by spec, so
E has no control at all.

**Why chosen.** It is the only option whose primary control travels with the binary, it pairs that with
`requiresUserInteraction` — which also travels and asks a human in every mode where it is honoured — and
it satisfies both halves of the request, detection *and* execution, without overturning a single
existing catalog comment.

**Consequences.** An agent can install `gh` without a human on any host where **neither** the annotation
nor an ask rule is in force: a host below Claude Code v2.1.199, or any non-Claude-Code MCP host, reached
over the MCP path with no `mcp__infra-kit__setup-deps-*` ask rule present. On Claude Code ≥ v2.1.199 the
annotation prompts in every mode including bypass, and an allow rule cannot suppress it. That residue is
a deliberate, argued increase over today, justified by
driver 2 and bounded by the predicate; it is the part of this decision most worth the user's attention
(Q2). `doctor` gains a registry dependency in Phase 1. The five recipes track
upstream installers and will drift; the registry being pure data keeps the drift to one file. `stale` is
a pinned floor, so the status tool never touches the network.

**Follow-ups.** Upstream version checking for `stale` (needs `openWorld: true`, a timeout and a cache). A
`block-deploy`-style hook deny for the bootstrap argv as defence in depth behind the Phase 3 ask rule —
not primary, since it does not travel with the binary and hook deny under `bypassPermissions` is
undocumented. User-scope `~/.claude/settings.json` would make the ask rule travel across every repo on a
machine and would close the layer-ii gap; it is a materially bigger act than project scope, so it is an
opt-in flag at most, never something `init` writes.

## 10. Open questions

**Q1 — portless: is `npm install -g portless` solving the problem you have?** It is a `node_modules`
dependency today and is **never on PATH under sudo** (`secure_path`); the codebase already prints
`<node> <abs cli.js>` via `formatPortlessCommand`. A global install does not change the sudo case. It
does help interactive use and other repos that do not depend on infra-kit — consistent with your choice
of ambient global resolution over pinning in hulyo/travelist, which may be the real motivation. If the
sudo case is the goal, this recipe should not ship.

**Q2 — verb axis or risk axis?** *Verb axis (B):* mutating commands stay off MCP; simplest to reason
about; but it bars four safe operations to contain one dangerous one, and since the agent already holds
`Bash`, it removes the audited path rather than the capability. *Risk axis (B′):* install and update are
exposed, and a computed predicate refuses the bootstrap recipes and every `unknown` — a refusal that
holds on a machine carrying no `.claude/` config at all. On Claude Code ≥ v2.1.199 the
`requiresUserInteraction` annotation additionally prompts a human before every install, in every mode;
Phase 3's ask rules cover the same ground wherever project config exists. The cost is that on an older
or non-Claude-Code host with no ask rule an agent can install `gh` without asking anyone, and a bug in
`identify()` widens what executes.
Both are defensible and neither overturns an existing comment. **I recommend B′; the call is yours.**

**Q3 — does `setup-deps` OWN the install method or ADAPT to what is already installed?** *Own:* one
canonical recipe per tool, reinstalling on mismatch — deterministic machines, but it will want to remove
someone's working `brew install awscli`. *Adapt:* follow whatever `identify()` reports and never
converge — safe, but two machines drift. §5.1 assumes **adapt, refuse on mismatch** (the mismatch also
fails the predicate's fourth conjunct); confirm or redirect.

**Q4 — is the MCP path's residual acceptable to you?** With `requiresUserInteraction` declared, a Claude
Code session at v2.1.199+ prompts you before any install, in every mode including `bypassPermissions`.
The residual is everything outside that: an **older Claude Code, or any non-Claude-Code MCP host**,
silently ignores the field, and there an agent can install `gh` or run `brew upgrade` with nobody asked.
The computed predicate still bars the two dangerous recipes there, so the residual is confined to the
six recipes classified safe — but it is real, it is the honest cost of Option B′, and it is your call,
not mine. If it is unacceptable, the fix is not more gates: it is Option B, and install/update go back to
CLI-only.
