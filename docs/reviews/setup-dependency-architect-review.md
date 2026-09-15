> Status: architect review of docs/archive/mcp/mcp-setup-dependency-plan.md — advisory, not authorization.

# Architect review — SetupDependency plan

Read-only pass. Nothing outside this file was edited. Every in-repo claim below was checked against
the working tree at `/Users/arthur/projects/infra-kit` (branch `main`, dirty from other work). External
claims were checked against the fetched artifact or the vendor's documentation, as noted.

Repo paths are relative to the repo root; CLI paths are relative to `apps/infra-kit/cli` unless the
path already begins with `apps/`, `plugins/`, or `.claude/`.

---

## 0. Verification of the plan's load-bearing claims

### 0.1 Claims that held

| Claim | Verdict | Evidence |
|---|---|---|
| Finding D — `buildFormOrGate` falls through to `buildConfirmGate` | **TRUE**, and the code says so in its own doc comment | `src/lib/tool-handler/tool-handler.ts:315-348`. The comment at `:315-318` reads: *"a provider that rejects, outruns its deadline, resolves `null`, or hands `elicit()` a shape it cannot express falls through to the gate here, with today's behaviour and no thrown error."* `resolveGateState` is at `:113`; the `form` row requires `canForm ∧ hasProvider ∧ formable` (`:117-126`) |
| No tool ships a `formProvider` | **TRUE** | `tool-handler.ts:24` ("Absent on every tool today"); zero `formProvider:` assignments anywhere under `src/commands/` |
| Finding B — Homebrew auto-sets `NONINTERACTIVE` on a non-TTY, then aborts under `sudo -n` | **TRUE** (the line is 127, not 126 — immaterial) | `install.sh:116-127` sets `NONINTERACTIVE=1` when `[[ ! -t 0 ]]`; `have_sudo_access()` `:235-267` appends `-n` under `NONINTERACTIVE` (`:244-247`), runs `sudo -l mkdir` (`:252`), and on macOS a non-zero result hits `abort "Need sudo access on macOS…"` at `:263`. `trap '/usr/bin/sudo -k' EXIT` at `:514-516`, conditional on the timestamp not already being active — exactly as described |
| The palette dispatches `[cliPath, ...groupPath]` with zero flags | **TRUE** | `src/lib/session/run-session.ts:199` |
| `MENU_GROUPS` carries a `setup` key | **TRUE** | `src/lib/command-catalog/command-catalog.ts:116` |
| The three restrictive precedents (`doctor` / `env-token-*` / `self-update`) read as quoted | **TRUE** | `command-catalog.ts:467-474`, `:506-527`, `:528-538` |
| `doctor`'s probe names match `SECTION_MEMBERS` | **TRUE** | `src/commands/doctor/doctor.ts:1385-1425` vs `src/commands/doctor/report.ts:60-73` |

The plan's §0 verification work is genuinely good. Findings A, B, C and D are each correct, each
correctly sourced, and finding D in particular is the kind of in-repo discovery that changes a design
rather than decorating it. What follows should be read against that baseline: the failures below are
concentrated in the claims §0 did *not* subject to the same standard.

### 0.2 Claims that broke

---

**F1 — CRITICAL. `allowed-tools` GRANTS permission. It does not surface it.**

This inverts the plan's entire authorization story.

Anthropic's documentation, verbatim:

> *"The `allowed-tools` field grants permission for the listed tools during the turn that invokes the
> skill, so Claude can use them without prompting you for approval. The grant clears when you send your
> next message, even though the skill content stays in context; invoking the skill again re-applies it
> for that turn. **It does not restrict which tools are available: every tool remains callable, and your
> permission settings still govern tools that are not listed.**"*

The plan's P1 states: *"Execution authority comes from a human, not from a token… Anything that mutates
the host needs a channel where a person sees the argv."* Option B (§1), Phase 3 (§5) and the ADR (§7)
all rest on the same sentence: *"a plugin skill narrows `allowed-tools` to the exact install argv, so
Claude Code's own permission UI shows the human the command and they approve it — a real
human-in-the-loop, per P1."*

That is backwards. Narrowing `allowed-tools` to `Bash(infra-kit setup-deps-install brew)` **removes**
the prompt for exactly that argv. Phase 3 as specified is not a human gate; it is a pre-approval for
`curl … | bash`.

Phase 3's acceptance criterion — *"a session run shows the host permission prompt naming the exact
command"* — cannot pass, because the grant is what suppresses that prompt.

Two further consequences the plan must carry:

- A skill is **model-invokable** via the Skill tool unless `disable-model-invocation: true` is also set.
  The plan never mentions that field. Without it, the grant is reachable without a human typing
  anything.
- The grant is **per-turn**, clearing on the user's next message. It is not even a stable audit record.

---

