# Critic review — `/infra-kit:setup` plan

Reviewer: critic pass of a ralplan `--deliberate` consensus loop. Read-only with respect to
`docs/infra-kit-setup-skill-plan.md`, `docs/infra-kit-setup-skill-plan.architect-review.md`, and all
source. This file is the only artefact written.

Judged against the plan **as it would stand after the Architect's seven required modifications**. The
Architect's findings are taken as established and are not repeated. Line numbers are from the working
tree at the time of review (main, dirty: ~30 modified CLI files).

---

## 0. The one finding that changes an already-adopted decision

**S1 rescues step 4 and breaks step 3. Fixability is not in the `--json` payload, and one of the two
fixable rows' messages points at the wrong command.**

The Architect's S1 rewrites step 3 as *"if the payload's remediation hint names the repair flag, offer
it."* That is not implementable. Measured:

- `structuredContent` is built at `doctor.ts:1472-1479` and is **exactly**
  `{ checks: [{ name, status, message }], allPassed }`. There is no fixability field, no section, no
  hint. `--json` skips presentation (`program.ts:553-560`), and the `--fix` hint lives **in
  presentation**: `report.ts:356`, `` `${fixable} fixable — run \`infra-kit doctor --fix\`` ``. So
  `--json` discards precisely the one datum step 3 needs.
- Worse, fixability is *deliberately* not message-derivable. `report.ts:114-117`: the hint *"is driven by
  this set rather than by matching message text, so it cannot drift from the real `--fix` code paths."*
- And the messages disagree with each other. `tokens.json perms` names the flag
  (`doctor.ts:605` — *"Fix: run `infra-kit doctor --fix`, or chmod them by hand."*). `portless routes`
  does **not**: its fail message (`doctor.ts:1249`) names
  `` `portless alias --remove <name>` `` — a **manual** command. So a step 4 that echoes `message`
  verbatim sends the user down the hand-removal path for a row `doctor --fix` owns.

Consequence for U19 (item 4 below): the only way to implement step 3 by naming things is to write
`portless routes` and `tokens.json perms` into the SKILL.md — and **both strings are in
`REPORT_OWNED_STRINGS`** (`manifest.test.mjs:490-502`). So U19 is *not* a fail-open with respect to
step 3; it is a hard blocker on the naming implementation. Good news for the guard, bad news for the
step.

Three options, ruled:

- **(a) Name the two rows.** Violates principle 2 and trips U19. Reject.
- **(b) Run doctor twice** — once `--json` for decisions, once plain to read the rendered `N fixable`
  summary. S1 explicitly rules this out, correctly: doctor spawns `gh`, `doppler`, `aws` and TCP-probes
  portless, so a second run is the real latency cost. Reject.
- **(c) Put fixability in the payload.** Add `fixable: FIXABLE_NAMES.has(c.name)` to each entry in
  `doctor.ts:1473-1475`. Then step 3 is `checks.filter(c => c.status === 'fail' && c.fixable)`, names
  zero rows, keeps U19 whole, and derives from the single source that by its own comment *cannot drift*.
  **Adopt.**

Costs of (c), which the plan must state rather than discover:

1. The MCP `doctor` tool's `outputSchema` (`doctor.ts:1487+`) declares the checks shape, and this repo
   **builds the schema twice** with a drift lane asserting they agree (`9983015`). Both copies need the
   field or the drift lane goes red.
2. `--fix` is unreachable from the MCP boundary by design (`doctor.ts:1504`), so `fixable: true` in an
   MCP payload advertises a repair that client cannot run. One sentence in the tool's description.
3. It also makes step 4's exclusion rule derivable without naming anything: exclude `fixable` rows
   (step 3 owns them) and rows whose `message` contains `infra-kit init` (init owns them — true at
   `doctor.ts:91,102,113,873,903`).
4. When a row is `fixable`, the skill must **offer `doctor --fix`** rather than echo the row's message,
   because `portless routes`' message names the manual command instead. State this as the reason.

---

## 1. Acceptance criteria audit

Ruling per criterion: **PASSES** = mechanically checkable and would actually fail if the behaviour
regressed. **FAILS** = unfalsifiable, vacuous, unsatisfiable, or asserting something that cannot
regress (or whose only resolution is deletion).

### Phase 1 — the `.mcp.json` writer (8 criteria)

| # | Criterion | Ruling |
|---|---|---|
| 1.1 | two-server fixture (`infra-kit` + `linear-server`) unchanged byte-for-byte | **PASSES** |
| 1.2 | `linear-server`-only fixture gains the key; sibling byte-identical and still first | **PASSES** |
| 1.3 | tab-indented fixture comes back tab-indented | **FAILS** |
| 1.4 | `wrong-key` fixture: byte-identical, one `warn` naming both keys | **PASSES** |
| 1.5 | unparseable fixture (trailing comma or `//`): byte-identical, one `warn` | **FAILS** |
| 1.6 | absent file: created, exactly one server, valid JSON, trailing newline | **PASSES** |
| 1.7 | round-trip: `inspectMcpRegistration` returns `{ kind: 'ok' }` | **FAILS** (known) |
| 1.8 | `pnpm run qa` green | **FAILS** |

**1.3 — vacuous as written.** The criterion does not say the tab fixture *lacks* the `infra-kit` key. If
it has the key the writer no-ops, the bytes are trivially unchanged, `detectIndent` is never entered, and
the criterion passes while the indent path is untested. Fix: *"a tab-indented fixture **without** the
`infra-kit` key gains it indented with tabs."*

**1.5 — inconsistent with the Architect's own S4, which is required.** S4 splits the writer's parse into
three outcomes (fails `JSON.parse` → refuse; parses but no usable `mcpServers` → create the container
additively; `mcpServers` present → the four verdict paths). The plan's single bullet covers only the
first. After S4 the fixture set has a hole exactly where the new behaviour lives. Fix: two criteria —
`//`-comment fixture → refuse, bytes identical, one `warn`; and `{"$schema":"…"}` → container created,
`$schema` byte-identical **and still first**, indent and trailing newline preserved.

**1.8 — unsatisfiable, not merely vague.** `vendor check` runs **first** in root `qa` and is **already
red on HEAD**, with no refresh command. So *"`pnpm run qa` green"* can never be met by this work, and a
criterion nobody can satisfy is one everybody skips. Fix: name the lanes — `tsc`, `eslint` with
`--no-cache`, `prettier --check` (a separate gate from eslint), `vitest` for the touched packages — plus
*"`git status` shows no `??` files"*, and state that `vendor check` red is pre-existing and must not be
"fixed" by editing `vendor/`. The plan already knows the `--cache` and `??` traps; they belong here, not
only in the flakes section.

**Missing from Phase 1 — one criterion the try/catch makes necessary.** `syncPluginPointer`'s existing
`try/catch` logs at **`debug`** (`init.ts:322-326`). So an EACCES or EISDIR on `.mcp.json` — read-only
checkout, `.mcp.json` accidentally a directory — is swallowed with no user-visible output, and `init`
still prints its success line and exits 0. Add: *"an unwritable `.mcp.json` produces one `warn` naming
the path; `init` still exits 0."* Without it, the plan's whole legibility argument (pre-mortem 3, S8)
has a hole directly under its own new code.

