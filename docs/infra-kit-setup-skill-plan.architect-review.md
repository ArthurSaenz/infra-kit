# Architect review — `/infra-kit:setup` plan

Reviewer: architect pass of a ralplan `--deliberate` consensus loop. Read-only with respect to
`docs/infra-kit-setup-skill-plan.md` and all source; this file is the only artefact written.

Subject: `docs/infra-kit-setup-skill-plan.md` (564 lines).
Sibling precedent: `plugins/infra-kit/skills/doctor/SKILL.md` (landed in `bd4566d`).

Every claim below was checked against the working tree at `969bbe0` (main, dirty: ~30 modified CLI
files). Line numbers are from that tree.

---

## 0. Decisions the repo owner has made since the plan was written

These three are settled. This review does not re-argue them; it develops their consequences.

1. **The skill MAY run `infra-kit init`.** Run-with-consent is approved. Open question 1 is closed.
2. **`init` DOES create `.mcp.json` when none exists.** Owner's reason: *"it will be in the repo at
   any cost"* — the file is going to exist in every infra-kit repo regardless, so creating it is not
   converting an abstention into a decision. Open question 2 is closed. Consequences in §7.
3. **The `infra-kit.json` repo gate should not be what gates the plugin and MCP steps.** A proposal to
   split the gate is on the table; it is attacked and adjudicated in §8.

---

## 1. Claim verification

### (a) `.strict()` survives `.partial()`; `loadLayer` throws on unknown keys — **VERIFIED** (citation path wrong)

This is the sole reason the plan refuses a `setupCompleted` marker, so it had to hold for both
override layers. It does.

- The file is `apps/infra-kit/cli/src/lib/infra-kit-config/**infra-kit-config**.ts`. The plan cites
  `lib/infra-kit-config.ts`, which does not exist. **Line numbers survive; the path does not.**
- `infraKitConfigObject` is `z.object({…}).strict()` — `.strict()` at `:236`.
- `export const infraKitOverrideConfigSchema = infraKitConfigObject.partial()` at `:278` — exactly as
  the plan cites.
- `loadLayer` (`:641-679`): `infraKitOverrideConfigSchema.safeParse(parsedRaw)` at `:668`, and on
  failure `throw new Error(\`Invalid ${layer.label} at ${layer.path}: …\`)` at `:671`.
- The file's own comment at `:655-659` states it directly: *"the override schema keeps `.strict()`, so
  it lands as a generic `unrecognized_keys` issue."*
- **Reachable for both layers.** The layer array at `:505-512` is
  `[main (required), ~/.infra-kit/infra-kit.json (:507), ~/.infra-kit/projects/<repo>/infra-kit.json (:509)]`,
  and every entry passes through `loadLayer` in the loop at `:518`.

A `setupCompleted` key in either override layer would therefore throw on **every** `infra-kit` command
on that machine, and layer 3 is auto-seeded on every command. The plan's hard constraint is real.

### (b) U6 enforces `allowed-tools` ↔ fenced-command-corpus equality in BOTH directions — **VERIFIED** (line cite off by ~3)

This is the core of the plan's interactivity argument (fencing a command *obliges* a grant), so the
exact predicate matters.

- `COMMAND_HEADS = new Set(['node', 'python3', 'pnpm', 'git', 'infra-kit'])` at `manifest.test.mjs:140`.
- `commandCorpus(body)` (`:158-160`) = fenced lines whose **first token** is in `COMMAND_HEADS`.
  `fencedLines` (`:142-151`) trims each line inside a ``` fence.
- `bashRules(allowedTools)` (`:163-165`) = `[...String(...).matchAll(/Bash\(([^)]*)\)/g)]` — only
  parenthesised rules.
- **Clause 2** (`clause2Errors`, `:188-197`): for every non-`git` corpus line, **exactly one** rule must
  match (`if (hits.length !== 1)`). Zero matches *and* two matches are both errors.
- **Clause 3** (`clause3Errors`, `:199-207`): every non-`git` rule must match at least one corpus line,
  else `dead rule Bash(<rule>) matches no fenced command line`.
- `checkSkillTools` (`:210-215`) unions both. Live test at `:400-410` iterates `skillDirs()`.
- Matching semantics: `ruleMatches` (`:183-186`) builds `^token\s+token…$`; `tokenPattern` (`:171-174`)
  turns a rule token containing `*` into `[\s\S]+` and any other token into
  `(?:<escaped>|<PLACEHOLDER>)`; `canonicalLine` (`:176-181`) maps any body token matching `/^<.*>$/`
  to `PLACEHOLDER`.

**Bidirectional: confirmed.** Plan says `185-206`; actual is `188-207`.

### (b2) U14's 3-line body cap for `commands/` — **VERIFIED, and understated**

`manifest.test.mjs:637` — `assert.equal(bodyLines.length, 3, …)` over non-empty lines, for every entry
in `EXPECTED_COMMANDS` (`:606`, currently `['release-create.md']`). The comment at `:632-636` says why
it is an equality and not a `<= 10`. The plan calls it a "3-non-empty-line body cap"; **it is an
equality**, which makes Option D weaker than the plan argues. In the plan's favour.

### (b3) U16 / `REPORT_OWNED_STRINGS` at line 490 — **VERIFIED**

- `REPORT_OWNED_STRINGS` at `:490-502`: eleven row names (`claude CLI`, `marketplace registered`,
  `plugin installed`, `plugin version`, `CLI version`, `MCP server key`, `CLAUDE.md block`,
  `portless routes`, `tokens.json perms`, `infra-kit config valid`) plus one section label
  (`Tools & CLIs`).
- Test at `:504-508`, scoped to `DOCTOR_SKILL` only, `assert.deepEqual(hits, [])`.
- Header comment `:487-489` states the intent: *"the skill prints that report verbatim, so repeating
  any of these would be a copy that goes stale the moment a check is renamed."*

Note for §5/S1: this is a hand-picked subset of **11 of the 30** rows. That is what makes the plan's
proposed U19 a fail-open — see §4, T1.

### (c) Nothing in the CLI writes `.mcp.json` — **VERIFIED**

Repo-wide grep across `apps/`, `scripts/`, `plugins/` for `.mcp.json` in `*.ts|*.mjs|*.js|*.sh|*.json|*.md`,
excluding `node_modules` and `dist`:

- Every `writeFileSync(… '.mcp.json' …)` site is a **test fixture**:
  `lib/plugin-pointer/__tests__/install-state.test.ts:185,193` and
  `commands/doctor/__tests__/claude-plugin-checks.test.ts:176`.
- Production code only **reads** (`lib/plugin-pointer/install-state.ts:222`) or **reports**
  (`commands/doctor/doctor.ts:1026-1065`).
- No template, no copied asset, no script, no MCP-server path writes it. `apps/infra-kit/cli/readme.md:19`
  instructs the *human* to add it by hand.

The plan's central gap claim holds. This is the whole CLI-side deliverable and it is genuinely unowned.

### (d) `ensurePluginPointer` / `plugin-pointer.ts` is the template claimed — **VERIFIED**

- Additive-only, never-overwrite: `@fileoverview` `:16-22` — *"ADDS each key only when it is absent,
  never overwrites an existing value (a `false` there is a deliberate per-machine opt-out), touches no
  other key, preserves key order and the file's own indentation."*
- `detectIndent` at `:88` ✓ exactly as cited (`/\n([ \t]+)"/`, falling back to `DEFAULT_INDENT`).
- Unparseable → warn and leave untouched at `:167-177`: `JSON.parse` in a `try`, `logger.warn(…)`,
  `return { status: 'unparseable', … }` with **no write**.
- Trailing-newline preservation at `:183-184`.
- `MARKETPLACE_NAME = 'infra-kit'` at `:26` ✓ — reusable, as the plan requires.
- Bonus precedent the plan does not cite but should: `createSettingsFile` is called when the file is
  absent (`:161`), so **`init` already creates a tracked file it did not find**. That is direct support
  for decision 2.

### (e) `inspectMcpRegistration`'s five verdicts and `looksLikeInfraKitServer` — **PARTIAL: two real defects**

Located at `install-state.ts:190-241`. The verdict set and predicate exist as described:

- `McpRegistration` union at `:191-196`: `ok | missing-file | unparseable | wrong-key | absent`.
- `looksLikeInfraKitServer` at `:198-205` — `` `${command} ${args}`.includes('infra-kit') ``, plan's
  `:198-205` ✓ exact.
- `inspectMcpRegistration` at `:220-241`.

But the plan's writer contract does **not** faithfully mirror it, in two ways that decision 2 makes
worse. Both are developed into plan edits in §7.

**Defect e1 — `ok` is key-presence-only, so the plan's round-trip test is vacuous.**
`:232` is `if (MARKETPLACE_NAME in servers) return { kind: 'ok' }`. The value is never inspected.
`looksLikeInfraKitServer` is consulted **only** for other keys, at `:235-237`, and only when
`MARKETPLACE_NAME` is absent. Consequences:

- The plan's Phase 1 criterion *"for every case that wrote, `inspectMcpRegistration(root)` returns
  `{ kind: 'ok' }`"* would pass on `{"mcpServers":{"infra-kit":null}}`. It pins nothing.
- The plan's assertion that *"the written entry satisfies the reader's own `looksLikeInfraKitServer`
  predicate … so a round-trip test can pin the agreement"* is **false as stated**: on the write path
  that predicate is never reached.
- Untested state nobody has named: `infra-kit` present **and** a misfiled `ik` also present reads as
  `ok`, because `:232` short-circuits before `:235`. A repo running two infra-kit servers gets a green
  row.