**F2 — CRITICAL, and it compounds F1. The §4 TTY guard makes the skill lane inert.**

Measured from inside an agent Bash tool on this host:

```
stdin.isTTY = undefined | stdout.isTTY = undefined | CI = undefined
```

`process.stdin.isTTY !== true`, so §4's second guard refuses **every** invocation the skill could ever
make. Combined with F1, **Option B degenerates to Option A + a read-only status tool + a markdown file
that can only ever print argv.** The plan's stated advantage of B over A — *"execution gets genuine
human approval through a channel that already exists in this repo"* — fails in both directions at once:
the grant removes the prompt, and the guard removes the execution.

The `plugins/infra-kit/skills/doctor/SKILL.md` citation is not evidence for the mechanism. Its
frontmatter reads:

```
allowed-tools: Read, Bash(infra-kit doctor), Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs *)
```

Every entry is read-only, so the pre-approval is harmless — which is precisely why that precedent could
never have revealed the grant-versus-prompt difference. The plan generalized from the one case where
the distinction is invisible.

---

**F3 — §3.3's "one field, not a rewrite" is wrong.**

`PACKAGE_NAME` is not a threaded parameter. It is baked into module-level **constants**:

- `src/lib/install-manager/install-manager.ts:14` — ``const LATEST = `${PACKAGE_NAME}@latest` ``,
  consumed by three `TREE_MATCHERS` rows and by `npmPrefixInstallCommand` (`:126`)
- `:114` — `npmPrefixFromSelfPath` tests `segments[nodeModules + 1] !== PACKAGE_NAME`
- `:179`, `:197`, `:199` — `WRAPPER_MATCHERS` is a module-level `Matcher[]` whose `updateCommand` values
  and `test` closures close over `PACKAGE_NAME`

Parameterizing means converting both matcher arrays from constants into `(packageName) => Matcher[]`
factories and turning `updateCommand` from a value into a computed one. That is a reshape of a hot,
heavily-commented, table-tested module — not a field addition.

Separately: `isWithin`, `hasSegment`, `isBrewKegOf` and `npmPrefixFromSelfPath` are **module-private**.
`src/lib/install-manager/index.ts:1` exports exactly four symbols — `detectInstallManager`,
`formatUpdateCommand`, `isLocalNodeModulesInstall`, `PACKAGE_NAME`. §3.3's *"reused as-is"* requires new
exports the plan does not budget.

---

**F4 — `packageName: string` conflates five distinct names, and Phase 0 would *generate* PM-2's bug.**

For these five tools the identifiers diverge:

| tool | binary | brew formula | brew install spec | keg dir | npm package |
|---|---|---|---|---|---|
| aws | `aws` | `awscli` | `awscli` | `awscli` | — |
| doppler | `doppler` | `doppler` | `dopplerhq/cli/doppler` | `doppler` | — |
| gh | `gh` | `gh` | `gh` | `gh` | — |
| portless | `portless` | — | — | — | `portless` |
| brew | `brew` | — | — | — | — |

A single `packageName` feeding `install-manager.ts:199`'s `['brew', 'upgrade', PACKAGE_NAME]` emits
`brew upgrade aws` — a formula that does not exist. Pass `awscli` instead and
`isBrewKegOf(binRealPath, 'awscli')` becomes correct while the binary name is now wrong for probing.
This is precisely the "detection produces a wrong install command" failure PM-2 exists to prevent,
manufactured by the plan's own Phase 0.

The plan is half-aware of this — §3.3 notes `isBrewKegOf` *"wants `doppler` (the keg name), not
`dopplerhq` (the tap)"* — but it treats a five-way name collision as a one-off footnote rather than as
a schema requirement.

The deeper point: §3.1 already gives each spec its own `recipesFor(manager)`, so the registry **never
consumes** `install-manager`'s `updateCommand`. The only thing it wants is the manager *classification*.
Generalizing `detectInstallManager` drags along a command-synthesis output the registry immediately
discards. **Phase 0 is the wrong seam.**

---

**F5 — PM-3's invariant is weaker than one that already exists, and is evadable by rename.**

`src/lib/command-catalog/__tests__/command-catalog.test.ts:85-86` already asserts an exhaustive
allowlist plus a count:

```ts
expect(exposedNames).toEqual([...EXPECTED_EXPOSED_TOOLS].sort())
expect(exposedNames).toHaveLength(23)
```

Any new exposure reddens that today, unconditionally. PM-3's proposal — *"every entry whose `cliName`
starts with `setup-deps-` and is not `setup-deps-status` must have `mcpTool === null`"* — is
**prefix-scoped**, so a later rename to `deps-install` silently escapes it, while the allowlist cannot
be escaped.

Extend the existing named tests instead:

- `:89-105` — the no-tool-at-all class, driven by `CREDENTIAL_WRITE_COMMANDS`; asserts
  `expect(entry?.mcpTool, …).toBeNull()` at `:103`