### Phase 2 — the gate line and the grant guard (3 criteria)

| # | Criterion | Ruling |
|---|---|---|
| 2.1 | `init` in a tmp non-repo emits exactly one line naming the three skipped steps, exits 0 | **FAILS** |
| 2.2 | `init` in a tmp fake infra-kit repo writes `.mcp.json` | **PASSES**, but unsafe as specified |
| 2.3 | the zero-options assertion fails if a flag is added | **FAILS** |

**2.1 — wrong on three counts, and contradicted by the modifications it must survive.** (i) *Three*
skipped steps: there are **four** (guidance, pointer, install, writer) — the plan's own pre-mortem 3 says
four. (ii) *"exactly one line"* contradicts S8, which amends the **two** existing strings at
`agent-files.ts:43,49` rather than adding a line. (iii) After the gate split the two gates have
different predicates, so a non-repo legitimately produces **two** skips with different reasons. As
phrased the criterion would fail the design it exists to accept. Fix: *"in a tmp non-git directory,
`init` logs a skip naming the guidance step and a skip naming the pointer, install and MCP steps, writes
neither `.claude/settings.json` nor `.mcp.json`, and exits 0."*

**2.2 — falsifiable, but the test as specified reaches the real `claude` binary.** Getting to the writer
means going through `syncPluginPointer` → `installPluginForProject` →
`spawnSync('claude', ['plugin','install','infra-kit@infra-kit','--scope','project'])`
(`install-plugin.ts:47,81`). In a tmpdir that runs the user's real `claude`, mutates a tmp
`.claude/settings.json`, and may reach the marketplace over the network — and the surrounding `try/catch`
hides whatever happens. The criterion must say the installer is stubbed, and must assert the write
landed **at the resolved absolute root**, not merely that a `.mcp.json` exists somewhere.

**2.3 — delete.** It is falsifiable, but it asserts a property that is not the safety property: the
Architect established that additivity, not flaglessness, is what makes the standing grant safe, and that
a legitimate `Bash(infra-kit init --force)` contains no `*` and passes U18 anyway. A test whose intended
resolution, the first time anyone adds a flag for a good reason, is *deletion* is a speed bump, not an
acceptance criterion. Replace with the criterion that matches the real invariant: *"for every writer
`init` drives, an existing value is never overwritten — asserted per writer, not asserted of the command
surface."*

**Missing from Phase 2 — the `$HOME` guard is entirely untested.** The Architect's §8.3 introduces
`toplevel !== os.homedir()` as the replacement for the protection the `infra-kit.json` gate was giving
incidentally. Nothing in Phase 2 asserts it, so the single line standing between `init` and a
dotfiles-repo `$HOME` would land unverified. Add: *"with the resolved toplevel equal to `os.homedir()`,
`init` writes no `.claude/settings.json` and no `.mcp.json`, and logs the skip."* This is the highest-value
missing test in the plan.

### Phase 3 — the skill (3 criteria)

| # | Criterion | Ruling |
|---|---|---|
| 3.1 | `pnpm run test:claude` green (U2, U3, U4, U5, U6, T1, T5 + the two new guards) | **PASSES** |
| 3.2 | `claude plugin validate ./plugins/infra-kit --strict --json` exits 0 | **PASSES** |
| 3.3 | `plugin details` re-measured against the README's 347 with a +20% ceiling (416) | **FAILS** |

**3.1** stands as a criterion; only its *explanation* is wrong (W1 — the guards apply by directory walk).
Add the S6 note that `test:claude` green ≠ CI green, because `test:claude` never runs
`scripts/check-workflow-resource-published.mjs`.

**3.2** stands. Record the `claude --version` used: the U13 probe step
(`plugin-ci.yml:56-57`, `continue-on-error: true`) exists precisely because `--strict` behaviour is
version-sensitive and non-gating in CI.

**3.3 — fails twice over, and the second reason is structural.**