**Defect e2 — `unparseable` conflates "not JSON" with "valid JSON, no `mcpServers` key".**
`:228` is `if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) return { kind: 'unparseable' }`.
So `{"$schema":"…"}` — perfectly valid JSON — is `unparseable`. Under the plan's contract
(`unparseable` → refuse, leave byte-for-byte alone) the writer permanently strands a file it could
repair additively, while `doctor.ts:1030` tells the user *"Could not read mcpServers from .mcp.json —
fix the JSON and re-run"* about JSON that is not broken.

### (f) `init` returns/skips on `repoRoot === null` silently — **PARTIAL; the plan's pre-mortem 3 is WRONG**

The gating is exactly as the plan describes. The silence is not.

Gating — all four steps hang off one value:

- `syncAgentGuidance` (`init.ts:242-250`): `const { skipped, root, … } = await syncRepoGuidance()`;
  `if (skipped || root === null) return null` at `:245`.
- `syncPluginPointer(root)` (`init.ts:315-327`): `if (root === null) return` at `:316`.
- Call sites: `const repoRoot = await syncAgentGuidance()` at `init.ts:94`, then
  `syncPluginPointer(repoRoot)` at `:98`. One value, four steps (guidance, pointer, install, and the
  new writer, which the plan puts inside `syncPluginPointer`).
- `init` still writes the zshrc block (`:69`), still migrates the user-global config (`:82`), still
  reseeds layer 3 (`:101`), and still prints *"Run `source ~/.zshrc` or open a new terminal to
  activate."* at `:114`, then exits 0.

**Where the plan is wrong:** it claims *"Today it says **nothing at all** about the skip."* It does.
`syncAgentGuidance` and `syncPluginPointer` are silent, but the logging lives one level deeper, in
`resolveRepoRoot` (`commands/init/agent-files.ts:37-55`):

- `:43` — `logger.info('Skipped agent-instruction files — not inside an infra-kit repo')`
- `:49` — `logger.info('Skipped agent-instruction files — no infra-kit.json at the repo root')`

So a line already exists on both null paths. What is genuinely wrong is narrower and more useful:
**those two strings name only the guidance step**, so a reader is told guidance was skipped and is not
told the pointer, install and MCP steps were skipped by the same value. That is the legibility bug.

**Consequence: Phase 2's first deliverable shrinks** from "add one INFO line when `repoRoot === null`"
to "amend the two existing strings at `agent-files.ts:43,49` to name all four gated steps." Same test
style, smaller diff, and it does not add a third message that could drift from the other two.

### (g) doctor's `missing-file → pass` carve-out, `FIXABLE_NAMES`, and the exit-1 row — **VERIFIED**

**The carve-out.** `doctor.ts:1039` —
`const MCP_NON_FAILING: ReadonlySet<McpRegistration['kind']> = new Set(['ok', 'missing-file'])`.
Its rationale is at `:1033-1038`: *"a repo that has chosen not to register any MCP server has no key
to get wrong. A file that IS present and does not name the server fails, because that is a
misconfiguration rather than an abstention."*
`checkMcpServerKey` (`:1049-1065`) special-cases `wrong-key` into a `fail` with the rename
instruction (`:1057`), then returns `MCP_NON_FAILING.has(registration.kind) ? 'pass' : 'fail'` with
`MCP_MESSAGES[registration.kind]` (`:1027-1032`).

**A gating fact the plan does not mention, and it matters.** The row is **omitted entirely** outside a
repo: `doctor.ts:1464` —
`...(repoRoot === null ? [] : [checkMcpServerKey(repoRoot)])`, with the comment at `:1456-1457`:
*"the Claude Code plugin rows read `~/.claude/` and answer from anywhere; the `.mcp.json` row is about
a PROJECT and is omitted outside an infra-kit repo, the same way the guidance check is."*
So `checkMcpServerKey` is only ever called with a resolved repo root, and **the "30 rows" figure is a
maximum, not a constant** — relevant to any mechanical consumer of the report (§6/S1).

**`FIXABLE_NAMES`.** `report.ts:118` —
`export const FIXABLE_NAMES: ReadonlySet<string> = new Set(['portless routes', 'tokens.json perms'])`
✓ exact, and the doc at `:112-117` confirms the summary's remediation hint is driven by this set
rather than by message text.

**`SECTION_MEMBERS` is 30 rows, not 25.** `report.ts:60-85`: Tools 8 + Shell 4 + Config 3 + Tokens 4 +
Proxy 5 + Plugin 6 = **30**. The plan's correction to the brief is right. Note `PORTLESS_SERVING_NAME`
(`:80`) is a constant, not a literal — so the plan's table renders a computed name as a source string.

**doctor exits 1 specifically on `plugin installed`.** `program.ts:567-571`:

- `:567-569` — `const pluginMissing = result.structuredContent.checks.some((check) => check.name === 'plugin installed' && check.status === 'fail')`
- `:571` — `if (pluginMissing) process.exitCode = 1`
- The comment at `:561-566` explains the deliberate narrowness: doctor has always exited 0 with
  failing rows, and only a missing plugin flips it, *"because … an agent session there silently loses
  them, and a non-zero exit is what a setup script can act on."*

Plan cites `566-572`; actual `567-571`. **VERIFIED.**

### Additional verifications