- `:148-167` — the `self-update` / `mcp` class; additionally asserts `menuGroup` is null at `:167`

The plan also omits a mandatory edit: `EXPECTED_EXPOSED_TOOLS` and `toHaveLength(23) → 24`, without
which Phase 1 cannot go green.

---

**F6 — `doctor` probes four of five, not three; and probes brew zero times.**

`portless installed` is a real check (`report.ts:79`, produced by `checkPortless()`), so §3.4's *"three
probe argv duplicated"* undercounts the scheduled debt. Conversely `brew` is probed by nobody: the only
`brew` strings under `src/` outside tests are `install-manager.ts:68-69` (a comment) and `:199` (the
self-update command). State plainly that the registry's brew probe is **new surface**, not unification.

---

**F7 — `CI=1` defeats the TTY guard for brew specifically.**

`install.sh:118-121` sets `NONINTERACTIVE=1` from `$CI` **regardless of TTY**. A developer with `CI`
exported — or any wrapper that sets it — hits PM-1's sudo-timestamp lottery *from a real interactive
terminal*, with the TTY guard fully satisfied. PM-1's mitigation is therefore incomplete as written.

§6's only env assertion is *"`NONINTERACTIVE` is absent from the brew child env."* It must also assert
absence of:

- `CI` (`install.sh:118-121`) — flips non-interactive even on a TTY
- `INTERACTIVE` (`:125`) — forces the interactive path with no TTY to answer the prompt, i.e. a hang
- `SUDO_ASKPASS` (`:240-243`) — switches to `sudo -A`, a third non-TTY sudo path
- **`HAVE_SUDO_ACCESS`** (`:249`) — honoured as a pre-set env var, short-circuiting the probe entirely

A **scrubbed child env for brew** is a design requirement, not a test detail.

---

## 1. Steelman the antithesis, and where I land

### The case against the plan, as strong as I can make it

**(a) It is not responsive.** The user asked for an MCP command that installs and updates. The plan
ships read-only detection on MCP and puts both verbs where the agent cannot reach them. §8's Q2 is
honest about the tension, but it still asks the user to ratify the planner's preference after the fact
rather than building the ask and flagging the risk alongside it.

**(b) The precedents are over-read.** The catalog holds no blanket "no host-mutating MCP tool" line.
`worktrees-remove` **is** exposed and deletes gitignored files, with the reasoning stated at
`command-catalog.test.ts:115-118`:

> *"worktrees-remove is exposed: git protects tracked work and the tool's own invariants (no MCP
> `all=true`, error on unmatched target) contain the residual gitignored-deletion risk."*

That is a live precedent for **exposing a destructive tool whose blast radius is bounded by its own
invariants** — a far closer analogue to `brew install gh` than `env-token-set` (writes an exfiltratable
credential) or `release-deliver` (irreversible prod delivery). The plan cites three restrictive
precedents and never engages the permissive one.

**(c) Refusing MCP exposure removes the audited path, not the capability.** The agent already holds
`Bash`; it can run `brew install gh` or `curl … | bash` today. An MCP tool would add: a pinned argv from
a reviewed table, `cwd: homedir()`, `packageManagerInstallEnv`, refusal on `unknown`, refusal on manager
mismatch, structured logging, and the confirm gate's round-trip. Pushing the agent to raw Bash gets
**none** of those. This is the single strongest argument for Option E, and the plan addresses it
nowhere — not in §1's option table, not in the pre-mortem, not in the ADR's alternatives.

**(d) Risk varies per tool, not per verb.** `brew install gh`, `brew upgrade doppler` and
`npm i -g portless` are all reversible. Exactly **one** of the five recipes is the dangerous one —
Homebrew's own bootstrap, which fetches a script over the network and needs root to create
`/opt/homebrew`. The plan's boundary bars four safe operations in order to contain one dangerous one.

**(e)** And per F1/F2, the compensating control offered in exchange is not real.

### Where I land

**Mostly with the plan's conclusion — brew's bootstrap must not be MCP-reachable — but its axis is
wrong and its justification is broken.**

I discount (a): "SetupDependency" is a capability description, not a wire-protocol requirement, and Q2
surfaces the tension legitimately. I weight (b), (c) and (d) heavily; (c) in particular goes unanswered
anywhere in the document, and it is the argument that makes Option E defensible rather than reckless.

Where I part company with the antithesis: the confirm gate genuinely is **not** authorization. Finding D
is verified (`tool-handler.ts:315-348`), and `command-catalog.ts:660-662` states that the annotations are
advisory and that the spec forbids a client treating them as security. So "token gate plus
`destructiveHint` is sufficient" is false as stated. What *is* sufficient for the four safe recipes is
not the gate — it is the **invariants**, exactly as with `worktrees-remove`.