- *Nothing implements it.* Verified independently of the Architect: no occurrence of `plugin details`,
  `347`, or `projected` in `plugins/infra-kit/__tests__/*.mjs`, `.github/workflows/plugin-ci.yml`, or
  `scripts/*.mjs`. So `README.md:81-82` — *"The release checklist **runs** `claude plugin details
  infra-kit`, parses the projected token cost, and **fails** when it exceeds the recorded value below by
  more than 20%"* — describes a gate that does not exist. The plan inherits that sentence as acceptance.
- *Even performed, it is unfalsifiable by construction.* The plan permits re-baselining the number it
  compares against **in the same commit** (*"the README line is deliberately re-baselined"*). A ceiling
  you may raise to whatever you measured cannot be exceeded. This is the purest vacuous criterion in the
  plan.

Fix, either: implement it as a reported-never-gating step on the U13 pattern (`continue-on-error`, since
`claude` may be absent in CI) that reads the number out of the README and prints the delta; **or** demote
it to a documented measurement, drop it from acceptance, and correct `README.md:81-82` to say a human does
it — the plan already edits that line, so the correction is free.

**Missing from Phase 3 — nothing verifies the skill does anything.** All three criteria are static
manifest checks. The plugin has a per-skill test lane (`plugins/infra-kit/skills/*/__tests__/*.test.mjs`,
run as *"Relocated skill tests (U11)"*; four skills use it), but the setup skill ships no `scripts/`, so
there is nothing there to unit-test — and the repo has **no eval suite of any kind** (verified: no
`evals` directory anywhere under `plugins/`). So Phase 3's acceptance currently means *"the file is
well-formed"*, not *"the flow works"*. I am not making an eval blocking — it is a new surface. But the
plan must (a) say plainly that no automated check verifies behaviour, and (b) name one manual
verification with a stated environment: run `/infra-kit:setup` in a **scratch git repo, not this one**,
and confirm four things — the payload parses, the consent question renders, `.mcp.json` appears at the
root that was announced, and the staleness note fires. Include the one-line stdout-purity check from §3
below.

### Phase 4 — root guidance block

**Not an acceptance criterion, and not a phase.** The plan makes the phase's existence conditional on a
question it never answers (*"Check whether the generated block enumerates skills at all … if it does not,
this phase is empty and should be deleted rather than performed"*). A phase whose existence is
conditional on unasked research is a TODO wearing a phase's clothes: it cannot be planned, scheduled, or
accepted, and under the no-fake-completion rule it is a blocker rather than a deliverable.

**Answered here, so it can be deleted.** The generated bodies live in
`apps/infra-kit/cli/src/lib/agent-guidance/bodies/` — `root-body.ts`, `package-body.ts`,
`design-skeleton.ts`. A case-insensitive grep for `skill` across that directory returns **nothing**, and
the live root block (this repo's own `CLAUDE.md`) enumerates the `ik` **commands** and the conventions
only. The generated block never enumerates skills. **Phase 4 is empty. Delete it, and record the answer
so nobody re-asks.**

---

## 2. Risk-mitigation clarity — the three pre-mortems

### Scenario 1 (whole-file serialize clobbers `linear-server`) — guard is **the right guard**

The byte-identity + key-order assertions over a two-server fixture would catch exactly the named failure,
and they are the assertions `plugin-pointer.test.ts` already makes for `.claude/settings.json`. Two
refinements:

- The scenario names a **second** guard — *"plus the round-trip test below, which pins writer↔reader
  agreement"* — and that one is the vacuous criterion (1.7). The scenario should not count it; after
  §7.1's three replacement assertions land it becomes real, and the scenario should cite those instead.
- The unit tests pin the **writer**; nothing in the scenario pins the **caller**. A writer that is
  perfect but is handed `<root>/.claude/.mcp.json` produces the same user-visible outcome. Criterion 2.2's
  absolute-path assertion closes this; say so in the scenario.

### Scenario 2 (the grant silently widens) — guard is **adjacent**, and the narration is mis-aimed

The Architect established that U18 catches 2 of 6 widening shapes. I add: the **scenario itself** picks
the least likely path. It narrates *"a later change gives `init` a flag → U6 goes red → the obvious repair
is `Bash(infra-kit init *)`"*. But the widening this plan actively invites is different and needs no
future feature: step 1 tells the skill to fall back to `node <repo>/apps/infra-kit/cli/dist/cli.js`, and
the moment anyone moves that line from prose into a fence, U6 clause 2 demands a rule, the natural rule is
`Bash(node <abs>/cli.js *)` — first token `node`, so U18 never looks at it — and the result is a standing
prompt-free grant for **every** infra-kit subcommand, including `local-deploy` and `release deliver`.
`doctor/SKILL.md:4` already ships a `node … *` rule as precedent, so this is the next edit someone makes.
Re-narrate scenario 2 around that path; it is the same fix (S2's rule-string allow-list) but it makes the
guard's necessity legible to the person who would otherwise delete it.

### Scenario 3 (wrong root, reports success) — **replace it; the scenario does not survive**

The Architect showed the evidence is wrong (`agent-files.ts:43,49` already log). I find the **symptom is
false too**, which the Architect did not check. The scenario's observable symptom is: *"`doctor` fails
`plugin installed` while `MCP server key` reports `missing-file: Not applicable`, so the two rows appear
to contradict each other."* That pair can never render. `resolveCheckedRepoRoot`
(`doctor.ts:919-927`) returns `null` unless `<toplevel>/infra-kit.json` exists, and `doctor.ts:1464`
**omits the MCP row entirely** on `null`, while `checkClaudePlugin(null)` still emits its rows
(`doctor.ts:1008-1009`, `resolvePluginInstall({})`). So in the wrong-root run the user sees the plugin
rows and **no MCP row at all** — no contradiction, no `Not applicable`.

With its evidence wrong and its symptom impossible, what remains is *"`init` exits 0 having skipped the
plugin work"* — which is true, and which S8's message amendment already fixes. That is a defect the plan
has adopted a fix for, not a pre-mortem. **Scenario 3 must be replaced.** Deliberate mode requires three
real scenarios; two-and-a-remainder does not qualify.

### Scenario 3′ — the replacement. The lead's candidate is right; here it is sharpened

**Judgement on the candidate: adopt it.** It is the correct third scenario, it is a direct consequence of
decisions 1–3 rather than a generic worry, and it is the only one of the three whose blast radius reaches
outside this repo.

**What breaks.** After the gate split, pointer, install and the `.mcp.json` writer gate on
`getProjectRoot()` plus `!== os.homedir()`. A user — or an agent running `/infra-kit:setup` — invokes it
with cwd inside some unrelated project. The `$HOME` guard passes, because it is not `$HOME`. `init` then
(i) creates or edits that repo's `.claude/settings.json` with `extraKnownMarketplaces["infra-kit"]` and
`enabledPlugins["infra-kit@infra-kit"]`, (ii) creates its `.mcp.json`, and (iii) spawns
`claude plugin install --scope project` **for that repo** (`install-plugin.ts:46-47`, project scope
always). Three tracked-file writes in a repo whose owner never adopted infra-kit.

**Observable symptom: none at the time.** `init` prints its success line and exits 0. The damage surfaces
later as an unexplained diff — or does not surface at all, because the next `git add -A` (an agent's
routine commit) carries infra-kit's marketplace pointer and MCP server into a stranger's repository.
`doctor` cannot even report it there: no `infra-kit.json` means `resolveCheckedRepoRoot` returns `null`
and the MCP row is omitted (`doctor.ts:919,1464`), so the file the writer just created is **invisible to
the reader** — see §3 below, which is the same asymmetry seen from the other side.

**Guards.**

1. The writer must emit a **`warn`** — not `debug`, not `info` — naming the absolute root and the files
   it is about to touch, in the one state where the two gates disagree: resolved git root present,
   `infra-kit.json` absent. Assert by message, in `logPointerResult`'s style. This is the only
   CLI-side signal available.
2. The skill states the resolved root **and that the two gates differ** before the consent question, and
   the consent question itself names the absolute path — not "this repo".
3. **State plainly that there is no mechanical prevention, and why.** `init` takes no flags by principle
   4, so it cannot offer `--allow-outside-infra-kit`; and it must not prompt, because non-TTY runs skip
   prompts silently (the recorded `dev`-wizard landmine). So decision 3 + principle 4 together mean the
   CLI can only *announce*. That is a genuine cost of principle 4 that the plan should record rather
   than meet by surprise — and it is the one place where I would accept the owner reopening principle 4
   if they would rather have a flag than an announcement.

---

## 3. Something both the plan and the Architect missed — the gate split breaks writer/reader symmetry

The plan's central quality claim is that writer and reader cannot drift, pinned by a round-trip test.
Decision 3 breaks that claim at a level no round-trip test can see, and neither document notices:

- **Writer reach after the split:** any git toplevel that is not `$HOME` (Architect §8.3).
- **Reader reach, unchanged:** `resolveCheckedRepoRoot` (`doctor.ts:919-927`) requires
  `<toplevel>/infra-kit.json`, and `doctor.ts:1464` omits the `MCP server key` row without it.

So in a git repo with no `infra-kit.json`, `init` writes `.mcp.json` and `doctor` **has no row for it**.
Three consequences:

1. The skill's steps 1 and 4 derive everything from the payload, so the skill can never confirm the write
   it just caused, and can never surface a `wrong-key` there.
2. The plan's standing-monitor claim — *"doctor's `MCP server key` row is the standing monitor for #30: it
   fails before the writer runs and passes after, with no new check to add"* — is false in exactly the
   repos decision 3 was introduced to serve.
3. The two halves are now gated on **different predicates**, which is the drift the round-trip test was
   supposed to prevent, one level up from where it looks.

**Recommendation, cheapest first.** Align the reader with the writer: make the MCP row's gate the same
git-root-plus-`$HOME` predicate the writer uses, so the row renders wherever the file can be written.
That is a real change to doctor's row-set conditionality and touches `doctor.ts:1455-1464` plus the tests
asserting the omission, so if the owner prefers to keep it out of this landing, then the plan **must**
state the asymmetry as a known limitation and the skill must say the MCP step is unverifiable in a repo
without `infra-kit.json`. What it must not do is keep claiming a standing monitor it does not have there.

---

## 4. Principle-option consistency

### The 30-row table: **exempt, conditionally — and the exemption does not generalise to the skill**

The Architect ruled it *"acceptable in the plan"*. I agree with the ruling and disagree with the reason:
being a doc is not what makes it exempt. Three properties do, and only two of them hold today.

1. **It is not auto-loaded.** Skill descriptions enter every turn's context; the plan is read only when a
   human opens it deliberately. Principle 2's harm is a stale copy that gets *consulted as authority*
   without anyone choosing to consult it.
2. **It is dated and superseded.** Its job is to answer the owner's opening question at planning time;
   once Phase 1 lands, `report.ts` is the only live answer.
3. **It is never presented to an agent as instructions.** A SKILL.md is exactly that, which is why the
   same table inside the skill would be a violation while the table in the plan is not.

The exemption is therefore *"not auto-loaded, dated, and non-instructional"* — and a SKILL.md fails all
three, which is precisely why nothing may migrate. To earn it, the plan must:

- stamp the table as a snapshot of `report.ts:60-88` with the commit sha and the count (30), so a later
  reader can tell at a glance whether it has drifted;
- state that the **"Fix owner" column is the plan's own judgement, recorded in no code** — the Architect
  found the table has already drifted twice (`PORTLESS_SERVING_NAME` rendered as a literal; a fix-owner
  column with no source), which proves the harm is live even in a doc;
- forbid migration into **both** `SKILL.md` and `README.md`.

### Is the Architect's violation list complete? No — two more

- **Principle 5, "prefer deleting scope", vs Phase 3 step 0.** The plan gives the skill a `--help` step
  (*"`--help` prints the block and stops. The only flag"*). The sibling skill has no such section —
  `doctor/SKILL.md`'s step 0 is the `CLAUDE_CONFIG_DIR` caveat. It is imported OMC ceremony: it adds body
  lines against the very token budget the plan calls a ceiling, nothing tests it, and no user asked a
  skill for a flag. **Cut it.**
- **Principle 2, third copy of the grant.** After S2 the `allowed-tools` line exists in the SKILL.md, in
  the test's literal rule allow-list, and in the plan. That is fine and intended, but the plan must say
  **which copy is normative** — the test — so the next editor changes the SKILL.md and expects a red test
  rather than the reverse.

---

## 5. Ruling on U19

**Ship U19 as the existing 11-name deny list. Do not widen it to 30. `--json` plus §0(c) dissolves the
tension — but only with §0(c); S1 alone leaves step 3 broken.**

Reasoning:

- Post-S1-plus-§0(c), the skill names **zero** rows and zero commands. A deny-list's coverage only
  matters against text you intend to write, so U19's partiality stops being load-bearing.
- Widening to 30 costs either a second copy of `SECTION_MEMBERS` inside a `.mjs` test — the exact
  violation U16 was written to prevent — or a regex over `report.ts`'s string literals from a plugin test
  reaching into `apps/`, which adds a spurious-red mode on any `report.ts` refactor and buys nothing once
  step 4 names nothing. (`DOCTOR_CHECK_NAMES` is exported from `report.ts:109`, but it is TypeScript; the
  plugin tests are `.mjs` and cannot import it.)
- U19 has a real job even at 11 names: **both** `portless routes` and `tokens.json perms` are in the set,
  so it hard-blocks the naming implementation of step 3 that §0 rejects. It is a live guard, not
  decoration.
- Add one line to the test's header comment: the guarantee comes from step 4 being **derived**, not from
  the list's coverage — so a future reader does not mistake 11-of-30 for the guard's strength.

**Step 4's replacement text, concretely** (this is what the SKILL.md should say):

> ## Step 4 — the remainder is doctor's, verbatim
> From the step-1 payload, take every `checks[]` entry with `status: "fail"`, in payload order. Drop the
> ones already handled: entries whose `message` names `infra-kit init` (step 2 ran it) and entries with
> `fixable: true` (step 3 offered the repair). Print each remaining entry as its `name` followed by its
> `message`, unedited. Do not group them, do not rename them, do not add a command of your own — the
> message already carries the exact command or URL. Listed, never run.
>
> Two things to say out loud rather than hide: the row set is not fixed (the `.mcp.json` row is omitted in
> a repo without `infra-kit.json`), and a step you have deliberately declined is indistinguishable from
> one that is missing — `status` is only `pass` or `fail` — so a declined row is re-offered every run.

Step 3's text becomes: *"offer `infra-kit doctor --fix` when any `status: "fail"` entry has
`fixable: true`. Say that it refuses while a dev session is running. Prefer the flag over that row's own
message: `portless routes` describes the manual removal command, not the repair."*

---

## 6. Scope discipline — it has crossed over, and the fix is sequencing, not cutting

After the Architect's modifications the plan carries: the writer, a payload field with two schema copies
and a drift lane, a three-part replacement for U18, a gate split with a new `$HOME` guard and a
`resolveRepoRoot` restructure into two functions, two doctor string rewrites plus the test asserting the
old ones, two amended `agent-files.ts` messages, the skill, two new manifest guards, a red-fixture file,
`EXPECTED_SKILLS`, a version bump, a README row and a README correction, plus four factual corrections.
That is not *"mirror a reference"*. It is a subsystem — and worse, it is a subsystem that **cannot land
as one commit correctly**, for a reason neither document states:

**The skill ships instantly; the CLI does not.** The plugin reaches machines through the marketplace on a
version bump. The writer, the payload field and the gate split reach machines only through a **publish** —
and local `infra-kit` == published `infra-kit` == 0.4.0. So a single commit produces a window in which
`/infra-kit:setup` is live and promises a `.mcp.json` write that the installed CLI cannot perform. The
user's experience is: setup reports success, doctor's `MCP server key` row stays red. And the mechanism
this repo built for exactly this hazard — the published-CLI version floor enforced by
`scripts/check-workflow-resource-published.mjs` — **binds `commands/` only**. Skills are exempt from it,
which the plan celebrates (decision-driver 2) without noticing that the exemption removes the guard
against its own release ordering.

**Minimum viable first landing — commit 1 (CLI only), then publish, then commit 2 (plugin).**

*Commit 1:* the merge-safe writer with S4's three writer-side outcomes; the §7.1 assertions; the gate
split as `resolveGitRoot()` / `resolveInfraKitRoot()` with the `$HOME` guard **and its test** (criterion
2.4); the two amended `agent-files.ts` messages; the `fixable` payload field in both schema copies; the
two doctor `missing-file` strings plus the test that asserts them; the unwritable-file `warn`. Publish.

*Commit 2:* the SKILL.md, S2's three-part guard, the red fixture, `EXPECTED_SKILLS`, the version bump, the
README row and the README:81-82 correction. The skill states a CLI floor in prose and step 1 checks it
against the payload's `CLI version` row (`doctor.ts:1022`, message `` `infra-kit CLI ${version}` ``) —
the cheapest available substitute for the version floor skills do not get.

This split is not overhead: S2 belongs entirely to commit 2, so it does not bloat commit 1, and commit 1
is independently useful (the writer closes the actual gap whether or not the skill ever ships).

**CUT outright:** Phase 4 (empty — §1 answers it); the zero-options test (2.3); step 0's `--help`
ceremony; the token-budget criterion as *acceptance* (3.3); U19 widening.

**DEFER to a follow-up:** the top-level `infra-kit mcp-register` and `--rename` (the Architect already
marks it optional); narrowing the reader's `unparseable` into a fifth verdict (already deferred);
`doctor --fix` growing to cover `.mcp.json`; aligning the MCP row's gate with the writer's (§3) **if** the
owner will not take it in commit 1 — in which case the limitation must be written down.

---

## 7. Also missed by both documents

**M1 — `/infra-kit:setup` is least available exactly where it is most needed.** The plugin is installed at
**project scope, always** (`install-plugin.ts:22-24,46-47`), and enabling it writes `enabledPlugins` into
*that repo's* `.claude/settings.json`. So in a fresh repo the plugin is not enabled, the skill is not
discoverable, and `/infra-kit:setup` cannot be invoked — yet installing the plugin is one of the two
things it exists to do. Its real audience is a session where the plugin is *already* installed. This does
not sink the plan (the skill still owns consent, `.mcp.json`, and the human remainder), but the plan must
name its own precondition instead of implying first-run coverage: state that plugin bootstrap is
`claude plugin marketplace add …` + `claude plugin install …` by hand, or `infra-kit init` from a shell —
which `init.ts:261` already prints — and that the skill is the *second* run, not the first.

**M2 — and the CLI has the same bootstrap hole.** Step 1 resolves `infra-kit` on `PATH`, else
`node <repo>/…/dist/cli.js`. If neither exists the skill cannot start, and it cannot self-repair: the
global install is `pnpm add -g infra-kit@latest`, `npm` is blocked by a bash-guard hook, and the plan
explicitly excludes global install from scope. So state the precondition in one line and stop there. A
setup skill honestly bounded at *"infra-kit is installed; everything after that is mine"* is fine; one
that implies otherwise fails on its first real user.

**M3 — step 2's consent is unanswerable in print mode.** `claude -p` has no interactive
`AskUserQuestion`. The plan must give the skill an explicit rule, not leave it to the model: *if
`AskUserQuestion` is unavailable, do not run `init` — print the command and continue to step 4.* Without
it, the failure mode is a model that "decides" consent on the user's behalf, which is the worst possible
outcome for the one standing mutating grant in the plugin. Note this repo's own guidance already uses the
*"when AskUserQuestion is available"* conditional phrasing; mirror it.

**M4 — nobody has ever run `init` from inside a live Claude session.** `installPluginForProject` shells
out to `claude` (`install-plugin.ts:34,81`), so consenting in step 2 makes a Claude Code session spawn
`claude plugin install --scope project` as a child that writes the `.claude/settings.json` the parent
already loaded, while the new writer edits the `.mcp.json` that decides which MCP servers — possibly
including the `infra-kit` server this session is connected to — the parent has loaded. The doctor skill
never exercised this, because doctor never runs `init`. Add it to the manual verification (§1, Phase 3):
run it once in a scratch repo and record what the nested install does, before this ships to anyone else.
The Architect's S9 (extend step 5 to MCP-server staleness) is the right *message*; this is the missing
*experiment*.

**M5 — one-line stdout-purity check for the payload.** Step 1 parses JSON from stdout. Any stray stdout
write corrupts it, and this CLI has a silent self-update path that runs opportunistically. Verify once:
`infra-kit doctor --json | <json parser>` parses cleanly, including on a run that triggers the
self-update. Cheap, and it is the single point of failure for steps 1, 3 and 4.

---

## VERDICT: ITERATE

The shape is right, all three owner decisions are implementable, and the Architect's seven required
modifications are correct as far as they go. But the plan as it would stand *after* those modifications
still has a broken step 3 (§0), a pre-mortem with only two surviving scenarios (§2), a writer/reader
asymmetry introduced by decision 3 (§3), four vacuous or unsatisfiable acceptance criteria, two missing
tests for the guards the modifications introduce, and a release ordering that produces a live skill
promising a write the published CLI cannot perform. In deliberate mode a pre-mortem that is two-thirds
real and a test plan with four vacuous criteria is a reject-and-iterate, not an approve.

No rethink. Nothing here changes Option A, the writer's design, or the gate split.

### Changes required for approval

1. **BLOCKING** — Add `fixable: FIXABLE_NAMES.has(name)` to `structuredContent.checks[]`
   (`doctor.ts:1473-1475`) and to **both** copies of the MCP `outputSchema` (the drift lane from `9983015`
   will red otherwise). Rewrite step 3 to filter on it. Without this, S1's step 3 is not implementable:
   `--json` carries no remediation hint (`report.ts:356` is presentation), fixability is deliberately
   not message-derivable (`report.ts:114-117`), and `portless routes`' fail message names a **manual**
   command (`doctor.ts:1249`), so a verbatim echo misdirects the user on a fixable row. (§0)
2. **BLOCKING** — Replace pre-mortem 3. Its evidence is wrong (Architect §1f) **and** its symptom is
   impossible: `resolveCheckedRepoRoot` returns `null` without `infra-kit.json` (`doctor.ts:919-927`) and
   `doctor.ts:1464` omits the MCP row on `null`, so the "two contradictory rows" never render. Adopt
   scenario 3′ as narrated in §2 — `init` writing three tracked files into an unrelated git repo — with
   its three guards, including the explicit statement that principle 4 leaves no mechanical prevention.
3. **BLOCKING** — Fix the four broken acceptance criteria: 1.3 (say the tab fixture **lacks** the key, or
   `detectIndent` is never entered); 1.5 (split into `//`-comments → refuse and valid-JSON-no-`mcpServers`
   → container created, per the required S4); 1.8 (`pnpm run qa` green is **unsatisfiable** — `vendor
   check` is already red on HEAD; name the lanes, `eslint --no-cache`, `prettier --check`, and `??` files
   instead); 3.3 (the token re-measure is implemented by nothing — verified — and is unfalsifiable
   because the plan permits re-baselining the compared number in the same commit; demote it out of
   acceptance and correct `README.md:81-82`, which claims a gate that does not exist).
4. **BLOCKING** — Rewrite criterion 2.1: **four** gated steps, not three; S8 amends **two existing**
   messages rather than adding "exactly one line"; and after the split a non-repo legitimately emits two
   skips with different predicates.
5. **BLOCKING** — Add the missing test for the `$HOME` guard (`toplevel !== os.homedir()`): with the
   resolved toplevel equal to `os.homedir()`, `init` writes no `.claude/settings.json` and no `.mcp.json`
   and logs the skip. The single line protecting a dotfiles `$HOME` would otherwise land unverified.
6. **BLOCKING** — Sequence the landing: CLI commit → **publish** → plugin commit. The plugin reaches
   machines on a version bump; the writer only on a publish (local == published == 0.4.0), and the
   published-CLI floor (`check-workflow-resource-published.mjs`) binds `commands/` only, so a skill has no
   version gate. One commit creates a window where setup reports success and `MCP server key` stays red.
   The skill must also state a CLI floor and check it against the payload's `CLI version` row
   (`doctor.ts:1022`). (§6)
7. **BLOCKING** — Delete Phase 4. Answered: `agent-guidance/bodies/` contains no reference to skills and
   the live root block enumerates commands only, so the generated block never lists skills. A phase whose
   existence is conditional on unasked research is not a phase. (§1)
8. **BLOCKING** — Resolve the writer/reader gate asymmetry decision 3 creates: either align the MCP row's
   gate with the writer's predicate, or write the limitation down and drop the claim that doctor's
   `MCP server key` row is a standing monitor for `#30`. It is not one in a repo without `infra-kit.json`
   — exactly the repos the split serves. (§3)
9. **BLOCKING** — Give step 2 an explicit non-interactive rule: if `AskUserQuestion` is unavailable
   (`claude -p`), do not run `init`; print the command and continue. Consent for the plugin's only
   standing mutating grant must never be inferred by the model. (§7 M3)
10. **BLOCKING** — Add the criterion the `debug`-swallowing `try/catch` (`init.ts:322-326`) requires: an
    unwritable or non-file `.mcp.json` produces one `warn` naming the path, and `init` still exits 0.
11. **NON-BLOCKING** — Delete the zero-options test (2.3) and replace it with an additivity criterion:
    every `init` writer leaves an existing value untouched, asserted per writer.
12. **NON-BLOCKING** — Re-narrate pre-mortem 2 around the widening the plan actually invites: fencing
    step 1's `node <repo>/…/dist/cli.js` fallback, whose natural rule is `Bash(node …/cli.js *)`, first
    token `node`, invisible to U18, granting every subcommand. (§2)
13. **NON-BLOCKING** — Rule U19 shipped as the existing 11-name deny list; do not widen to 30. Add the
    header note that the guarantee comes from step 4 being derived, not from coverage. Adopt the step 3 /
    step 4 replacement text in §5 verbatim. (§5)
14. **NON-BLOCKING** — Mark the 30-row table a dated snapshot of `report.ts:60-88` with the commit sha and
    the count; state that the "Fix owner" column is the plan's judgement, recorded in no code; forbid
    migration into **both** `SKILL.md` and `README.md`. The exemption is "not auto-loaded, dated,
    non-instructional" — three properties a SKILL.md lacks. (§4)
15. **NON-BLOCKING** — Cut step 0's `--help` ceremony. No sibling skill has one, nothing tests it, and it
    spends body lines against the token budget the plan calls a ceiling. (§4)
16. **NON-BLOCKING** — Criterion 2.2 must stub `installPluginForProject`; otherwise the test shells out to
    the user's real `claude` (`install-plugin.ts:81`) inside a tmpdir. Also assert the write landed at the
    resolved **absolute** root.
17. **NON-BLOCKING** — Add the manual verification Phase 3 lacks, in a **scratch** git repo: the payload
    parses, the consent question renders, `.mcp.json` appears at the announced root, the staleness note
    fires — plus the never-yet-run experiment of `init` spawning `claude plugin install` from **inside** a
    live session (§7 M4), and the `doctor --json` stdout-purity check (§7 M5). State plainly that no
    automated check verifies the skill's behaviour: the repo has no eval suite, and the setup skill ships
    no `scripts/` for the U11 lane.
18. **NON-BLOCKING** — State the skill's preconditions instead of implying first-run coverage: the plugin
    installs at **project scope**, so `/infra-kit:setup` is not discoverable in the fresh repo it would
    most help, and the CLI cannot bootstrap itself (`pnpm add -g infra-kit@latest`; `npm` is hook-blocked).
    (§7 M1, M2)
19. **NON-BLOCKING** — Name the test's literal rule allow-list (S2) as the **normative** copy of the
    grant, so the next editor knows which of the three copies wins. (§4)

---

# Round 2 — review of revision 2 (2026-09-10)

Scope: revision 2 of the plan (1089 lines) and the Architect's round-2 section (`architect-review.md:956-1138`).
Round-1 findings stand except where corrected below. Read-only on source and on the plan.

## R2.0 — My round-1 item 1 was wrong on the mechanism. Accepted, not re-argued.

I required `fixable` in **both** copies of doctor's `outputSchema` and predicted the `9983015` drift
lane would red. The Planner disputed it and the Architect verified all four sub-claims (R2.2): doctor
declares exactly one `outputSchema` (`doctor.ts:1490-1502`); `9983015` is `buildRequestedSchema` for the
confirm-gate form, a different subsystem; `command-catalog.test.ts` iterates `getExposedMcpTools()`, from
which doctor is excluded by `mcpExposed: false`; and the e2e whole-object comparison sees only served
tools. The correction is right and the plan's §`fixable` records it accurately. No further comment.

The substance of item 1 — that `--json` alone breaks step 3 and the payload needs a derived fixability
signal — was correct and is adopted. R2.4's row-by-row verification of step 4 is accepted without
re-checking.

## R2.1 — The blank-`git rev-parse` gap: this is bigger than a test casualty, and I measured where the fix belongs

The Architect's finding is correct on mechanism. I verified it independently: `getProjectRoot` is
`return result.stdout.trim()` (`git-utils.ts:143-157`) and throws only when `$` itself fails, so blank
stdout yields `''`; `report-inventory.test.ts:130-136` mocks `zx` as
`$ → Promise.resolve({ stdout: '' })` for **every** invocation and does not mock `git-utils`. So `''` is
what production code receives under that suite, not a hypothesis.

Three sub-questions, ruled.

**(a) Is a blank-output check in `resolveGitRoot()` sufficient? Necessary, not sufficient — and it is
load-bearing for pre-mortem 3, which is the part neither document says.**

`''` is not merely an invalid root; it is a **cwd-relative** one. Every `path.join('', x)` silently
becomes a path resolved against `process.cwd()`, which is the exact shape of the recorded
`dev-context $HOME fallback` landmine, and `'' !== os.homedir()` means the `$HOME` guard passes. Now
carry that into pre-mortem 3: guard 1 is the `warn` that fires *"in the one state where the two gates
disagree: git root resolved, `infra-kit.json` absent"*, and guard 3 concedes the announcement is the
**only** protection there is. With a blank root accepted as resolved, that branch is entered with root
`''`, so the sole guard **announces the wrong path** while writing cwd-relative files. The blank check is
therefore not test hygiene: it is what makes pre-mortem 3's only guard truthful. The plan must state it
in §Gate split as a contract, not leave it to the implementer.

It is not sufficient because with the check in place `report-inventory.test.ts:148` goes red (29 names vs
30). The check moves the failure; it does not remove it — hence (b).

**Where the check goes — measured, and the answer is the narrow one.** The tempting fix is to reject
blank inside `getProjectRoot` itself, since a blank root is never a valid answer for *any* of its callers
(guidance via `getInfraKitConfigPaths`, layer-3 keying, worktree resolution). I surveyed the blast
radius before recommending it: **34 suites under `apps/infra-kit/cli/src` mock `zx`, and 23 of them
contain a `stdout: ''` response** — including all four `git-utils` suites and two shared mock helpers
(`git-utils/__tests__/zx-command-mock.ts`, `lib/vendor/__tests__/zx-mock.ts`). Turning blank into a throw
in a shared primitive with that surface is a separate landing, not a line in commit 1.

**Ruling: put the blank check in the new `resolveGitRoot()` only** — blank stdout is a failed resolve,
logged as a skip exactly like a throw — and record the shared-primitive hazard as a deferred follow-up
**with the measured number**, so nobody "tidies" it into `getProjectRoot` mid-commit-1. The follow-up has
an obvious home: `git-utils/__tests__/git-utils-fail-honestly.test.ts` already exists, which is evidence
the repo treats this defect class as in scope for git-utils — just not in this commit.

**(b) Does `report-inventory.test.ts` need a `git-utils` mock? Yes, and the test's own doc comment is
what obliges it.** It claims *"Every external seam is mocked so the set is deterministic rather than
machine-dependent."* After the alignment the git seam becomes load-bearing for the row set, and it is
mocked only **accidentally** — via `zx` returning blank — which is precisely the condition that comment
denies. Mock `src/lib/git-utils` to return `ensureFixture()`, matching the deliberate total mock of
`src/lib/infra-kit-config` already at `:73`. Do **not** make the `zx` mock command-aware: that means
string-matching template literals and it perturbs every other `$` consumer inside `doctor()`.

**(c) Is "passes by accident against the live repo" acceptable? No — and it is worse than the four
vacuous criteria I rejected in round 1.** Those were vacuous: they asserted something that could not
fail. This one is **machine-dependent**: the row's verdict would be read from `process.cwd()`'s real
`.mcp.json`, so the suite's answer depends on where vitest was launched and on the working tree's own
uncommitted state. A drift guard whose determinism depends on the developer's cwd is not a guard — it is
the "dist-reading tests are vacuous" defect class with a different seam. Reject it explicitly in the plan
so the implementer does not discover the green and stop.

**(d) Blocking for commit 1? Yes, twice over.** The gate alignment ships in commit 1, and both defects
live in code that commit adds. More sharply: **criterion 2.4 cannot be trusted until the blank case is
pinned.** To test "resolved toplevel equals `os.homedir()`" the test must control what `git rev-parse`
returns; if it does so with the prevailing blank-stdout `zx` idiom, a slip yields `''`, the guard is
bypassed, and 2.4 still passes. My round-1 highest-value test is itself exposed to this gap. So commit 1
needs **one more criterion**, pinning the blank case directly rather than through `$HOME`:

> **2.8** — with the git seam answering blank stdout, `resolveGitRoot()` resolves to a **skip**: `init`
> writes no `.claude/settings.json` and no `.mcp.json`, logs the skip, exits 0 — and doctor omits the
> `MCP server key` row rather than rendering it against a cwd-relative path.

And `commands/doctor/__tests__/report-inventory.test.ts` must appear in Phase 2's file inventory
(`:713-717`), where it is currently absent — verified: the plan contains no occurrence of
`report-inventory`, `blank`, or `stdout.trim`.

## R2.2 — `cliVersion`: adopt it, in commit 1

**Ruling: adopt the top-level `cliVersion: packageJson.version` field.** Four reasons, in order:

1. The prefix's stated justification is now known false. The plan says *"A top-level field would break it
   — which is why the CLI-floor check below reads a message prefix instead"* (`:436-437`). The Architect
   verified doctor is excluded from `getExposedMcpTools()`, so a top-level addition is as safe as the
   nested one. **That sentence must be deleted, not softened** — it is the load-bearing premise for a
   choice the plan would otherwise have no reason to make.
2. The floor check is the **only** substitute for the published-CLI version floor that skills do not get
   (§Landing sequence). That makes it precisely the wrong place to depend on an unguarded string in a
   message body — the U16/U19 silent-staleness family, relocated from a row name to prose.
3. A version in a structured payload is a **comparison**; a prefix is a parse. Parsing semver out of
   `` `infra-kit CLI 0.4.0` `` invites a slip at exactly the moment the answer matters, and the failure
   direction is "assume the floor is met".
4. One line, in a file and a commit already being edited, with a blast radius verified four ways as nil.

**Commit 1, not deferred** — and the reason is structural rather than convenience: `cliVersion` is
consumed by commit 2's skill. Landing it later would need its own publish, and the skill would then carry
a floor check whose own datum requires a floor check. Deferring therefore means either shipping the
prefix in commit 2 (the thing just rejected) or dropping the floor check.

**On "a third additive change to a payload in a plan the Critic already called a subsystem."** Accept it.
My round-1 scope objection was answered by **sequencing**, not by a byte budget: three fields in one file,
one commit, one publish is not scope creep — three commits with three publishes would be. But the plan
must now state the consequence once: **the `--json` payload has become a compatibility surface an
external artefact depends on.** Put that beside the observability line the Architect asked for in R2.4
(remediation text must stay in the check layer, because `--json` skips presentation) — they are the same
hazard seen twice: a producer-side refactor that silently breaks a payload-derived skill. Neither line is
in the plan today.

If the owner declines the field, the Architect's two conditions are the floor and I add nothing to them;
dropping the floor check is the acceptable third answer, and shipping the prefix with neither guard is
not.

## R2.3 — Gate-alignment rationale: plan-text only, and my item 8 stays closed

Confirmed on both counts. The alignment itself is right and does **not** reopen round-1 item 8: item 8
demanded alignment *or* a written limitation, and the plan chose alignment (`:379-394`), which closes it.
The entire residue is R2.1's untracked test casualty.

The re-ordering the Architect asks for is editorial and correct: lead with the correctness argument (a
writer with no monitor in exactly the repos decision 3 exists to serve), and demote *"`resolveGitRoot()`
is being built in that commit anyway"* and *"the comment is being rewritten there anyway"* to a closing
marginal-cost line. Leading with cohesion is what makes a correct change read as scope creep.

Two factual corrections in that section, both of which R2.1 also touches:

- `:397` — *"tests asserting the omission update in the same commit"*. No such test exists; the
  Architect searched and I confirm Phase 2's own file list names only `init-plugin-pointer.test.ts` and
  `claude-plugin-checks.test.ts`, neither of which asserts absence. Replace with: no test asserts the
  omission today; `report-inventory.test.ts` asserts the row **set** and is the file that must change.
- `:383` — *"the marginal cost is one call site"* is false. It is one call site **plus** a blank-output
  contract **plus** a mock in a suite the plan does not list **plus** criterion 2.8.

## R2.4 — Spot-check: the other nine round-1 items are resolved substantively, not nominally

Checked each against the revision, not against the summary of it.

- **1.3** now reads *"a tab-indented fixture **that lacks the `infra-kit` key**"* and records why the
  earlier form was vacuous (`:692`). Real.
- **1.5** split into 1.5a (`//` comments → refuse) and 1.5b (valid JSON, no `mcpServers` → container
  created, `$schema` byte-identical and **still first**) (`:694-695`). Matches S4 exactly. Real.
- **1.9** names the lanes (`tsc`, `eslint --no-cache`, `prettier --check`, `vitest`, `??` files) and
  states that `vendor check` redness is pre-existing and must not be "fixed" by editing `vendor/`
  (`:699-705`). Real, and it carries the reason forward.
- **2.1** rebuilt: two skips, four steps, no "exactly one line", with the three-way error recorded
  (`:721,729-732`). Real.
- **2.2** stubs `installPluginForProject` and asserts the **resolved absolute root** (`:722`), with the
  spawn hazard spelled out in the integration section (`:881-886`). Real.
- **2.3** is new and pins pre-mortem 3's guard 1 by message (`:723`). Real — but see R2.1(a): its
  truthfulness depends on the blank check.
- **2.4** exists and is called the highest-value new test (`:724,734-735`). Real — but see R2.1(d): it
  cannot be trusted until 2.8 exists.
- **2.6** is real in its first clause (payload carries `fixable`, `true` exactly for `FIXABLE_NAMES`) and
  **tautological in its second**: since doctor is excluded from `getExposedMcpTools()` and from the
  served tool list, *"`command-catalog.test.ts` and the MCP e2e suite stay green"* cannot fail for this
  change. Keep it as a cheap regression net, but mark it reassurance rather than coverage so nobody reads
  it as evidence the field is guarded.
- **2.7** additivity per writer (`:727,737-738`), replacing the deleted zero-options test. Real, and it
  asserts the property that actually makes the standing grant safe.
- **Phase 4** deleted with the research answered inline (`:773-780`). Real.
- **Landing sequence** is a first-class section stating the constraint and the reason skills have no
  version floor (`:634-676`). Real.
- **Step 2's non-interactive rule** is present verbatim with the "never inferred by the model" reason
  (`:819-822`). Real.
- **1.8** unwritable/non-file `.mcp.json` → one `warn`, citing the `debug` swallow at `init.ts:322-326`
  (`:698`). Real.
- **Manual verification** carries the nested-`claude` experiment and the stdout-purity check
  (`:898-919`), with the honest framing that static criteria mean "the file is well-formed". Real.
- **Preconditions** carries both bootstrap limitations and the declined-vs-missing capability loss
  (`:962-985`). Real.

One residue: step 4 says *"the row set is not fixed (**two** rows are conditionally omitted)"* (`:835`).
A hard count in prose is the same failure class as revision 1's "three skipped steps", and after the
alignment the count is a function of two different predicates. Say "some rows are conditionally omitted"
and name the predicates, or derive it.

## R2.5 — Pre-mortem strength, which is the deliberate-mode question now

Scenario validity is settled: 1 and 2 have real guards asserted by real criteria (1.1-1.4, 1.7; the
`deepEqual` rule-string allow-list with red fixtures), and 3 is a genuine consequence of decisions 1-3
with a symptom, a stated absence of mechanical prevention, and a criterion (2.3) pinning its one guard.
Guard **strength** is the open question, and it resolves to a single dependency: pre-mortem 3's guard 1
is only as truthful as `resolveGitRoot()`'s blank-output contract (R2.1(a)). With the contract and
criterion 2.8, the pre-mortem is strong. Without them, the plan's only protection against writing into a
stranger's repository can announce the wrong path — which is why that item is blocking rather than
editorial.

## VERDICT: APPROVE

Revision 2 answers all ten of my round-1 blocking items substantively, and the two genuinely new design
decisions (the `fixable` field, the MCP row's gate alignment) are both correct. My item 1's mechanism was
wrong and its substance was adopted. The pre-mortem now has three real scenarios and the test plan is
falsifiable throughout. **No further review round is needed**: every item below has a stated resolution
with no remaining design choice, and the two reviewers concur on all of them.

APPROVE is conditional in one respect only — items 1-3 are defects in **commit-1 code**, not
documentation, so they must be written into the plan text before commit 1 is authored.

1. **BLOCKING — blocking-for-commit-1.** Specify in §Gate split that `resolveGitRoot()` treats **blank**
   `git rev-parse --show-toplevel` output as a failed resolve, logged as a skip. `getProjectRoot`
   (`git-utils.ts:143-157`) returns `''` and throws only on spawn failure; `''` is cwd-relative through
   every `path.join` and `'' !== os.homedir()` bypasses the `$HOME` guard, so without this pre-mortem 3's
   **only** guard announces the wrong path. Put the check in the new wrapper only — **not** in
   `getProjectRoot` — and record the deferred follow-up with the measured blast radius: 34 suites mock
   `zx`, 23 of them return `stdout: ''`, including all four `git-utils` suites and two shared mock
   helpers. Add criterion **2.8** (blank seam → skip, no writes, MCP row omitted). (R2.1 a, d)
2. **BLOCKING — blocking-for-commit-1.** Add a deliberate `src/lib/git-utils` mock to
   `report-inventory.test.ts` returning `ensureFixture()`, list that file in Phase 2's inventory
   (`:713-717`, currently absent), and state in the plan that "green because it read the live repo's
   `.mcp.json` through a relative path" is **not** an acceptable outcome — it is machine-dependent, which
   is worse than vacuous. Do not make the `zx` mock command-aware. (R2.1 b, c)
3. **BLOCKING — blocking-for-commit-1.** Adopt top-level `cliVersion: packageJson.version` in
   `structuredContent` and the one `outputSchema`, in the same commit as `fixable`; delete the false
   premise at `:436-437` (*"A top-level field would break it"*); and change the skill's floor check from a
   message-prefix parse to a comparison. If the owner declines, apply the Architect's two conditions
   (producer-side pin in `claude-plugin-checks.test.ts`, plus a SKILL.md fail-safe that **skips** the
   check on no match) — or drop the floor check. (R2.2)
4. **NON-BLOCKING — commit-1.** Re-order §Gate split's justification to lead with correctness and demote
   "being built anyway" / "comment rewritten anyway"; correct `:397` (no test asserts the omission today)
   and `:383` ("one call site" understates it). (R2.3)
5. **NON-BLOCKING — commit-1.** Add two lines to §Observability: the `--json` payload is now a
   compatibility surface an external artefact depends on; and step 4's derivability rests on remediation
   text staying in the **check** layer, because `--json` skips presentation — a refactor moving command
   construction into `report.ts` would break the skill silently. (R2.2, Architect R2.4)
6. **NON-BLOCKING — commit-1.** Mark criterion 2.6's second clause (`command-catalog.test.ts` and the MCP
   e2e suite stay green) as reassurance rather than coverage: doctor is excluded from both surfaces, so it
   cannot fail for this change. (R2.4)
7. **NON-BLOCKING — commit-2.** Drop the hard count at `:835` ("two rows are conditionally omitted") —
   name the predicates or derive it; a count in prose is the failure class criterion 2.1 was rebuilt to
   remove. (R2.4)