| Claim | Verdict | Evidence |
|---|---|---|
| `init` registers zero options (Phase 2's assertion is implementable) | VERIFIED | `program.ts:658-664` — `.command('init').description(…).action(…)`, no `.option()` |
| `init` is `mcpExposed: false` | VERIFIED | `command-catalog.ts:466` — `{ cliName: 'init', menuGroup: 'setup', mcpTool: null, mcpExposed: false, mutating: true, groupPath: ['init'] }` |
| Token-budget re-measure is enforced by nothing | VERIFIED | No `plugin details` invocation in `scripts/`, `.github/`, or `package.json`. `plugins/infra-kit/README.md:80-82` says *"the release checklist runs"* — a human, not code. The plan's own note is right. |
| The written value matches this repo's committed entry | VERIFIED | `.mcp.json` holds `"infra-kit": { "type": "stdio", "command": "infra-kit", "args": ["mcp"] }` plus the `linear-server` sibling from pre-mortem 1 |
| `.mcp.json` and `.claude/settings.json` are both tracked | VERIFIED | `git ls-files` returns both; neither appears in `.gitignore` |

### Claims that came back WRONG

**W1 — `EXPECTED_SKILLS` is not what makes the guards apply.**
Plan (Test plan → Plugin/e2e): *"`EXPECTED_SKILLS` gains `'setup'`, which is what makes U3 pass and
U2/U4/U5/U6/T1 apply to the new file at all."* False:

- `skillDirs()` (`manifest.test.mjs:66-72`) is a `readdirSync` of the live `skills/` tree.
- U2 iterates `skillDirs()` (`:328`); U6 iterates `skillDirs()` (`:402`); U12 iterates `skillDirs()`
  (`:545-548`); U4 walks `PLUGINS_DIR` (`:344`); U5 walks `PLUGINS_DIR` (`:380`); T1 walks
  `SKILLS_DIR` (`:579`).
- **None consult `EXPECTED_SKILLS`.** Only U3 does (`:324`).

So creating the directory subjects it to every guard immediately; the `EXPECTED_SKILLS` edit exists
**only** to stop U3 going red. Good news — the guards are stronger than the plan credits — but a
reader working from the plan's model will conclude that omitting the edit disables U6. It does not.

**W2 — `publish-gate.test.mjs` is green, and a skill does not escape the blocked lane.**
Decision-driver 2 and the Option D rejection both rest on *"`publish-gate.test.mjs`, which is red on
`main` today."*

- `plugins/infra-kit/__tests__/publish-gate.test.mjs` is a **green unit test** of `collectViolations`
  imported from `scripts/check-workflow-resource-published.mjs` (`:16`). Its own header at `:9-10`
  says *the gate* is red on main, not the test.
- The red artefact is the **script**, run at `.github/workflows/plugin-ci.yml:54-55` with **no
  `continue-on-error`** (only the U13 probe at `:56-57` has that), inside the workflow's **single
  `validate` job**, triggered on `paths: - 'plugins/**'` (`:7` for `pull_request`, `:20` for `push`).
- Therefore **adding `plugins/infra-kit/skills/setup/SKILL.md` makes plugin-ci fail.** A skill is
  exempt from the gate's *violation logic*, never from the *job*.
- Worse: `pnpm run qa` (`package.json:23-24`) never runs the script — `test:claude` runs
  `plugins/infra-kit/__tests__/*.test.mjs`, which includes the *green* unit test. So **local qa is
  green while CI is red**, the worst combination for a reviewer.

The A-over-D verdict survives on independent grounds (a command needs a version floor *and* a served
`infra-kit://workflow/<name>` resource — `publish-gate.test.mjs:22-23,79-87` — and a body of exactly
three non-empty lines). But the stated reason is gone.

**W3 — the version bump is not enforced on this repo's workflow.**
Phase 3 says the plugin version bump must be *"in the same commit (CI fails otherwise)"*. The
enforcing step is `plugin-ci.yml:44-46`, gated on `if: github.event_name == 'pull_request'`. Recorded
project convention: infra-kit **commits straight to main, no branches, no PRs**. So U9 never runs and
the bump is **unenforced**; the red gate at `:54-55` *does* run on push (`:20`). Net: red plugin-ci on
main, unenforced bump. The bump is a discipline item, not a gate.

**W4 — two supporting arguments in §Interactivity do not apply to `init`.**

- Reason 3: *"the module is importable from the MCP server path and an inquirer prompt there is
  unanswerable."* No import of `commands/init` exists anywhere under `apps/infra-kit/cli/src/mcp/` or
  in the command catalog. `mcpTool: null, mcpExposed: false` (`command-catalog.ts:466`) is metadata.
- Decision-driver 3's `confirmOrExit` defect: **`init` never calls `confirmOrExit`** — no reference
  anywhere under `commands/init/`.

Both statements are true of the codebase and irrelevant to this command. Leaving them as load-bearing
support invites a future reader to act on them.

---

## 2. Steelman antithesis

### 2.1 The single strongest point: `infra-kit doctor --json` exists, and the plan never mentions it

`--json` is a **global** option, applied in `program.ts:756`
(`jsonOutput.enabled = Boolean(actionCommand.optsWithGlobals().json)`). The doctor action skips
`printDoctorReport` entirely under it (`:557-560`) and `emit(result)` puts `structuredContent` —
built at `doctor.ts:1472-1483` as `{ checks: [{ name, status, message }], … }` — on **stdout**.

This both demolishes the framing of the objection and rescues the plan:

- The objection *"doctor's report is grouped, verbose, stderr-bound prose; the skill has no way to act
  on it mechanically"* is **true of `infra-kit doctor` and false of `infra-kit doctor --json`.** The
  skill can filter `status === 'fail'` and echo each row's own `message`.
- It makes step 4's promise — *"each as the exact command from doctor's own message"* — implementable
  **by construction** rather than by trusting the model to re-transcribe 30 rows faithfully.
- It dissolves the U19 tension (§4, T1) entirely: a skill that filters on `status` and echoes `message`
  names **zero** row names, so U19 stops being a fail-open and becomes a real invariant.
- The plan never uses the word `--json`. Every argument it makes about the pre-check is made against
  the wrong interface.

What `--json` cannot give: `CheckResult.status` is `'pass' | 'fail'` with **no warn**, and optionality
is message-only — `doctor.ts:858` states this deliberately. So a mechanical path can separate pass from
fail but **not required from optional**; `terminal installed` and `ide installed` sit in the human
remainder forever with nothing to distinguish them.

### 2.2 Option E, which the plan did not consider: `infra-kit setup` prints an ordered checklist

Strongest case: the list lives in code where tests can pin it; no TTY dependency (sidestepping the
recorded `dev`-wizard landmine); works outside a Claude session; the skill becomes two lines; and the
owner's recorded preference is that new CLI commands go **top-level with related names**.

Why it loses anyway: `--json` already delivers everything the printed checklist would, from a command
that ships today, at zero new surface. And a printed checklist would be a **third** rendering of the
same 30 rows — next to `printDoctorReport` and next to each check's own `message` — i.e. a principle-2
violation moved *into the code*, which is worse than one in a doc. The recorded preference for the
guidance-block writer was explicitly *no new command*; the same instinct applies. **Reject — but the
plan's stated reason ("Option A is smaller") is not the strongest. The strongest is that the
capability already exists.**

### 2.3 Should `.mcp.json` be its own top-level command?

For splitting: it decouples the deliverable from `init`'s behaviour; it keeps `init`'s blast radius
fixed (the command every teammate runs blind); and it gives the permanently-manual `wrong-key` case a
home now instead of as a later new command — the plan's own follow-up already names
`infra-kit mcp-register --rename`.

Against: `syncPluginPointer`'s doc comment (`init.ts:303-310`) says the pointer keys and the
installation *"name one project"*; the MCP server key is the third member of that same triple. And a
teammate who has to run a second command will not.

**Adjudication: keep the call inside `init`, and additionally expose the same function as a top-level
`infra-kit mcp-register`.** One implementation, two entry points, and `--rename` becomes a flag rather
than a future new command. Cost: one catalog entry and one `program.ts` block. Optional — it does add
scope, and the plan's instinct to minimise is sound.

### 2.4 Is the marker/resume/`--force` substitution sound? Mostly — with one un-noted loss

The plan is right that doctor is evidence and a marker is a claim. But the two answer different
questions: a marker answers *"has this machine ever been set up"* (history); doctor answers *"is it set
up now"* (state). They diverge in exactly one case: a **deliberately declined** step — no Doppler
access, no cmux, no IDE, or the documented `"infra-kit@infra-kit": false` opt-out
(`plugins/infra-kit/README.md:74-76`). doctor reports those as `fail` forever, so every invocation
re-offers them and the user cannot record "I decided no". OMC's marker plus `--force` gave them that.

Because optionality is not machine-readable (`doctor.ts:858`), the `--json` path cannot fix it either.
**This is a real capability loss, not a wash.** The proper fix is an `optional` flag on `CheckResult`,
which is out of scope; the honest move is to name the limitation and have the skill say plainly that a
declined row will be re-offered.

---

## 3. The standing mutating grant (consequence of decision 1)

Decision 1 is settled, so this section is consequence analysis only.

### 3.1 `Bash(infra-kit init)` + the proposed U18 is **not** sufficient — U18 catches 2 of 6 widening shapes

I lifted the suite's real predicate (`manifest.test.mjs:140-215`) and executed it against candidate
frontmatter/body pairs, alongside U18 as the plan specifies it (*no `*` in any `Bash(...)` rule in this
skill whose first token is `infra-kit`*). Results are mechanical:

| Shape | U6 | U18 | Effective grant |
|---|---|---|---|
| `Bash(infra-kit doctor)` + `Bash(infra-kit init)` — plan as written | GREEN | GREEN | narrow ✓ |
| `Bash(infra-kit init *)` | GREEN | **red** ✓ | caught |
| `Bash(infra-kit init*)` (glued) | GREEN | **red** ✓ | caught |
| **`Bash(node /abs/…/cli.js *)`** | GREEN | **GREEN** | **every CLI subcommand** |
| **`Bash(pnpm *)`** | GREEN | **GREEN** | **every pnpm command** |
| **bare `Bash`, zero fenced lines** | GREEN (corpus 0, rules 0) | GREEN | **unrestricted bash** |
| bare `Bash` + one fence | **red** (c2: 0 rules match) | GREEN | caught |
| `env FOO=1 infra-kit init` fenced | GREEN — **corpus excludes it** | GREEN | invisible to U6 |
| `sudo … node … service install` fenced | GREEN — **corpus excludes it** | GREEN | invisible to U6 |
| `infra-kit <anything>` (placeholder) | GREEN under `Bash(infra-kit init)` | GREEN | U6-green ≠ runnable |
| `infra-kit init && rm -rf /tmp/x` | **red** (c2 + c3) ✓ | GREEN | caught |

**The three holes, in severity order:**

1. **U18 is scoped by first token, so the natural spelling escapes it.**
   `Bash(node <abs>/apps/infra-kit/cli/dist/cli.js *)` has first token `node`, passes U18, and grants
   **every** infra-kit subcommand — `local-deploy`, `release deliver`, `env-token-set`,
   `worktrees remove`. This is not hypothetical: `doctor/SKILL.md:4` already ships
   `Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs *)`, and the plan's own
   step 1 tells the skill to fall back to `node <repo>/…/dist/cli.js`. It is the next edit someone
   makes. **U18 as specified does not protect the thing it exists to protect.**
2. **Bare `Bash` with no fences is a total grant that every guard passes.** `bashRules` (`:164`)
   matches only `/Bash\(([^)]*)\)/g`, so bare `Bash` yields zero rules; with an empty corpus both
   clauses are vacuous. Reachable precisely for a fence-free (print-only) variant of this skill — the
   shape decision 1 rejected, but also the shape a later "simplify the skill" edit drifts toward.
3. **`COMMAND_HEADS` gates the corpus, so a prefixed fence obliges nothing.** `env …`, `sudo …`,
   `bash -c '…'`, `NODE_OPTIONS=… …` all have heads outside `{node, python3, pnpm, git, infra-kit}`
   (`:140`), so U6, U15 and U18 never see them. Confirmed empirically: the `env`- and `sudo`-prefixed
   fixtures produced `corpus=1` — only the plain `infra-kit init` line entered.

In the plan's favour: these widen the *declared* grant, not Claude Code's matcher, which genuinely
does not match `env FOO=1 infra-kit init` against `Bash(infra-kit init)` — so a prefixed fence prompts
rather than running silently. The exposure is that **the plugin ships a broader standing grant than any
test reports** — pre-mortem 2's "failure mode with no symptom", relocated rather than closed.

### 3.2 What to build instead of U18 — a guard that catches 2 of 6 shapes is not a guard

The plan's U18 is a **deny-list on one character (`*`) restricted to one head (`infra-kit`)**. Both
restrictions are what let four shapes through. The replacement has three parts, and they are
independent — no single assertion closes all six.

**(1) The rule side must be an ALLOW-LIST of permitted rule strings, not a deny-list on `*`.**

A deny-list can only forbid spellings someone has already thought of. `Bash(node <abs>/cli.js *)` and
`Bash(pnpm *)` are not exotic — the first is the natural way to fence the plan's own `node
<repo>/…/dist/cli.js` fallback, and `doctor/SKILL.md:4` already ships a `node … *` rule as precedent.
So invert it: **per skill, pin the exact set of `Bash(...)` rule strings**, as a literal `deepEqual`.

- `doctor → ['infra-kit doctor', 'node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs *']`
- `setup → ['infra-kit doctor --json', 'infra-kit init']`

This is the same discipline `EXPECTED_SKILLS` (`:19`) and `EXPECTED_COMMANDS` (`:606`) already use, and
it costs the same thing they cost: a deliberate one-line edit with a visible diff whenever a grant
changes. It subsumes U18 entirely (a wildcard cannot appear without editing the literal), is
head-agnostic (so `node`- and `pnpm`-headed wildcards are caught), and makes the *next* skill's first
grant a reviewed event rather than a silent one. It is strictly stronger than anything shaped as "no
`*`", and it is the only form that catches a widening nobody predicted.

Keep one deny-list assertion alongside it as a cheap backstop for skills not yet in the map: no rule
may contain `*` unless the skill/rule pair is in the allow-list above.

**(2) The bare-`Bash` hole needs its own invariant, because it is not a rule at all.**

`bashRules` (`:164`) matches only `/Bash\(([^)]*)\)/g`, so bare `Bash` produces **zero** rules. With
zero fenced command lines the corpus is also zero, and clause 2 and clause 3 are both vacuous — U6
green, U18 green, unrestricted bash. An allow-list keyed on parsed rules cannot see this either,
because there is nothing to parse.

So add a separate assertion on the raw `allowed-tools` **string**: `Bash` must never appear without an
immediately following `(`. Verified as safe to add now — no live skill uses bare `Bash` (all seven have
`bareBash=false`). Note the adjacent shape that is *already* fine and must stay fine:
`update-toolchain` has `fences=0` and `bashRules=0`, i.e. a skill may legitimately have no fences and no
Bash grant at all. So the invariant is "any `Bash` mention must be parenthesised", **not** the stronger
"a skill with a Bash rule must have a non-empty corpus" — clause 3 already enforces that second
property for parenthesised rules (a rule matching no fenced line is a dead rule), and asserting it
again would only duplicate clause 3 while wrongly reddening fence-free skills.

**(3) The `env` / `sudo` hole must NOT be closed by widening `COMMAND_HEADS`.**

Tempting, and cheap in the narrow sense: I scanned every fenced line in all seven live skills, and
neither `env` nor `sudo` appears as a head today, nor would adding them produce any new hit in U5's
`scripts/` filter (`:369`) — that check is the second consumer of `COMMAND_HEADS`, as the comment at
`:138` warns. So the targeted widening breaks nothing right now.

It is still the wrong move, for two reasons the scan makes concrete:

- **`COMMAND_HEADS` is an allow-list precisely because fences hold non-commands.** The live fenced-line
  heads include `├──` (×8), `│` (×8), `#` (×5), `export` (×3), `└──`, `cd`, `features/[feature-name]/`,
  `Skill("oh-my-claudecode:ralplan")`, and prose like `scope → verdict → apply → verify`. Widening the
  set drags directory-tree art and comments into the corpus, where clause 2 then demands an
  `allowed-tools` rule for each — 27 newly-entering lines in `fe-architect` and `e2e-architect` alone.
  The set is narrow by design, not by oversight.
- **The enumeration can never be complete.** `NODE_OPTIONS=… node …`, `command infra-kit …`,
  `bash -c '…'`, backticks and `$( … )` all evade any finite head list. Whack-a-mole on heads is not a
  guard.

**The right closure already exists in the suite and the plan overlooked it.** U15 does not use
`COMMAND_HEADS` at all: it scans **raw** fenced lines for mutating invocations as substrings —
`fencedLines(parsed.body).flatMap((line) => MUTATING_INVOCATIONS.filter((needle) => line.includes(needle)))`
(`:477-479`). That substring form is inherently immune to the head problem: `env FOO=1 infra-kit init`
contains `infra-kit init` and is caught. So:

- **Generalise U15's `MUTATING_INVOCATIONS` (`:474`) from doctor-only to a per-skill map**:
  `doctor → []`, `setup → ['infra-kit init']`, default `[]`. Keep the substring matching and the raw
  `fencedLines` input — do **not** route it through `commandCorpus`.
- This simultaneously closes U15's scope gap. Today U15 is scoped to `DOCTOR_SKILL` (`:474-481`), so
  after this plan lands nothing stops the *next* skill fencing `audit --fix` or `--fix`.

**Coverage of the six shapes after (1)+(2)+(3):** `infra-kit init *` and `init*` → caught by (1);
`node …/cli.js *` and `pnpm *` → caught by (1); bare `Bash` → caught by (2); `env`/`sudo`-prefixed
mutating fences → caught by (3). The placeholder case (`infra-kit <anything>` satisfying
`Bash(infra-kit init)`) remains a U6-green-but-not-runnable oddity; it is fail-safe at the permission
layer and needs no guard, but the plan should stop treating U6-green as evidence a fence is runnable.

**Also drop Phase 2's "zero options" test.** `program.ts:658-664` confirms zero options today, but
flaglessness is a revocable state of one commit, not a security property: a future
`Bash(infra-kit init --force)` rule contains no `*`, passes U18, and is a brand-new standing grant —
whereas the allow-list in (1) catches it. What actually makes the grant safe is that every `init`
writer is **additive-never-overwrite by construction** (`plugin-pointer.ts:18-19`; the zshrc block is a
managed block; layer 3 is reseeded on every command regardless). Assert *that* of the new writer
instead.

### 3.3 Does running `init` from a skill interact badly with the MCP server path?

Not via imports — W4 shows `init` is not imported by the server, and never calls `confirmOrExit`. But
there is a real interaction the plan misses: **setup mutates the harness it is running inside.**

- `init` → `installPluginForProject` → **`spawnSync(CLAUDE_BIN, …)`** (`install-plugin.ts:81`). A live
  Claude Code session spawns a nested `claude plugin install --scope project` child, which writes the
  same `.claude/settings.json` the running session loaded.
- The new writer adds `.mcp.json` to that list. `.mcp.json` determines which MCP servers the session
  loads — including the **`infra-kit` server this session may be connected to**. A first-time write can
  trigger a reload of the very server whose tools the sibling `/infra-kit:release-create` command needs.
- The plan's step 5 covers **plugin** staleness only. **Extend it to MCP-server staleness.** Per the
  doctor skill's own step-3 insight (`doctor/SKILL.md:70-72`), "registered on disk" and "running in
  this session" look identical from the CLI side — which is exactly the failure the session half exists
  to catch.

---

## 4. Tensions the plan states as settled but are not

### T1 — Skill step 4 vs U19: compatible only because U19 as specified is a fail-open

`REPORT_OWNED_STRINGS` (`:490-502`) covers 11 of the 30 rows plus one section label. Step 4's
enumeration — *"tool installs, `gh auth login`, the Doppler token, the root portless step,
`pnpm-workspace.yaml`"* — hits **none** of those strings. So U19 would go green over a SKILL.md that
holds a 5-item second copy of doctor's inventory.

For contrast, `doctor/SKILL.md` survives U16 by pure circumlocution: *"the CLI's repair flag
(`--fix`)"* (`:83`), *"the setup command (`init`)"* (`:81`), *"the audit command's fix mode"* (`:85`).
It never names a row.

**Adjudication: step 4 as written violates principle 2, and U19 will not catch it.** Fixed by S1.

### T2 — "Fixes are listed, not run" vs running `init`

Decision 1 settles *whether*. My position on *consequence*: the grant is acceptable, but **not for the
reason the plan gives** (see §3.2 — additivity, not flaglessness, is what makes it safe), and **the
guard the plan proposes does not hold** (§3.1). This is the plugin's first standing prompt-free grant
for a mutating command, and after this lands nothing stops the next skill fencing `audit --fix` unless
U15's scope is generalised.

### T3 — `init` writing `.mcp.json` in a consumer repo

First, the calibration that survives: **`.mcp.json` is not categorically new.** Both `.mcp.json` and
`.claude/settings.json` are tracked (`git ls-files`), and `init` already *creates* the latter when
absent (`plugin-pointer.ts:161`) and adds `enabledPlugins` / `extraKnownMarketplaces` keys that change
what every teammate's session loads. Decision 2 accepts a blast radius `init` already had. The plan's
one-line admission is roughly calibrated.

**(a) Worktrees.** `resolveRepoRoot` returns `path.dirname((await getInfraKitConfigPaths()).main)`
(`agent-files.ts:41,54`), and `paths.main = path.join(projectRoot, INFRA_KIT_CONFIG_FILE)` where
`projectRoot = await getProjectRoot()` (`infra-kit-config.ts:421,432`). `getProjectRoot` is
**worktree-local** — the comment at `:422-427` says so explicitly, and that is precisely why layer 3
re-keys off `getMainRepoRoot`. So **`init` in a release or feature worktree writes `.mcp.json` — a
tracked file — into that worktree, i.e. onto that branch.**

**Self-correction.** My first pass recommended gating the write on the main repo root to avoid
dirtying release branches. That was wrong, and §8 explains why: Claude Code resolves `.mcp.json` and
`.claude/settings.json` from the session's cwd, so writing them at the main root would produce config
a worktree session never reads. **Worktree-local is correct for these files.** The real mitigation for
branch dirt is that the writer must be additive **and a no-op when the key is already present** —
which `ensurePluginPointer` already gives (`status: 'unchanged'`, no write, mtime untouched). Since
`.mcp.json` is committed at the same path on every branch, a worktree whose branch already has the
file produces **no diff at all**; dirt appears only in a branch that predates the file. That is a
bounded, one-time cost, and the honest thing is to state it rather than engineer around it.

**(b) Dirty tree / already committed differently.** `init` has no `--dry-run` and prints only after
writing (`logPointerResult`, `init.ts:254-258`). "Already committed differently" splits by verdict: a
*different sibling server* is the additive case and is safe (this repo's own `linear-server` entry is
the live fixture, and the plan's proposed value matches the committed `infra-kit` entry byte-for-byte);
a *deliberately different `infra-kit` entry* — absolute path, `--cwd` arg, wrapper — reads `ok` at
`:232` and is therefore never touched, which is correct and should be stated rather than left implicit.
No new guard is needed beyond additivity plus the skill naming the file before consenting. The repo
gate answers *"is this an infra-kit repo"*; it does not answer *"is this a checkout where a tracked-file
write belongs"* — the skill's pre-consent statement is what closes that.

**(c) Consumer repos.** hulyo and travelist have `infra-kit.json` at their roots, so `resolveRepoRoot`'s
gate (`agent-files.ts:48`) **passes** and `init` there will create or modify their tracked `.mcp.json`.
They run the **global** install, so they get this only after a publish — and local = published = 0.4.0,
so a release is required first. Same shape as the recorded "consumer local template must be https"
lesson: **a writer change is not self-contained.** Before the release, someone must inspect each
consumer's existing `.mcp.json` (present? which key? which siblings?), because the first `init` after
the upgrade produces a tracked diff in a repo whose owner did not run this plan.

### T4 — "No `SECTION_MEMBERS` edit is needed" is true but incomplete

Correct for the MCP row — it already exists, which genuinely dodges the recorded "adding a doctor check
breaks 2 tests" cost. But the ADR's own consequence (*"doctor's `missing-file → pass` carve-out becomes
unreachable in an init'd repo"*) is a **semantics change with a live test asserting the old meaning**:
`claude-plugin-checks.test.ts:209-213` asserts *"passes with a not-applicable note when there is no
.mcp.json"* and checks the message contains `'Not applicable:'`. That test stays green at unit level
while the behaviour it documents becomes practically unreachable, and nothing records the decision.
See §7.3 for the recommendation.

### T5 — the CI claim (W2) and the bump claim (W3)

Both stated as settled; both wrong; both change what a reviewer sees on a push to main.

---

## 5. Principle violations

The plan states five principles. Checked against itself:

**Principle 1 — "The CLI mutates; the session asks." Violated once.**
Step 1's binary resolution copies doctor's `node <repo>/…/dist/cli.js` fallback, but doctor is
**read-only** and setup is not. Here (local = published = 0.4.0) the difference is invisible; in a
worktree with a modified `init` the skill would mutate the machine via an unpublished CLI. The plan
copies the fallback without re-justifying it for a mutating command.

**Principle 2 — "Never hold a second copy of a list this skill does not own." Violated three times.**

1. Step 4's five-item enumeration — a second copy that U19 permits (T1).
2. The 30-row ownership table **is** a second copy of `SECTION_MEMBERS`, and it has already drifted in
   two ways: it renders `PORTLESS_SERVING_NAME` (`report.ts:80`) as the literal
   `"portless serving TLS on :443"`, and it asserts a per-row "fix owner" that no code records
   anywhere. **Verdict: acceptable in the plan** — it is the derivation artefact answering the owner's
   opening question, and the plan does name `report.ts` as authority (`:161-162`) — **but only if the
   plan states it is a dated snapshot and that none of it may migrate into the SKILL.md.**
3. The writer's verdict table duplicates `McpRegistration`'s five kinds. That duplication is the point,
   but the test meant to pin it is vacuous (§1e, defect e1).

**Principle 3 — "State is derived, never recorded." Upheld,** with the un-noted gap that the derivation
cannot distinguish *declined* from *missing* (§2.4).

**Principle 4 — "A standing grant must be un-widenable." Violated by its own guard.** U18 blocks `*`
only on `infra-kit`-headed rules and misses four of six widening shapes (§3.1); U15, the guard that
actually forbids fencing a mutating verb, is doctor-scoped (`:474-481`) and the plan does not extend
it. The stated security property (flaglessness) is not the one doing the work (additivity).

**Principle 5 — "Prefer deleting scope." Upheld overall.** One addition earns nothing: the "assert
`init` registers zero options" test guards a property that is not load-bearing.

---

## 6. Synthesis — concrete section-level edits

Each keeps Option A and its footprint. No new phase.

**S1 — rewrite Phase 3 steps 1/3/4 around `infra-kit doctor --json`.** *(fixes T1, principle 2(i), the
token/latency objection; makes step 4 implementable)*

- Step 1 runs **`infra-kit doctor --json`** once, as a *decision input*, not as a report. Frontmatter
  becomes `allowed-tools: Read, Bash(infra-kit doctor --json), Bash(infra-kit init)`. **Swap the rule,
  do not add it**: I verified that `Bash(infra-kit doctor)` does **not** match the line
  `infra-kit doctor --json` — it fails clause 2 (0 matches) *and* clause 3 (dead rule). One fenced
  line, one matching rule, still no `*`.
- Step 1 drops the "verbatim report" promise, states the resolved repo root and the gated steps before
  step 2 (pre-mortem 3a stands, strengthened per §8), and points at `/infra-kit:doctor` for the
  readable report. **One doctor run, not two** — doctor spawns `gh`, `doppler`, `aws` and TCP-probes
  portless, so a second run is the real latency cost.
- Step 3 becomes *"if the payload's remediation hint names the repair flag, offer it"* — never the two
  row names.
- **Step 4 becomes purely derived:** *"for every `status: 'fail'` row that neither `init` nor the
  repair flag owns, print that row's own `message` verbatim, in payload order. Restate nothing."*
  Delete the five-item enumeration. Add one honest sentence: a deliberately declined row will be
  re-offered every run, because optionality is not machine-readable (`doctor.ts:858`).
- The skill must not assume a fixed row count: the MCP row is conditionally omitted (`doctor.ts:1464`).
- U19 then becomes a real invariant, because nothing is left in the file to restate.

**S2 — replace U18 with the three-part guard in §3.2**: (1) a per-skill **allow-list of literal
`Bash(...)` rule strings** (head-agnostic, subsumes the `*` deny-list); (2) a raw-string invariant that
`Bash` never appears unparenthesised; (3) U15's `MUTATING_INVOCATIONS` generalised from doctor-only to a
per-skill map, keeping its raw-`fencedLines` substring matching so `env`/`sudo` prefixes cannot evade it.
Do **not** widen `COMMAND_HEADS` (§3.2(3) — it would drag 27 lines of directory-tree art and comments
into the corpus). Drop the "zero options" test; assert additivity of the new writer instead.

**S3 — fix Phase 1's round-trip criterion, which is vacuous.** See §7.1 for the concrete assertions.

**S4 — split the `unparseable` verdict in the writer's contract.** See §7.2.

**S5 — restrict the working-copy fallback to the read.** Setup may run `doctor --json` from
`node <repo>/…/dist/cli.js`; it must run `init` only from the resolved `PATH` binary, and say why. One
sentence in step 1. *(fixes principle 1)*

**S6 — fix decision driver 2 and add the CI acceptance line.** Replace *"`publish-gate.test.mjs` is red
on main"* with: *`publish-gate.test.mjs` is a green unit test; the red artefact is
`scripts/check-workflow-resource-published.mjs` at `plugin-ci.yml:54-55`, and because plugin-ci is one
job triggered on `plugins/**`, the setup skill's push to main will show a red plugin-ci run from a step
unrelated to the skill.* Add to Phase 3 acceptance: say so in the commit message, and note that
`pnpm run qa` is green locally because it never runs the script (`package.json:23-24`). Also correct
Phase 3's *"CI fails otherwise"* on the version bump — U9 is PR-only (`plugin-ci.yml:45`) and this repo
commits straight to main, so the bump is unenforced (W3).

**S7 — correct W1, W4, and the config citation.** Say the `EXPECTED_SKILLS` edit exists **only** to keep
U3 green (`manifest.test.mjs:324`); U2/U4/U5/U6/U12/T1 apply by directory walk the moment the file
exists. Delete §Interactivity reason 3 and the `confirmOrExit` support (W4). Correct the config
citation to `lib/infra-kit-config/infra-kit-config.ts:236,278,671`.

**S8 — amend Phase 2 rather than adding to it.** Per §1f: two INFO lines already exist at
`agent-files.ts:43,49`; amend those strings to name all four gated steps instead of adding a third
message. Assert by message, same style.

**S9 — extend step 5 to MCP-server staleness**, not just plugin staleness (§3.3).

**S10 — add a consumer-repo pre-release step**: inspect hulyo's and travelist's existing `.mcp.json`
before the release that ships the writer (§T3c).

**S11 — mark the 30-row table a dated snapshot** of `report.ts:60-85`, forbid its migration into the
SKILL.md, and note that the token-budget re-measure is enforced by nothing.

### Remaining open questions, with my calls

- **(3) sudo:** never. The portless `:443` install stays a printed absolute-path command
  (`doctor.ts:1119`). Mention the portless rows only as whatever `message` doctor emits — S1 gets this
  for free.
- **(4) Doppler:** in scope but never enumerated; S1 makes it free either way.
- **(5) `pnpm enableGlobalVirtualStore`:** report only. Agreed — it is a line in a tracked
  `pnpm-workspace.yaml` (`doctor.ts:164-195`).
- **(6) Version:** `0.4.0`. A new component, and note W3 — nothing enforces it.
- **(7) Description:** the proposed wording is good; consider dropping *"on this machine and repo"* so
  the three concrete nouns carry the match.

---

## 7. Consequences of decision 2 — `init` always creates `.mcp.json`

Decision 2 makes the two item-(e) defects more load-bearing, because the writer now runs on every
`init` in every infra-kit repo rather than only on a repair path.

### 7.1 Defect e1 — what actually pins writer↔reader agreement

`inspectMcpRegistration` returns `ok` on **key presence alone** (`install-state.ts:232`), so the plan's
criterion *"for every case that wrote, `inspectMcpRegistration(root)` returns `{ kind: 'ok' }`"* would
pass on `{"mcpServers":{"infra-kit":null}}`. Replace it with three assertions:

1. **Value-level, not key-level.** Assert the written entry satisfies `looksLikeInfraKitServer`
   (`:198-205`) directly. That predicate is currently module-private — **export it**, or assert the
   `command` / `args` bytes explicitly. This is the assertion the plan believed it was making.
2. **The reverse direction.** Take the writer's own value, file it under `ik`, and assert
   `inspectMcpRegistration` returns `{ kind: 'wrong-key', key: 'ik' }`. This is what actually pins the
   two halves: it proves the writer's output is recognisable *as* infra-kit's server by the same
   predicate the reader uses to detect misfiling.
3. **Refuse, never add-alongside.** Assert that on a `wrong-key` fixture the writer performs **no
   write**. Without this, an `infra-kit` key added beside a misfiled `ik` yields `ok` (because `:232`
   short-circuits before `:235`) and doctor certifies a repo running **two** infra-kit servers. This
   state is currently untested and unmentioned in the plan.

### 7.2 Defect e2 — must the writer distinguish "no `mcpServers` key" from "malformed bytes"? **Yes, and it can be done writer-side only**

`install-state.ts:228` returns `unparseable` when `parsed` is not a plain object **or**
`parsed.mcpServers` is not a plain object. So a valid `{"$schema": "…"}` is `unparseable`, and under
the plan's contract the writer refuses and leaves it alone while `doctor.ts:1030` says *"fix the
JSON"* about JSON that is fine.

Decision 2 makes this untenable: *"it will be in the repo at any cost"* cannot coexist with a rule that
permanently strands a repairable file. So:

- **The writer must key off its own parse, not the reader's verdict.** Three writer-side outcomes:
  bytes that fail `JSON.parse` → **refuse**, warn, leave byte-for-byte alone (`ensurePluginPointer`'s
  exact behaviour, `:167-177`); parses to a plain object with no usable `mcpServers` → **add the
  container additively**, exactly as `addPointerKeys` already does for a missing container
  (`plugin-pointer.ts:95-100`); parses with `mcpServers` present → the four existing verdict paths.
- **No reader change is required, and none should be made in this plan.** Once the writer creates the
  container, `inspectMcpRegistration` re-reads the file and returns `ok`, so doctor's verdict vocabulary
  is untouched and the round-trip assertions in §7.1 still apply. Narrowing the reader's `unparseable`
  into a fifth kind would change doctor's message set and its test surface for no behavioural gain —
  correct as a follow-up, wrong as a dependency.
- Add one fixture: valid JSON, no `mcpServers` key → container created, every existing top-level key
  (e.g. `$schema`) byte-identical and still first, indent and trailing newline preserved.

### 7.3 Does `missing-file → pass` become dead code? **No — reachable but misjustified. Keep `pass`, rewrite two strings, in scope**

Because the row is omitted outside a repo (`doctor.ts:1464`), `checkMcpServerKey` only ever runs inside
a repo whose root resolved. Once `init` always creates the file, `missing-file` is reachable in exactly
one state: **an infra-kit repo where `init` has never run** (or ran on a pre-writer CLI).

- **Not `fail`.** That would make it a second copy of a signal two rows already carry: `zshrc init
  block` and `CLAUDE.md block` both fail in an un-init'd repo with `infra-kit init` as their own fix
  hint (`doctor.ts:91,102,113` and `:903`). A third is a principle-2 violation *inside doctor*. It also
  changes nothing operationally — `program.ts:567-571` scopes exit 1 to `plugin installed` alone.
- **Not "leave alone".** The carve-out's justification at `:1035-1037` — *"a repo that has chosen not to
  register any MCP server has no key to get wrong"* — asserts an abstention decision 2 has abolished.
  Leaving a comment that states a retired rationale is exactly the staleness principle 2 targets.
- **Recommendation: keep the verdict in `MCP_NON_FAILING` (`:1039`) and change two strings** — the
  `missing-file` message (`:1029`, currently *"Not applicable: no .mcp.json at the repo root, so there
  is no server key to check"*) so it names `infra-kit init` as the fix, and the comment at `:1033-1038`
  so it says the file is now always written and this verdict means "init has not run here".
  **In scope**: two strings, no `SECTION_MEMBERS` edit, no new row. `claude-plugin-checks.test.ts:209-213`
  asserts the message contains `'Not applicable:'`, so it updates in the same commit — which is the
  visible diff that records the decision (answering T4).

### 7.4 `wrong-key` — recommendation only, not a decision

**Recommendation: keep `wrong-key → refuse` inside `init`; make the rename available as an explicit,
separately-invoked action.**

*"It will be in the repo at any cost"* is a statement about the file's **existence**, not about
overriding its **content**. `wrong-key` is the single state where the file exists and the infra-kit
server is registered under a key **a human deliberately typed**. A machine-setup command silently
renaming a key in a tracked, shared file — inside a `try/catch` that swallows failures to `debug`
(`init.ts:319-326`) — lands a semantic edit to someone else's decision in a commit nobody reviewed.
That is the one place `init`'s additive-only discipline would break.

Two facts that make refusing load-bearing rather than merely cautious: the add-alongside hazard in
§7.1(3); and doctor already emits the exact hand-fix (`doctor.ts:1057`), so refusing costs the user
nothing but a read.

If the owner does want the rename, the clean home is the optional top-level `infra-kit mcp-register`
from §2.3 — one implementation, `init` calls it, `--rename` is a flag rather than a future new command.
**Owner's call; I recommend refuse-in-`init` either way.**

---

## 8. Decision 3 — splitting the repo gate

**Proposal under review.** Split the single gate in `resolveRepoRoot` (`agent-files.ts:37-56`): guidance
sync stays gated on `<git-root>/infra-kit.json`, while the plugin pointer, plugin install and the new
`.mcp.json` writer gate instead on "inside a git repo" via `getMainRepoRoot`
(`lib/git-utils/git-utils.ts:179`).

### 8.1 The problem is real and the split is the right shape — **endorsed in principle**

Today `resolveRepoRoot` returns `null` unless `<toplevel>/infra-kit.json` exists (`:48-52`), and all
four steps hang off that one value (`init.ts:94,98`). So **a fresh repo without `infra-kit.json` cannot
be set up at all**: `init` writes the zshrc block, migrates and reseeds config, prints *"Run `source
~/.zshrc`…"* (`:114`), exits 0, and silently does none of the plugin, install or MCP work — while
`agent-files.ts:49` mentions only "agent-instruction files". The plugin and MCP steps have **no
dependency on `infra-kit.json`**: `ensurePluginPointer` writes `.claude/settings.json`,
`installPluginForProject` drives `claude plugin install --scope project`, and the writer writes
`.mcp.json`. Gating them on a config file they never read is incidental coupling. **Endorse the split.**

### 8.2 But `getMainRepoRoot` is the **wrong gate**, for the exact reason it exists — **reject that half**

`getMainRepoRoot` (`git-utils.ts:179-189`) resolves `git rev-parse --git-common-dir` and returns
`path.dirname(resolved)`, converging every linked worktree on the main repo — its doc at `:159-165`
says it is *"the stable identity to key per-repo state on (unlike `getProjectRoot`, whose basename is
the worktree's leaf directory inside a worktree)"*.

That convergence is correct for **identity** (it is why layer 3 keys off it) and wrong for **file
location**. Claude Code resolves `.claude/settings.json` and `.mcp.json` from the **session's cwd**. Gate
the plugin/MCP steps on the main root and, inside a worktree, `init` writes the pointer keys and
`.mcp.json` at `<main>/` and drives `claude plugin install --scope project` for `<main>` — **config the
worktree session never reads.** Sessions do run in worktrees: that is the whole `ik worktrees add` /
`reopen` / cmux-per-repo-group flow. The proposal would silently break the case it is trying to serve.

This also corrects my own first-pass recommendation, which suggested main-root gating for `.mcp.json` to
avoid dirtying release branches. That trade is backwards: correctness of the config location beats
branch tidiness, and the tidiness concern is bounded anyway (§T3a — the writer is additive and a no-op
when the key is present, and the file is committed at the same path on every branch, so only a branch
predating the file sees a diff).

Four further properties make `getMainRepoRoot` a poor gate mechanically:

1. **It never returns `null` — it throws.** Signature is `Promise<string>`. With no argument it calls
   `getProjectRoot()`, which throws an `OperationError` outside a repo or with git absent
   (`git-utils.ts:150-155`). A gate needs a three-state answer, so the call must be wrapped. Worse,
   `syncPluginPointer`'s existing `try/catch` logs only at **`debug`** (`init.ts:322-326`), so an
   unwrapped throw would make a git-less machine skip **silently** — strictly worse than today's INFO
   line at `agent-files.ts:43`.
2. **Submodules return something different from what the name promises.** Per the carve-out at `:185-187`,
   when the resolved common dir contains `/.git/modules/` it returns the caller's own toplevel. Benign
   for a gate (a submodule *is* a checkout), but the plan must say so rather than inherit it silently.
3. **Bare repositories.** `--git-common-dir` returns `.` in a bare repo, so `path.dirname` yields the
   **parent** of the repo. In practice `getProjectRoot`'s `--show-toplevel` throws first, so the bare
   case never reaches it — but only by accident, and only while the caller passes a toplevel.
4. **A second `git` shell-out per `init` run**, for a question the first one already answered.

### 8.3 The cheaper gate that keeps the `$HOME` protection

Use the git toplevel that is already resolved, not a second query:

- **Gate the plugin, install and MCP steps on `getProjectRoot()`** — worktree-local, one `git rev-parse
  --show-toplevel`, already called on the guidance path via `getInfraKitConfigPaths`
  (`infra-kit-config.ts:421`). Wrap it so a throw becomes a **logged skip**, not a `debug` swallow.
- **Keep guidance gated on `<toplevel>/infra-kit.json`** exactly as today (`agent-files.ts:48`).
- **Add the `$HOME` guard explicitly.** "Inside a git repo" does **not** protect `$HOME`: users who
  git-manage their dotfiles have a repo at `$HOME`, and the plan's own recorded reason for the gate is
  *"outside an infra-kit repo it does nothing rather than writing a `.claude/` directory into whatever
  the cwd happens to be"* (`init.ts:306-308`). So add `toplevel !== os.homedir()`. One comparison, no
  extra shell-out, and it preserves the protection the `infra-kit.json` gate was providing incidentally.
- **Restructure, don't duplicate.** `resolveRepoRoot` currently conflates two questions. Split it into
  `resolveGitRoot()` (toplevel, not `$HOME`) and `resolveInfraKitRoot()` (that root, plus
  `infra-kit.json` present), the second built on the first. Two call sites, one shell-out, and each
  skip message names its own steps (S8).

### 8.4 Does the split break "the pointer keys and the installation name one project"? **No**

The invariant in `syncPluginPointer`'s doc comment (`init.ts:303-310`) is *pointer ↔ installation*: both
are driven from **one** `root`, so `ensurePluginPointer(path.join(root, '.claude', 'settings.json'))`
and `installPluginForProject({ projectRoot: root })` agree about what `--scope project` recorded. It is
not *guidance ↔ pointer*. Splitting guidance onto a different predicate preserves the invariant as long
as pointer, install and the MCP writer continue to share **one** root — which §8.3 does.

One thing the plan must state: with the split, `init` can now write `.claude/settings.json` and
`.mcp.json` into a repo that has **no `infra-kit.json`**. That is the intent of decision 3, and it is
sound, but it widens the writer's reach from "infra-kit repos" to "any git checkout that is not `$HOME`".
The skill's pre-consent statement (S1, pre-mortem 3a) must therefore name the resolved root **and the
fact that the two gates differ**, so a user in a non-infra-kit repo understands that they get the
plugin and MCP steps but not the guidance blocks.

---

## 9. Bottom line

**Sound with modifications.** The architecture is right, the footprint is genuinely minimal, and the
central gap claim is real: nothing in the CLI writes `.mcp.json` (§1c, verified repo-wide). Option A
survives the antithesis. All three owner decisions are implementable.

But four things need fixing before implementation, and two of the plan's stated reasons are wrong.

**Required:**

1. **S1** — rewrite steps 1/3/4 around `infra-kit doctor --json` (`program.ts:756`,
   `doctor.ts:557-560,1472-1483`). The plan argues the pre-check against the wrong interface, and this
   is what makes step 4 implementable and U19 non-vacuous.
2. **S2** — replace U18 with the three-part guard in §3.2. U18 as specified passes **four of the six**
   widening shapes I executed against the repo's own predicate (§3.1): a deny-list on `*` restricted to
   `infra-kit`-headed rules cannot see `node …/cli.js *`, `pnpm *`, bare `Bash`, or an `env`/`sudo`
   prefix. The fix needs an allow-list on the rule side, a raw-string invariant for bare `Bash`, and
   U15's substring scan generalised per skill — not a wider `COMMAND_HEADS`.
3. **S3 / §7.1** — fix the vacuous round-trip criterion; `inspectMcpRegistration` returns `ok` on key
   presence alone (`install-state.ts:232`). Add the reverse-direction and refuse-never-add-alongside
   assertions.
4. **S4 / §7.2** — the writer must distinguish "no `mcpServers` key" from "malformed bytes", writer-side
   only, with no reader change.
5. **§7.3** — rewrite doctor's `missing-file` message and comment in the same commit; keep the `pass`.
6. **§8.2-8.4** — endorse the gate split, but gate on `getProjectRoot()` plus `!== os.homedir()`, not
   `getMainRepoRoot` (which converges worktrees, throws instead of returning `null`, and would write
   config a worktree session never reads).
7. **S6 / S7 / S8** — fix W1 (`EXPECTED_SKILLS` mechanism), W2 (the red lane is the workflow, not the
   test — a skill-only push to main *will* show red plugin-ci), W3 (U9 is PR-only, so the version bump
   is unenforced here), W4 (delete the two unsound `init` supports), and amend Phase 2 rather than
   adding to it (`agent-files.ts:43,49` already log).

**Recommended:** S5 (fallback for the read only), S9 (MCP-server staleness in step 5), S10
(consumer-repo pre-release inspection), S11 (snapshot the row table, note the unenforced token budget).

**Optional:** the top-level `infra-kit mcp-register` entry point, which also gives `wrong-key --rename`
a home.

No rethink is warranted. The plan's shape is correct; its evidence needs the corrections above.

---

## Appendix — files cited

`docs/infra-kit-setup-skill-plan.md`;
`apps/infra-kit/cli/src/lib/infra-kit-config/infra-kit-config.ts`;
`apps/infra-kit/cli/src/lib/plugin-pointer/plugin-pointer.ts`;
`apps/infra-kit/cli/src/lib/plugin-pointer/install-state.ts`;
`apps/infra-kit/cli/src/lib/plugin-pointer/install-plugin.ts`;
`apps/infra-kit/cli/src/lib/git-utils/git-utils.ts`;
`apps/infra-kit/cli/src/lib/program/program.ts`;
`apps/infra-kit/cli/src/lib/command-catalog/command-catalog.ts`;
`apps/infra-kit/cli/src/commands/init/init.ts`;
`apps/infra-kit/cli/src/commands/init/agent-files.ts`;
`apps/infra-kit/cli/src/commands/doctor/doctor.ts`;
`apps/infra-kit/cli/src/commands/doctor/report.ts`;
`apps/infra-kit/cli/src/commands/doctor/__tests__/claude-plugin-checks.test.ts`;
`plugins/infra-kit/__tests__/manifest.test.mjs`;
`plugins/infra-kit/__tests__/publish-gate.test.mjs`;
`plugins/infra-kit/skills/doctor/SKILL.md`;
`plugins/infra-kit/README.md`;
`plugins/infra-kit/.claude-plugin/plugin.json`;
`.github/workflows/plugin-ci.yml`;
`package.json`;
`.mcp.json`.

---

# Round 2 — review of revision 2 (2026-09-10)

Scope: only what is new in revision 2. Round-1 findings stand unchanged; all seven required
modifications were applied, and §R2.5 confirms they were applied faithfully rather than nominally.

## R2.1 — The MCP row's gate alignment in commit 1: right decision, wrong rationale, two hidden costs

**The decision is correct, and the alternative the Planner rejected is worse.** Leaving doctor alone
would mean `init` writes `.mcp.json` in any git toplevel (post-split) while
`resolveCheckedRepoRoot` (`doctor.ts:919-927`) still requires `<toplevel>/infra-kit.json` and
`doctor.ts:1464` omits the row without it. Since the skill's steps 1, 3 and 4 are now **entirely
payload-derived**, the skill could not confirm the write it just caused, nor surface a misfiled key,
in precisely the repos decision 3 exists to serve. That ships a writer with **no monitor** and makes
revision 1's "standing monitor for #30, no new check to add" false. That is a correctness argument.

**The plan leads with a convenience argument instead, and should not.** Its first two bullets are
"`resolveGitRoot()` is being built in that commit anyway" and "the comment is being rewritten there
anyway". Both are true and neither justifies a semantic change to doctor's row set. The third bullet
(the skill would need an "unverifiable here" caveat) is the real one. **Re-order: correctness first,
marginal cost last.** As written the section reads as scope creep dressed as cohesion, which is what
invited this challenge.

**`SECTION_MEMBERS` genuinely does not need touching — plan correct.** `DOCTOR_CHECK_NAMES` derives
from it (`report.ts:107-109`) and `report.test.ts:90-91` pins `toHaveLength(30)` plus set-size 30. The
gate changes *whether a row renders*, not the inventory. No edit.

**No test asserts the MCP row's absence — the plan is over-cautious here.** I searched
`report-inventory.test.ts` and `claude-plugin-checks.test.ts` for absence assertions; the only
`not.toContain` is `claude-plugin-checks.test.ts:155` (`'/Users/someone/d'`, a path-redaction
assertion, unrelated). The plan's "tests asserting the omission update in the same commit" implies
such tests exist. **They do not.** Say so; a reader will otherwise hunt for them.

**Hidden cost 1 — `report-inventory.test.ts` will break, or pass by accident. This is the finding.**
That suite is the reconciliation half of the section-map drift guard: `:148` asserts
`[...produced].sort()` from a **real `doctor()` run** equals all 30 `DOCTOR_CHECK_NAMES`. Its
determinism comes from mocking every external seam — including a **total** mock of
`src/lib/infra-kit-config` (`:73`, a factory with no `importOriginal`) and of `zx` with
``$ → Promise.resolve({ stdout: '' })`` (`:130-136`). It does **not** mock `src/lib/git-utils`.

Today the row renders because `resolveCheckedRepoRoot` resolves through the mocked config paths to the
temp fixture. After the predicate becomes `resolveGitRoot()`, it resolves through
`getProjectRoot()` — which is `return result.stdout.trim()` with **no blank-output check**, throwing
only on spawn failure (`git-utils.ts` `getProjectRoot`). Under the `zx` mock it therefore returns
`''`. Two outcomes, and the plan specifies neither:

- **`resolveGitRoot()` treats `''` as a valid root** → `'' !== os.homedir()` passes the `$HOME` guard →
  the row renders with root `''` → `checkMcpServerKey('')` does `path.join('', '.mcp.json')` =
  `'.mcp.json'` → `fs.existsSync` **relative to `process.cwd()`**, which in-suite is the real
  repository, whose `.mcp.json` exists → verdict `ok`. The test stays green **by accident**, reading
  the live repo's file, and the new gate goes untested in the one suite that reconciles the row set.
- **`resolveGitRoot()` rejects `''`** — the correct implementation, since an empty string is not a
  root → the row is omitted → 29 names → **`report-inventory.test.ts:148` goes RED.**

So "the marginal cost is one call site" is **false**. The real cost is three things: specify that
`resolveGitRoot()` treats blank `git rev-parse` output as a failed resolve (not just a thrown `$`); add
a `src/lib/git-utils` mock to `report-inventory.test.ts` returning the fixture dir; and list that file
in the plan's file inventory and acceptance criteria. Note the same blank-output hazard applies to the
production `$HOME` guard: `'' !== os.homedir()` passes, so without the blank check the guard is
bypassable whenever `git rev-parse` succeeds with empty stdout.

**Hidden cost 2 — the row now renders in any git repo, where `missing-file` is the ordinary pre-`init`
verdict.** The plan states this. Worth one added sentence: combined with §Doctor's `missing-file`
keeping the verdict a `pass`, a plain non-infra-kit git repo now shows a passing `MCP server key` row
that means "nothing here yet", which is benign but is a new reading of that row for a new audience.

## R2.2 — The Planner's correction to the Critic: **all four sub-claims VERIFIED; the override stands**

Critic item 1 was wrong. Each sub-claim, checked:

- **Exactly ONE `outputSchema`.** `doctorMcpTool` is declared once at `doctor.ts:1487-1510`, with a
  single `outputSchema` at `:1490-1502` (`checks` array of `{name,status,message}`, plus `allPassed`).
  Nothing else in the file declares one. ✓
- **`9983015`'s drift lane is a different subsystem.** Confirmed: it concerns `buildRequestedSchema`
  for the confirm-gate form and does not touch `doctorMcpTool`. ✓
- **`command-catalog.test.ts` pins only the top-level key set.** The golden-surface test maps
  `output: Object.keys(tool.outputSchema).sort()` (`:187`), i.e. `['allPassed','checks']`. A field added
  *inside* the `checks[]` item schema is a value inside the `checks` zod schema and changes no
  top-level key. ✓ **And it is safer than the plan claims:** that test iterates
  `getExposedMcpTools()`, and doctor is `mcpExposed: false` (`command-catalog.ts:471`), so **doctor is
  not in that surface at all.**
- **The MCP e2e whole-object comparison sees only served tools.** `assertToolsMatchBaseline(toolsResult)`
  iterates the `tools/list` result (`mcp-stdio.e2e.test.ts:1809-1825`), and
  `mcp/tools/index.ts:9-11` states doctor "is intentionally excluded there (host-inspecting) and must
  never be registered here." ✓

So `fixable` breaks no guard. **But this verification exposes an internal contradiction in the plan**
that item R2.3 turns to advantage: the plan asserts *"A top-level field would break it — which is why
the CLI-floor check below reads a message prefix instead of adding one."* That is false by the plan's
own adjacent bullet. Since doctor is excluded from `getExposedMcpTools()`, a **top-level** field on
doctor's `outputSchema` breaks `command-catalog.test.ts` no more than a nested one does.

## R2.3 — The CLI floor via the `` `infra-kit CLI ` `` message prefix: **the stated blocker does not exist; use a payload field**

The concern is right. A message prefix is load-bearing for the skill and **nothing guards it** — the
same silent-staleness family U16/U19 exists to prevent, relocated from a row name to a message body.
Confirmed: there is **no version field** in the payload (`structuredContent` is exactly
`{ checks: [{name,status,message}], allPassed }`, `doctor.ts:1472-1479`), and the version reaches the
payload only inside `` `infra-kit CLI ${packageJson.version}` `` (`:1022`).

**Ruling: add the field.** Per R2.2, the plan's reason for preferring the prefix is wrong — a
top-level addition to doctor's schema is as safe as the nested `fixable` one, because doctor is not a
served tool. So add `cliVersion: packageJson.version` to `structuredContent` and to the one
`outputSchema`, in the **same commit as `fixable`**: identical blast radius (nil), one extra line, and
it retires the prefix dependency completely. A version is exactly the kind of thing a structured
payload should carry, and the skill's floor check becomes a comparison rather than a parse.

**If the owner declines the field, the prefix needs two guards, not one:**

1. **Producer-side pin**, in `claude-plugin-checks.test.ts` beside the row it constrains: assert the
   `CLI version` entry's message starts with `infra-kit CLI ` **and** that the remainder parses to
   `packageJson.version`. That puts the contract next to its producer, where a rename reddens.
2. **Fail-safe in the SKILL.md**: if no payload entry matches the prefix, the skill **skips** the floor
   check and says so — it must never treat "no match" as "floor met". Without this the failure is
   silent in the worst direction.

Dropping the floor check entirely is the third acceptable answer, and is better than shipping the
prefix with neither guard.

## R2.4 — Step 4 is genuinely derivable: **VERIFIED**, with one thing to record

The runnable command text lives in the **check layer**, inside `message`, not in presentation. Every
human-action row carries it:

- `portless routes` — `formatPortlessCommand(['alias','--remove','<name>'], { bin })` embedded at `:1249`.
- `portless serving TLS on :443` — `installDaemonCmd(bin)` = `formatPortlessCommand(['service','install'], { sudo: true, bin })`, `:1076-1078`, embedded in the message at `:1119`.
- `portless CA trusted` — `trustCmd(bin)` = `formatPortlessCommand(['trust'], { bin })`, `:1081-1083`.
- Tool rows — `Install from: https://…` (e.g. `:1391`).
- `marketplace registered` — `claude plugin marketplace add ${MARKETPLACE_REPO}` at `:1018`.
- `tokens.json perms` — `Fix: run \`infra-kit doctor --fix\`, or chmod them by hand.` at `:605`.

The recorded portless constraint is satisfied: `doctor.ts:1257` states the command is printed via
`formatPortlessCommand` "as `<node> <cli.js> …`, the only form that runs". Only `report.ts:350-358`'s
rollup hint is presentation-only, and `fixable` replaces exactly that. **So the payload carries what
steps 3 and 4 need, and the plan has not traded one fail-open for another.**

One residual, already consistent: the `portless routes` message embeds a literal `<name>` placeholder
and is therefore not runnable as-is — but that row is `fixable: true`, so step 3 owns it and step 4
excludes it. That is precisely why the plan's "prefer the flag over that row's message" instruction is
correct rather than fussy.

**Record one line the plan is missing:** step 4's derivability rests on remediation text living in the
check layer. A future refactor that moved command construction into `report.ts` (where the `--fix`
hint already lives) would break the skill **silently**, because `--json` skips presentation. That is
worth a sentence in the observability section, next to the existing "doctor's report goes to stderr".

## R2.5 — Round-1 modifications: applied faithfully, not nominally

- **(1) Allow-list pinned by `deepEqual`** — present, per-skill, with the normative-copy framing ("the
  next editor changes the SKILL.md and should expect a red test").
- **(2) Bare-`Bash` raw-string invariant** — present, and the over-reach is explicitly refused: the
  plan states *"Do not strengthen this to 'a skill with a Bash rule must have a non-empty fenced
  corpus'"*, with both reasons I gave (`update-toolchain` has zero fences and zero rules; clause 3
  already covers parenthesised rules).
- **(3) U15 generalisation, not `COMMAND_HEADS` widening** — present, with my empirical head census
  (`├──` ×8, `│` ×8, `#` ×5, `export` ×3, 27 newly-entering lines) and the substring/raw-`fencedLines`
  requirement preserved. The Planner improved on my version: it splits U15 into a **global** deny set
  plus a per-skill permit map, so setup's one mutation sits in a second reviewed allow-list.
- Coverage table, the retained placeholder caveat, and "stop treating U6-green as evidence a fence is
  runnable" all carried over.
- Corrections C1/C2/C3, the gate split with `getProjectRoot()` + `$HOME`, the `--json` pre-check, the
  two `install-state.ts` defect fixes and the `missing-file` message rewrite are all in place.

## R2.6 — Verdict

**APPROVE-FOR-CRITIC.** No redesign is needed. Revision 2 answers every round-1 required
modification, and the two genuinely new design decisions — the `fixable` field and the MCP row's gate
alignment — are both correct. The `fixable` field breaks no guard (R2.2, verified four ways), and step
4 is derivable against the real payload (R2.4, verified row by row).

Three items must land in the plan text before implementation. None is a design change:

1. **`report-inventory.test.ts` is an unlisted casualty of the commit-1 gate alignment** (R2.1). Specify
   that `resolveGitRoot()` treats blank `git rev-parse` output as a failed resolve — the `$HOME` guard
   is bypassable without it — add a `src/lib/git-utils` mock to that suite, and list the file in the
   inventory and acceptance criteria. As written, commit 1 either reddens that test or passes it by
   accident while reading the live repo's `.mcp.json` through a relative path.
2. **Replace the `` `infra-kit CLI ` `` prefix dependency with a top-level `cliVersion` payload field**
   (R2.3). The plan's stated reason for avoiding a top-level field is contradicted by its own finding
   that doctor is excluded from `getExposedMcpTools()`. If the field is declined, add both the
   producer-side message pin and the SKILL.md fail-safe.
3. **Re-order the gate-alignment justification to lead with correctness** and correct two statements
   (R2.1): no test asserts the MCP row's absence, and the cost is not "one call site". Add the
   observability line from R2.4 about remediation text having to stay in the check layer.