Conclusion: **draw the line per-recipe, not per-verb.**

---

## 2. The real tradeoff tension, and what would flip it

### Primary tension — verb axis versus risk axis at the MCP boundary

The plan resolves it on the **verb**: read-only exposed, mutating not. It could defensibly resolve on
the **risk**: expose install/update, and let a registry-computed predicate decide which recipes execute.

What would have to be true to flip it: the registry must express, as a *checked property of a recipe*
rather than a hand-set boolean, the conjunction

> requires no sudo **∧** fetches no script over the network **∧** targets a manager that is already
> present **∧** that manager currently owns this binary (or the binary is absent and the manager is the
> canonical one for it)

Every conjunct is computable from what §3.1 and §3.2 already define. Under it:

| recipe | predicate | outcome |
|---|---|---|
| `brew install gh` | passes all four | MCP-executable |
| `brew install gnupg` → `brew install dopplerhq/cli/doppler` | passes all four | MCP-executable |
| `brew upgrade <formula>` | passes all four | MCP-executable |
| `npm install -g portless` | passes all four | MCP-executable |
| `aws update` | passes all four | MCP-executable |
| Homebrew bootstrap (`curl … install.sh`) | fails "no sudo" and "no network-fetched script" | refused, printed |
| aws first install (`curl … \| bash`) | fails "no network-fetched script" | refused, printed |
| anything on `unknown` | fails "manager already present" | refused, printed (P4) |

The MCP tool then refuses the dangerous recipes **by computation**, and `worktrees-remove`'s precedent
applies verbatim. This version is more responsive to the user, strictly safer than the status quo where
the agent reaches for raw Bash, and it overturns **zero** existing comments: `self-update` stays barred
because it mutates the running CLI, `env-token-*` stays barred because credentials are a different
class, `doctor --fix` stays barred, and the bootstrap stays barred by predicate rather than by prose.

**Re-pose Q2 as "verb axis or risk axis," not "honour the precedents or overturn them."** The latter is
a false binary, and it is the frame that pushed the plan into needing a human-authorization channel it
turned out not to have.

### Secondary tension — Phase 4's deferral

P5 demands one list of probe argv; Phase 4 defers exactly that and Phases 1-3 ship the duplication. The
stated reason is `SECTION_MEMBERS` rename risk. But §3.4's own design has `doctor` keep its check
**names** and consume only the registry's argv. Under that design the risk is **zero**: `report.ts` is
untouched, `DOCTOR_CHECK_NAMES` (`report.ts:109`) is untouched, and the change is a mechanical
substitution inside `doctor.ts:1385-1420`. The cited risk does not exist, so the deferral has no cost
basis. **Fold Phase 4 into Phase 1.**

---

## 3. Synthesis — what actually delivers human-in-the-loop

With `allowed-tools` a grant (F1) and the TTY guard inert in every agent-driven context (F2), the plan
has no human-authorization channel at all. There are exactly **three** channels in reach that a human
genuinely traverses. The plan uses none of them.

### 3a. The host tool-call boundary — already deployed in this repo

`.claude/settings.json` carries both halves of a working gate:

1. **`permissions.deny`** — six entries, all forms of prod delivery plus `Bash(doppler secrets:*)`.
2. **`hooks.PreToolUse`** on matcher `Bash` → `.claude/hooks/bash-launcher.mjs` →
   `.claude/hooks/block-deploy.mjs` (331 lines).

Two corrections to how this was described to me, because both matter for the design:

- **The chain is `bash-launcher` → `block-deploy`; `bash-guard.mjs` is not in it.**
  `bash-launcher.mjs:11` spawns `block-deploy.mjs` as a child and translates any exit outside `{0, 2}`
  into a `deny`, because *"a syntax error in block-deploy.mjs exits 1, and exit 1 does not block — so a
  typo would disarm the guard silently"* (`bash-launcher.mjs:1-3`). `bash-guard.mjs` imports only
  `hooklib.mjs` and is the separate **advisory** lane (README `:77`). The deploy guard is one file,
  fail-closed by a wrapper.
- **A heredoc containing the word `deliver` in prose being blocked is designed behaviour, not
  over-breadth.** `block-deploy.mjs:51-54`: the `RE_RAW_DELIVER_PREFIXED` lookbehind deliberately omits
  `/`, with the tradeoff stated outright — *"Cost is over-blocking a path ending in the name — the
  fail-closed direction."* Meanwhile `RE_BARE_DELIVER` (`:57-59`) *keeps* its `/` and requires
  `RE_INFRA_TOOL` beside it, precisely so `rg x src/deliver/` is not denied. The file already
  distinguishes the two cases. This is a worked example of where to accept false positives and where
  not to — not a cautionary tale about sloppy matching.

**Three properties nothing else in the plan's option set has:**

1. **Not agent-satisfiable.** Unlike the confirm token, there is no round 2.
2. **Independent of `allowed-tools` semantics.** F1 does not touch it.
3. **Holds under `bypassPermissions`** — `block-deploy.mjs:3`: *"Denies via permissionDecision JSON,
   which holds under bypassPermissions."* This is the **only** mechanism discussed in this review that
   survives that mode.

The README is explicit that the two halves are not redundant (`:72-75`):

> *"They are **defence in depth, not duplication**: a `deny` rule survives the hook file being deleted,
> which is the one gap the hook cannot cover. Where the two disagree on wrapped or prefixed forms, the
> hook is the more precise layer."*

**The asymmetry that must not be papered over.** `block-deploy.mjs:1-2` opens with: *"Blocks
agent-initiated deployments; reads stay allowed. **A tripwire, not a wall — the real control is
server-side.**"* Followed by a candid gap list (`:5-6`): `bash script.sh`, `$(which gh)`, aliases, a
tool named via a variable, and any prefix missing from `PREFIX_COMMANDS`.

For deploys that framing is sound — GitHub is the wall behind the tripwire. **For
`setup-deps-install` there is no server side. The host *is* the resource being mutated.** So copying
this pattern inherits every documented gap with nothing behind them. The deny layer is a
defence-in-depth addition, never the primary control. If the Planner adopts it, that sentence has to
appear in the plan, or the next reader will mistake the tripwire for the wall.

**How to write the matcher — it needs almost no new code.** `block-deploy.mjs:44`:

```js
const GUARDED_TOOLS = new Set(['gh', 'ik', 'infra-kit']);
```

with the comment *"Keyed on the TOOL, never 'unrecognised head' — that would deny
`git commit -m \"…gh workflow run…\"`."* `infra-kit` and `ik` are **already guarded tools**, so guarding
the installer means adding two subcommand names inside an existing dispatch — not a new bare-word
regex, and therefore not the prose-matching breadth of the `deliver` case at all. Better still, the
machinery already speaks both shapes that matter here: `SHELL_WRAPPERS` (`:17`) covers `bash`/`sh`,
which is the `curl … | bash` form, and `PREFIX_COMMANDS` / `PREFIX_SPECS` (`:20-38`) already strip and
account for `sudo`. Both hazards are inside the file's existing vocabulary.

Concretely: deny `infra-kit|ik setup-deps-install` and `…-update` when the argv resolves to the brew
bootstrap or carries a `sudo` prefix; allow `setup-deps-status` unconditionally. Add a `BLOCK` switch
line (`:70-73`) so the rule is documented in the README's table (`:58-63`) like every other one.

### 3b. Is per-repo scoping fatal for a new-machine capability?

**No — but only because the failure inverts, and the plan must say why.**

The naive worry is right on its face: hooks and deny live in `$CLAUDE_PROJECT_DIR/.claude/`, so a bare
machine with no infra-kit checkout has neither, and protection is absent at peak risk.

But on that same bare machine `infra-kit` is not installed either. The realistic bootstrap path is
`npm i -g infra-kit` (consumer repos here run the global install, never a workspace one) → the human
runs `setup-deps-install` in their own terminal → the TTY guard passes → `confirmOrExit` prompts them.
**A human is unavoidably present in the bootstrap case** — which is precisely the case the deny cannot
cover.

The case the deny *does* cover — an agent working inside a checked-out repo that already has `.claude/`
— is the case where a human is *not* present. The coverage and the risk line up.

So: **not fatal, but the deny rule must never become load-bearing, because it does not travel with the
binary.** The controls that do travel are the `mcpMode` guard, the TTY guard, and the risk predicate.
Rank them that way in the plan.

User-scope `~/.claude/settings.json` would travel across every repo on a machine and would close the
gap. But `src/commands/init/init.ts:305-308` explicitly refuses to write a `.claude/` directory outside
an infra-kit repo, and user-scope config is a materially bigger act than the project-scope pointer.
Propose it as an opt-in flag that `doctor` reports on — never something `init` writes silently.

### 3c. Should the deny ship with `init`?

**Partially — the plugin-pointer precedent does not extend as-is.** `init.ts:301-313` justifies its
no-opt-out design on the grounds that the pointer is *inert if wrong*:

> *"There is deliberately NO opt-out flag. The install is idempotent (an already-installed plugin runs
> no command at all) and best-effort (every failure is a logged outcome, never a thrown error), so a
> switch would only buy a way to end up with the pointer keys pointing at a plugin nobody has."*

and it already writes project-scope host config at `:315`:

```ts
logPointerResult(root, ensurePluginPointer(path.join(root, '.claude', 'settings.json')))
```

A `permissions.deny` entry is **not** inert. It changes what the user's agent may do, it can over-block,
and a wrong one produces a refusal with no obvious origin. Recommended shape:

- `init` writes the **project-scope** deny alongside the existing pointer — a repo where the user has
  already accepted init's config writes.
- **`doctor` gains a `setup-deps deny rule present` check row**, so its absence is visible rather than
  assumed. That means a `SECTION_MEMBERS` edit (`report.ts:60-85`) and a `DOCTOR_CHECK_NAMES` entry
  (`:109`) — and it is a natural `FIXABLE_NAMES` member (`:119`), so `doctor --fix` installs the rule.
  This closes the loop with machinery that already exists.
- Never user-scope without an explicit flag.

**The bootstrap paradox is real but bounded:** the tool being protected runs before `init` can.
Resolution — `setup-deps-install`'s own refusal path protects the pre-`init` machine (TTY + `mcpMode` +
predicate); the deny rule protects the post-`init` repo. Two different populations, two different
controls. Say that explicitly rather than letting the deny look like a universal answer.

### 3d. The channel the repo already built and the plan walked past: prompts + resources

`src/mcp/prompts/index.ts:6-12`, verbatim:

> *"A prompt is a host UI affordance: a human picks it out of the `/` menu, and an agent cannot fetch
> one on its own initiative. So every body registered here is ALSO registered as a resource
> (`src/mcp/resources`), from the same `WORKFLOW_BODIES` constant, which is what an agent reads. Two
> channels, one constant — the prose cannot drift between them without two edits."*

`RELEASE_CREATE_WORKFLOW_URI` (`src/mcp/resources/index.ts:24`) and the `release-create` prompt are the
same bytes from one constant. **This is the "one definition, two lanes" shape**, already in production
here — and it directly replaces Phase 3, which currently proposes duplicating the recipe table into
SKILL.md prose.

A prompt is the *only* MCP-native affordance in this codebase that an agent structurally cannot
self-trigger. That property — not a token, not an annotation, not `allowed-tools` — is what P1 actually
needs.

Concretely:

1. `setup-deps-status` (MCP tool, `mutating: false`) returns state **and** the resolved argv per tool —
   the machine channel. Option C folds in here, as the plan already says.
2. `infra-kit://workflow/setup-deps` **resource**, rendered from the registry — agent-readable
   procedure.
3. A `setup-deps` **prompt**, rendered from the same constant — the human picks it from the host's `/`
   menu. Human-initiated by construction.
4. The plugin skill, if kept at all, narrows to `allowed-tools: Bash(infra-kit setup-deps-status)`
   **only** — read-only, safe to grant, and honest about what a grant is.

Caveat the Planner must carry rather than assume away: prior sessions in this repo found MCP
resource-reading tools surfaced in only 1 of 4 host sessions. The resource lane beats duplicated prose
but is **not** a reliable delivery guarantee. Say so explicitly — do not repeat the Phase-3 error of
asserting a channel's behaviour without checking it.

### 3e. The channel that is unambiguously human: the terminal the user is already in

Under F2, `process.stdin.isTTY === true` is *itself* a strong human signal — it is true only where a
person is at a keyboard. So the honest formulation of "human authorization" here is:

> The status tool tells the agent what is missing and hands back the exact argv. The agent shows the
> human that argv. The human runs it in their own terminal, where the TTY guard passes and
> `confirmOrExit` prompts them.

That is not a consolation prize — it is the only path in this design where a person demonstrably saw and
chose the command. The plan should **state this as the mechanism** rather than dressing up the skill
lane as one. Two supporting requirements: the printed form must be copy-pasteable (`formatUpdateCommand`,
`install-manager.ts:143-151`, already single-quotes tokens containing spaces — reuse it, and honour the
standing rule that printed portless commands are `<node> <abs cli.js>`), and `confirmOrExit` must remain
the last thing before the spawn with nothing acquired before it, since it `process.exit(0)`s on decline
and skips every `finally`.

### 3f. The revised layering, and the verdict on Option B

The addendum changes the verdict on Option B's **mechanism**, not on its **conclusion**. Phase 3 is
still dead: `allowed-tools` is a grant (F1) and the TTY guard makes the skill lane inert (F2). Nothing
in the deny/hook precedent rescues it. But it supplies the P1 mechanism the plan was missing, at a layer
the plan never considered.

| Layer | Mechanism | Covers | Agent-satisfiable? |
|---|---|---|---|
| Host tool-call boundary | `block-deploy`-style deny on bootstrap / `sudo` argv; `init`-written, `doctor`-checked | agent inside a checked-out repo | **No** — and holds under `bypassPermissions` |
| MCP boundary | risk-predicate-bounded install tool (§2) | the five safe recipes | n/a — refusal is computed |
| Human channel | `setup-deps` **prompt** + `infra-kit://workflow/setup-deps` **resource**, one constant | procedure delivery | **No** — an agent cannot fetch a prompt |
| Fallback | printed argv → human's own TTY → `confirmOrExit` | everything refused above | n/a |

Layers 1 and 3 are the two genuine human-in-the-loop mechanisms, and **both were absent from the plan**.
Layer 2 is what makes the feature responsive to what the user actually asked for. Layer 4 is what the
plan currently mislabels as the skill lane's contribution.

**Recommendation: delete Phase 3 and replace it with two phases** — a prompt/resource pair rendered from
the registry, and a deny rule shipped by `init` with a `doctor` row. That is more work than the SKILL.md
it replaces, and it is the difference between claiming a gate and having one.

---

## 4. Structural review

### Module layout (§3.2)

Sound. `dependency-registry` (pure data and predicates) / `dependency-probe` (injected I/O) /
`dependency-install` (the sole spawner) is the right decomposition, and keeping one module as the only
thing that spawns is the correct chokepoint. Separating `present` from `onPath` (finding A) is a good
catch and correctly motivated.

### The `install-manager` seam (§3.3)

Wrong, per F3 and F4. Replacement:

- **Phase 0 becomes purely additive:** export `isWithin`, `hasSegment`, `isBrewKegOf` and
  `npmPrefixFromSelfPath` from `src/lib/install-manager/index.ts`. Zero behaviour change, zero test
  churn, trivially reverted, genuinely independently landable.
- **`detectInstallManager` is left alone.** It answers "how do I update *myself*" — a question the
  registry never asks, since §3.1 owns per-tool recipes.
- **`DependencySpec` carries separate name fields:** `binName`, `brewFormula`, `brewInstallSpec`,
  `kegName`, `npmPackage` — F4's table. `identify()` composes the newly-exported predicates into a
  per-tool classification with an explicit `unknown` branch.

### Relationship to `doctor` (§3.4)

Direction is right — the registry owns probe argv and `doctor` consumes it, never the reverse — and
preserving the check **names** so `report.ts` never changes is exactly the right call. Three fixes:

1. portless is a fourth duplicated probe, not three (F6);
2. the deferral rationale is empty, so Phase 4 folds into Phase 1 (§2);
3. add the `setup-deps deny rule present` row from §3c, with its `SECTION_MEMBERS`,
   `DOCTOR_CHECK_NAMES` and `FIXABLE_NAMES` entries.

`setup-deps-status` is correctly characterized as a different thing from `doctor`: `doctor` answers
"does this exit 0", the status surface answers "which manager owns this binary, what version, is it
stale, and what is the exact argv to fix it". Keep that distinction in the ADR.

### Catalog wiring (§3.5)

Three omissions, each a hard compile or test failure:

1. **`MCP_TOOL_PRESENTATION` (`command-catalog.ts:573`) needs a `setup-deps-status` row** with a `title`
   and an **evidence-cited** `openWorld` value. `getExposedMcpTools` **throws at registration** without
   it (`:678-683`).
2. **`EXPECTED_EXPOSED_TOOLS` and `toHaveLength(23) → 24`** (`command-catalog.test.ts:85-86`).
3. **`openWorld` is undecidable until `stale`'s source is fixed.** §3.2's `DependencyState` carries
   `stale?` and §3.4 promises to answer "is it stale", but the plan never says where staleness comes
   from. An upstream version check means network calls: `openWorld: true`, plus a timeout, a cache, and
   a hang risk in the long-lived MCP server. A registry-pinned floor is pure and `openWorld: false`.
   **Decide before Phase 1**, not during it.

`menuGroup: 'setup'` on install and update is a precedent violation, not a wiring detail — see V2.

### Phase decomposition and independent landability

| Phase | Verdict |
|---|---|
| 0 — generalize `install-manager` | **Not independently valuable, and actively harmful (F4).** Replace with the export-only phase above, which *is* independently landable and reverted |
| 1 — registry + probe + status | Acceptance (*"reports all five tools on this host with correct manager attribution"*) is host-dependent and unrunnable in CI. Split into fixture-driven CI acceptance (the §6 tables) plus a recorded manual host run captured as evidence |
| 2 — install/update, CLI-only | Acceptance requires a real install of `gh` as "the cheapest real tool" — but `doctor` already probes `gh` and it is presumably present, so the step is un-runnable without first uninstalling it. Name a target with a stated undo, and record the undo as part of the acceptance |
| 3 — plugin skill | **Unlandable as written** (F1/F2). Rebuild per §3f as prompt/resource + deny rule |
| 4 — doctor unification | Fold into Phase 1; the rename risk it defers against does not exist under §3.4's own design |

### Test plan (§6)

The strongest part of the document. The mutation tests are the right instinct, and mutation #3 — *"if
only one mutation reddens, they are redundant and the second should be removed rather than left as
false assurance"* — is genuinely good test design. Gaps:

- The brew child-env assertion must cover `CI`, `INTERACTIVE`, `HAVE_SUDO_ACCESS` and `SUDO_ASKPASS`,
  not just `NONINTERACTIVE` (F7).
- PM-3 should extend the existing catalog tests rather than add a weaker prefix-scoped one (F5).
- **Nothing tests that the `unknown` branch refuses** rather than falling through to a best guess. P4's
  entire load rests on that branch, and an untested `unknown` path is how P4 silently becomes advisory.
- If the deny rule ships (§3c), its matcher needs the same treatment `block-deploy.mjs` gives its own:
  a test that the wrapped (`bash -c`) and prefixed (`sudo`) forms are both caught.

---

## 5. Principle violations

**V1 — P1 is contradicted by the mechanism chosen to implement it.**
P1 requires "a channel where a person sees the argv". Phase 3's `allowed-tools` narrowing is a permission
**grant** that suppresses the prompt (F1), and the TTY guard makes it inert anyway (F2). The plan's only
human-authorization channel does the opposite of what its first principle demands.

**V2 — P3 is contradicted in the same paragraph that invokes it.**
`self-update`'s catalog comment (`command-catalog.ts:528-531`) is a **two-part** decision:

> *"an agent-triggered unattended global package install must never be reachable there. **menuGroup null
> keeps it off the no-arg picker too — updating the CLI is a deliberate act, not something to land on by
> arrowing through a menu.**"*

asserted at `command-catalog.test.ts:157-167`. §3.5 adopts half the shape (`mcpTool: null`) and rejects
the other, putting `curl … | bash` on a palette row that `run-session.ts:199` dispatches with **zero
flags**.

§3.5's own defence is self-defeating: it argues the bare groupPath is safe because a no-arg invocation
opens a TTY-only multi-select picker — but a TTY-only picker means the only non-TTY outcome is the §4
refusal, and the only TTY outcome is a menu row leading to a multi-select of installers. Both readings
argue for `menuGroup: null`, which the plan lists merely as a fallback ("if the picker slips"). It should
be the default.

**V3 — P5 is violated by the Phase 4 deferral**, on a rationale that §3.4's own design nullifies (§2),
with the debt undercounted at three probes when it is four (F6).

**V4 — the plan's own §0 verification standard is applied unevenly.**
§0 verifies three external claims rigorously and adds a fourth in-repo finding — excellent work. Then §5
and §7 assert Claude Code's `allowed-tools` semantics — a claim at least as load-bearing as finding D,
and cheaply checkable — without verifying it, and get it backwards. The
`plugins/infra-kit/skills/doctor/SKILL.md` citation reads as evidence but cannot be: that skill grants a
read-only command, so it is the one case where grant and prompt are indistinguishable.

**V5 — the plan surveyed three boundaries and missed the one that works.**
§1's option set covers the MCP boundary, the CLI boundary, and the plugin/skill lane. The host
tool-call boundary — deployed in this repo, fail-closed by construction
(`bash-launcher.mjs:22-36`), not agent-satisfiable, and the only mechanism that holds under
`bypassPermissions` — appears nowhere in the plan, the pre-mortem, or the ADR's alternatives. Given that
P1 is the document's first principle, omitting the repo's only working implementation of it is the
plan's largest structural gap.

**Not violated, and worth saying:** P2 (read-only detection is a different risk class) and P4 (a guessed
install is worse than a printed one) are both honoured throughout, and P4's `unknown → print, never
execute` rule is correctly threaded from `install-manager`'s reasoning into the new registry. The
`unknown` branch needs a test (§4), but the principle itself is applied consistently.

---

## Appendix — the nine changes I would ask the Planner to make

1. Retract the Phase 3 authorization claim outright; F1 and F2 are both verified.
2. Replace Phase 0 with the additive export of the four path predicates; leave `detectInstallManager`
   alone; give `DependencySpec` five separate name fields.
3. Re-pose Q2 as "verb axis or risk axis", and answer the unaddressed argument: the agent already has
   Bash, so barring the MCP tool removes the audited path, not the capability.
4. Adopt the four-layer shape of §3f — deny rule, risk predicate, prompt/resource pair, printed-argv
   fallback — and state plainly that the deny is defence in depth because it does not travel.
5. Set `menuGroup: null` on install and update, per `self-update`'s stated reasoning.
6. Decide where `stale` comes from before Phase 1; it determines `openWorld` and whether the status tool
   touches the network.
7. Widen the brew env scrub and its assertions to `CI`, `INTERACTIVE`, `HAVE_SUDO_ACCESS`,
   `SUDO_ASKPASS`.
8. Fold Phase 4 into Phase 1.
9. Extend the existing catalog tests rather than adding a weaker prefix-scoped invariant, and budget the
   `MCP_TOOL_PRESENTATION` row plus the `EXPECTED_EXPOSED_TOOLS` / `23 → 24` edits.
