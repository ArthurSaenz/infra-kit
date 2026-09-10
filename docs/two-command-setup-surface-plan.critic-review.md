# Critic review — two-command setup surface plan (revision 5)

Reviewer: critic pass of a ralplan `--deliberate` consensus loop, final gate. Read-only with respect to
`docs/two-command-setup-surface-plan.md`, `docs/two-command-setup-surface-plan.architect-review.md`, and
all source. This file is the only artefact written.

The owner has approved execution: on `APPROVE` an autonomous ralph loop implements this against a real
repo. The bar applied here is therefore not "is the design right" — it is "will an agent following this
literally build the right thing **and know when it has**". Line numbers are from the working tree at HEAD
`969bbe0` (dirty).

The design is sound. Four architect rounds have done real work and the shape that survives — a gated
installing `setup`, an ungated read-only `doctor`, a preserved non-aliased `init`, a plugin **command**
rather than a skill — is, as far as I can find, the only shape that satisfies the owner's constraint set.
I found no architectural objection either.

What I did find is that **the plan's flagship test still does not bite**, for the fourth revision running,
plus five smaller items each of which is a criterion an implementer can mark done while the defect stands.

---

## 0. The headline: U-D2(b) is still vacuous — the seam was fixed, the *shape* was not

Revision 5's claim is that the seam is now `vi.spyOn(fs, 'chmodSync')`, sound because `doctor.ts:1` is a
default import. **That half is correct and I verified every link of it:**

- `apps/infra-kit/cli/src/commands/doctor/doctor.ts:1` — `import fs from 'node:fs'`. Default import. ✓
- `doctor.ts:571` — `const chmodPath = deps.chmodPath ?? fs.chmodSync`. The dereference happens **inside
  the function body, at call time**, so a spy installed on the `fs` default-export object is seen. ✓
- `doctor.ts:619` — `chmodPath(entry.target, entry.expected)` is the `--fix` write. ✓
- `doctor.ts:1451` — `checkTokenStorePerms(options.fix ?? false)`, no `deps`. ✓
- `types.ts:138-142` — `defineMcpTool` returns its argument unchanged, so `doctorMcpTool.handler` is the
  authored closure and `handler.length` is a real assertion. ✓

So revision 5 correctly identified **which object** to watch. It did not fix **the shape of the
assertion**, and the shape is what has made this test vacuous three times.

### The mutation does not reach the write on any ordinary fixture

`checkTokenStorePerms` has three early returns before `:619`, each of which yields **zero chmod calls**
regardless of whether the mutation is present:

| Guard | Line | Outcome |
| --- | --- | --- |
| `storePath()` throws | `:576-578` | `return { status: 'pass' }` — 0 chmods |
| `modeOf(target, statPath) === null` (file absent) | `:580-582` | `return { status: 'pass' }` — 0 chmods |
| `loose.length === 0` (perms already tight) | `:601-603` | `return { status: 'pass' }` — 0 chmods |

`statPath` defaults to `defaultStatPath` (`doctor.ts:626-632`), i.e. real `fs.statSync`, and — as §5b
correctly states — `deps` is unreachable from the registered-handler path. So for the mutated handler to
produce a single chmod call, the test must arrange a **real** on-disk tree at whatever
`getTokenStorePath()` returns, with at least one of the four audited paths at the wrong mode.

The plan says only: *"on a fixture with a loose-mode token store"*. It names no mechanism. And the
mechanism this repo's own house style supplies is the vacuous one:

> `src/commands/doctor/__tests__/doctor-corrupt-token-store.test.ts:12-21` drives the real `doctor()`
> while `vi.mock('src/lib/env-tokens')` returns `getTokenStorePath → '/home/u/.infra-kit/projects/api/tokens.json'`.

That path does not exist. `fs.statSync` throws, `modeOf` returns `null`, `checkTokenStorePerms` returns
`pass` at `:580`, and the spy records **zero calls with the mutation in place**. An implementer copying the
one existing precedent for "drive the real `doctor()`" writes a green test on the exact bug U-D2 exists to
catch. Note that this is *the same file* revision 3 was reaching for when it specified
`vi.mock('src/lib/env-tokens')` — the fix moved the spy but left the fixture on the same rock.

Compounding it: every existing `checkTokenStorePerms` test
(`__tests__/env-token-checks.test.ts:263-277`, `permDeps`) injects `storePath`/`statPath`/`chmodPath`
wholesale and never touches the filesystem. There is **no** precedent in this repo for the real-FS fixture
U-D2(b) requires, so "on a fixture with a loose-mode token store" is not a pointer to a known pattern — it
is an unwritten one.

### The structural defect: a bare negative assertion cannot distinguish "guard held" from "fixture inert"

This is the property all four incarnations share. `expect(spy).not.toHaveBeenCalled()` is green when the
guard works *and* green when the setup never armed. Nothing in the test can tell the two apart, and CI
reports the second as success.

**The plan already knows the right shape and uses it elsewhere.** U-S5 reads: *"With that module mocked,
running `init` records **zero** calls; flagless `setup` records one per missing tool."* That second clause
is a positive control — it proves the instrument works before the negative assertion is allowed to mean
anything. U-D2(b) has no equivalent. Apply the plan's own pattern to the plan's own flagship test.

### What U-D2(b) must say instead

1. **Fixture, named.** `fs.mkdtempSync` a tree `<tmp>/.infra-kit/projects/<name>/tokens.json`; `chmod`
   the three directories `0o755` (expected `0o700`) and the file `0o644` (expected `0o600`).
   Partial-mock `src/lib/env-tokens` via `importOriginal` — replacing **only** `getTokenStorePath` — so
   `checkTokenStorePresent` and `checkEnvTokensConfigured`, which consume the same barrel, keep working.
2. **Positive control, in the same file, same fixture.** `await doctor({ fix: true })` — the exported CLI
   function — must record **≥ 1** `chmodSync` call whose target is one of the fixture paths. If that
   assertion is red, the fixture is inert and the negative assertion below it is meaningless. Say so in
   the test's own comment.
3. **Negative assertion, scoped.** Drive the *registered* handler and assert **zero** `chmodSync` calls
   *on fixture paths* — not zero calls globally. `doctor()` is ~24 checks wide and a global count invites a
   false red that gets "fixed" by loosening.
4. **Neutralise the other `--fix` writer.** `doctor.ts:1461-1470`: `options.fix` also runs
   `pruneStalePortlessRoutes()`, whose loop `await removeAlias(alias)` really removes portless routes on
   the machine running the suite. A unit test that drives `doctor({fix:true})` must stub that, or the
   positive control has a live side effect on the developer's host.

The §5b alternative ("real temp-dir fixture, assert the mode is unchanged") is *closer* to sound because it
observes an effect rather than an absence — but on its own it has the identical hole: a mode that was never
loose is trivially "unchanged". It needs the same positive control.

**Verdict on the headline item: the mutation named in §5b (`handler: (params) => doctor(params)` plus a
0644 store) does not red the test as specified.** Three prior reviewers missed this because they checked
the seam and stopped; the seam is now right and the test is still not a test.

---

## 1. Five further blocking items

### B2 — `mcp-stdio.e2e.test.ts:253` is an unlisted edit site, and its tempting fix destroys a guard

`assertToolsListIsCatalog` (`src/mcp/__tests__/mcp-stdio.e2e.test.ts:237-255`) ends:

```
expect(actual).toEqual(expected)
expect(actual).not.toContain('doctor')
expect(actual.size).toBeGreaterThan(20)
```

Line `:253` is a hard assertion that **`doctor` is never an exposed MCP tool**, run twice (legacy and
modern lanes). Phase 4 flips `mcpExposed: true` and reds it. The plan's E-1 names only
`REQUIRES_INTERACTION_TOOLS` (actually `:257`, plan says `:258`) and never mentions `:253`.

This matters more than an ordinary missed line because the comment immediately above it (`:250-252`) warns
that *"the natural 'fix' is to loosen the assertion — which destroys the drift guard this exists to be"*.
An agent meeting an unexplained red on a line it was not told about will delete it. The plan must state the
intended replacement (`expect(actual).toContain('doctor')`, so the invariant inverts rather than
evaporating) and must also update the now-false doc comment at `:263-268`, which reasons about
`setup-dependency-status` being read-only — a tool Phase 3 deletes.

### B3 — Phase 6 does not state the version to publish, and Phase 7 cannot go green below 0.5.0

`plugins/infra-kit/commands/release-create.md:8` names the floor **0.5.0**. Published and local version are
both **0.4.0** (`apps/infra-kit/cli/package.json`). `publish-gate.test.mjs:9-12` records that the gate is
*"red on `main` today by design"* for exactly that reason, and `.github/workflows/plugin-ci.yml:47-48` runs
`node scripts/check-workflow-resource-published.mjs` as a **gating** step (no `continue-on-error`) on any
PR touching `plugins/**`.

Phase 7's PR touches `plugins/**`. So Phase 7 is red unless Phase 6 published **≥ 0.5.0** *and* that
published build answers `resources/list` with **both** `infra-kit://workflow/release-create` and
`infra-kit://workflow/setup`. The plan's Phase 6 says only "publish". This is structurally the same defect
the architect caught in Phase 1's `pnpm run qa` — a criterion that cannot be met for a reason outside the
diff — and it is unaddressed. State the version (0.5.0 follows from §1's "removed in 0.6.0" and current
0.4.0, but an agent should not have to infer it), and state that `setup.md`'s floor sentence must name that
same version.

Related and tight: `setup.md`'s three-line body (U14, `manifest.test.mjs:637`, an **equality**) must carry
the resource URI, the floor sentence in the parseable form, the MCP-tool fallback, *and* the
not-connected clause. `release-create.md:7-9` proves it fits — but only just, and the plan should point at
it as the literal template rather than describing the four obligations separately.

### B4 — I-12 as written tests a synthetic seam, not the shipped file

`publish-gate.test.mjs` builds its inputs from a factory (`:18-26`, `command(name, overrides)`), so a new
row `command('setup')` asserts something about `collectViolations`, and **nothing whatsoever** about
`plugins/infra-kit/commands/setup.md`. The check that binds the real file is the script itself —
`readCommands()` enumerates the directory — invoked only by the CI step above.

As written, an implementer satisfies I-12 by adding a green synthetic row. Phase 7's criterion must name
the executable check: `node scripts/check-workflow-resource-published.mjs` exits 0. (Keep the synthetic row
too if you like; it is not the guard.)

### B5 — Phase 5's `infra-kit audit --fix --root` will regenerate the **old** block

`resources/root/body.md` is `?raw`-imported at `src/lib/agent-guidance/resources.ts:13` and therefore
**bundled into `dist` at build time**. It is not read from the working tree at run time. Both binaries
resolvable from this repo — `node_modules/.bin/infra-kit` and `~/Library/pnpm/bin/infra-kit` — are builds
of published code.

So Phase 5's literal instruction *"then `infra-kit audit --fix --root`"* regenerates `/CLAUDE.md` from
**0.4.0's** bundled body, silently discarding the edit Phase 5 just made. Phase 5's own criterion — *"zero
non-`docs/` grep hits for `infra-kit init` as an instruction"* — is then unreachable, and the agent's most
likely recovery is to hand-edit `/CLAUDE.md`, which `body.md:4` explicitly forbids (*"edit text _outside_
the markers, never inside"*).

Phase 5 must read: build the CLI, then run **that** build by absolute path
(`node apps/infra-kit/cli/dist/cli.js audit --fix --root`), never a bare `infra-kit` and never
`pnpm exec`.

### B6 — §Naming rule 1 never decides what `body.md:4` and `:15` actually say

Rule 1 requires the binary-qualified form. It does not say *which command*. Today:

- `resources/root/body.md:4` — *"This block is generated by `infra-kit init`"*
- `resources/root/body.md:15` — *"`ik init` — re-runs shell integration **and** refreshes every guidance block in the repo."*

Rendering `:4` as "generated by `infra-kit setup`" would tell every consumer that **regenerating a
documentation block means running the five-package installer** — Scenario 5's exact failure mode, authored
by this plan into the one text it fully controls. Decide it explicitly: `:4` should point at
`ik audit --fix --root` (the command that actually regenerates the block, already listed at `:13`), and
`:15`'s row should either become `ik setup --skip-tools` or be dropped in favour of the existing
`audit --fix` row. This is a one-line decision, but it is a decision, and leaving it to the implementer
under a rule that only constrains *spelling* is how the wrong one gets made.

---

## 2. What I checked and found sound

Recorded so a later round does not re-litigate it.

**Principle–option consistency.** Principle 4 ("never a second copy of a list you don't own") is honoured
throughout revision 5: the `dependencies[]` sibling array is gone, `DOCTOR_CHECK_NAMES` is verified derived
(`report.ts:113`, `SECTION_MEMBERS.flatMap`), and §Naming rule 3's refusal to narrate `pnpm run setup` is
the same principle applied honestly against the plan's own convenience. I-10's edit to `MUTATING_INVOCATIONS`
is not a violation — `manifest.test.mjs:465-467` argues in so many words that a deny-list is not a second
inventory. Principle 3 is real: `command-catalog.ts:519-525` plus the dedicated test at
`command-catalog.test.ts:265-274` is exactly the `audit` precedent claimed. Principle 5 is honoured by
deletion, and the deletion is structural: `COMMAND_FRONTMATTER_KEYS` (`manifest.test.mjs:617`) is
`deepEqual`-pinned to `['argument-hint','description','name']`, so a command *cannot* carry
`allowed-tools`. That remains the strongest move in the plan.

**Principle 6 is the one violated — by U-D2(b), §0.**

**Option rejections are argued, not strawmanned.** Option B's rejection turns on two verified facts (MCP
rules match tool name only; the confirm token is HMAC-bound to canonical args, so an argument-selected gate
is an agent-selected gate), and the plan volunteers the `--tools` asymmetry that makes the argument look
weakest. Option C is rejected "on the stated goal, not on the merits" — and *says so in those words*,
retaining it as the fallback. That is honest, and it is still the right call: the owner's verbatim fence
names `setup status` as a name to fold and names all three surfaces, so a design that leaves MCP at three
tools does not answer the request. No dressing-up detected.

**Pre-mortem guards, individually.** Scenario 2's guard (I-3 + U-S5) is well-formed and carries the
positive control U-D2(b) lacks. Scenario 3's guard (I-2, stated over the registered population rather than
by name) survives a rename, as claimed. Scenario 4's three guards are each real and each verified at
source: U14's `deepEqual`; `MUTATING_INVOCATIONS` is indeed **five** needles at `manifest.test.mjs:479-485`
with the `setup-dependency` ⊂ `setup-dependency-status` prefix caveat at `:475-478` exactly as described;
the publish gate is genuinely CI-wired (subject to B3/B4). Scenario 4's honest conclusion — that in
`bypassPermissions` infra-kit adds no marginal exposure and claiming a gate there would be claiming credit
for a control not on the path — is the correct answer and a better one than the patch would have been.
**Scenario 1 is the exception: its sole guard is U-D2, and U-D2 does not fire (§0).**

**Phase 1's replacement gate is achievable.** Confirmed at source: root `package.json:23` is
`"qa": "pnpm run vendor:check && pnpm exec turbo run …"`, so `vendor check` short-circuits the whole gate
with `&&`. The four named per-package commands sidestep it correctly, and excluding the known-red check *by
name* rather than by hope is the right resolution of the architect's finding.

**Sequencing.** Phase 6 owing the served `infra-kit://workflow/setup` before Phase 7's command is correctly
ordered — only `release-create.md` exists today (`src/mcp/resources/index.ts:22`,
`resources/workflow/release-create.md`), so the resource is genuinely new work and genuinely Phase 6's.
The A/B/C commit decomposition holds, and Phase 1's explicit "the four untracked files stay unstaged —
expected, not a failure" is the kind of instruction that keeps a ralph loop from inventing work.

**Deliberate-mode requirements are met**: five substantive pre-mortem scenarios, and unit / integration /
e2e / observability coverage all present and non-token. E-4's insistence on a host with at least one
dependency missing, "so 'installed nothing' is an observation rather than a vacuous pass", is precisely the
discipline §0 asks the plan to apply to itself.

---

## 3. Non-blocking notes

- **"`doctor` leaves the P1 gate's population" is imprecise.** The filter is
  `entry.mutating && entry.mcpExposed` (`command-catalog.test.ts:246-248`), and `doctor` is
  `mcpExposed: false` today — so it is *already* outside the population. What the flip actually removes is
  the **conditional** tripwire: today, exposing `doctor` while it is `mutating: true` would red the gate.
  The substance of the plan's argument is unaffected, and the catalog's own comment
  (`command-catalog.ts:505-508`) uses the same loose framing, so this is a wording note only.
- **Phase 3 leaves the e2e suite red until Phase 4.** `REQUIRES_INTERACTION_TOOLS`
  (`mcp-stdio.e2e.test.ts:257`) names `setup-dependency`, which Phase 3 deletes; the plan schedules that
  edit in Phase 4 (E-1). Phase 3's criteria are enumerated tests rather than "suite green", so this is
  consistent — but say it out loud, or a loop running a broad `vitest` reads it as a regression it caused.
- **I-13's regex needs a corpus and an allowlist.** `/(^|\s)setup\b/` matches inside `setup-dependency`
  (`-` is a non-word char) and will hit any prose or heading using the word. Specify that the check runs
  over rendered guidance text, and that headings are exempt — otherwise it is a criterion that fails for
  reasons unrelated to the invariant.
- **U-S7 states no positive control**, where its twin U-S5 does. Add the same "flagless `setup` records one
  per missing tool" clause so the zero-call assertion is anchored.
- **Citation drift, ±1–2 lines, on several anchors**: `EXPECTED_GATED_TOOLS` is `:208` not `:209`;
  `groupPaths('setup')` is `:380` not `:378`; the doctor rows are `:1403` / `:1415` / `:1421` not
  `:1402` / `:1414` / `:1421`; `mcp-stdio.e2e.test.ts`'s `REQUIRES_INTERACTION_TOOLS` is `:257` not `:258`.
  Everything else I spot-checked landed. The plan already warns these are working-tree reads and Phase 0
  re-verifies, so this is noise, not a finding — recorded only so nobody treats a one-line miss as evidence
  the plan is stale.
- The `.claude/settings.json` `ask` list is confirmed as described (three rules on the installer, zero on
  `init`, at `:11-14`), and `allowUnknownOption` is confirmed **absent** from the entire CLI, so the
  "misspellings fail closed" argument that `--skip-tools` rests on holds.

---

## VERDICT: ITERATE

### Blocking items

1. **U-D2(b) does not bite.** The seam (`vi.spyOn(fs, 'chmodSync')`) is correct, but every early return in
   `checkTokenStorePerms` yields zero chmod calls under the mutation, and the assertion is a bare negative
   with no positive control — so "guard held" and "fixture never armed" are indistinguishable. Specify the
   real-FS fixture, add the positive control (`doctor({fix:true})` on the same fixture must record ≥1
   chmod), scope the negative assertion to fixture paths, and stub `pruneStalePortlessRoutes`.
2. **`mcp-stdio.e2e.test.ts:253` (`expect(actual).not.toContain('doctor')`) is an unlisted Phase 4 edit
   site**, and its tempting fix is deletion of a guard its own comment warns against loosening. Name it,
   name the replacement (`toContain`), and fix the stale doc comment at `:263-268`.
3. **Phase 6 must name the publish version (≥ 0.5.0)** — `release-create.md:8` floors at 0.5.0, published
   is 0.4.0, and `plugin-ci.yml:47-48` gates Phase 7's PR on
   `scripts/check-workflow-resource-published.mjs`. The published build must serve both workflow URIs.
4. **I-12 must name the executable check.** `publish-gate.test.mjs` uses synthetic command objects and
   asserts nothing about the shipped `setup.md`; the binding check is
   `node scripts/check-workflow-resource-published.mjs`.
5. **Phase 5 must build the CLI and run it by absolute `dist/cli.js` path.** `body.md` is `?raw`-bundled
   (`src/lib/agent-guidance/resources.ts:13`), so a bare `infra-kit audit --fix --root` regenerates the old
   block and silently discards Phase 5's edit.
6. **Decide what `resources/root/body.md:4` and `:15` say**, not merely that they are binary-qualified.
   "This block is generated by `infra-kit setup`" would instruct every consumer that regenerating docs
   means running the installer — Scenario 5, authored by this plan.

None of these is a design objection. Items 2–6 are mechanical and should take one pass. Item 1 is the one
that has survived four rounds, and it should not survive a fifth: the plan already contains the correct
pattern at U-S5, and applying it to U-D2(b) is the whole fix.

---

# Round 2 — review of revision 6 (2026-09-10)

Final gate. Revision 6 is 1473 lines; every line number below was read this pass.

## R2.0 — Five of my six blockers are discharged substantively

Verified individually, not accepted on report:

| # | Where | Verdict |
| --- | --- | --- |
| B2 | plan `:553-556` | **Discharged.** `mcp-stdio.e2e.test.ts:253` is now an enumerated Phase 4 edit site, and the repair is spelled as an inversion (`expect(actual).toContain('doctor')`) with the `:250-252` warning quoted as the reason not to delete |
| B3 | plan `:1232`, `:1236-1245` | **Discharged, and better than I asked.** `0.5.0` is named. The claim that it discharges a pre-existing red is true: `scripts/check-workflow-resource-published.mjs:71` reads verbatim *"the gate is red today for `release-create` (floor 0.5.0, published 0.4.0)"*, and `resources/workflow/release-create.md` is tracked and clean, so Phase 6 acquires no dependency on in-flight work |
| B4 | plan `:1015` | **Discharged.** I-12 now reads `node scripts/check-workflow-resource-published.mjs` exits 0. The named mutations are real: the floor regex is at `check-workflow-resource-published.mjs:59` (`/it needs infra-kit (\d+\.\d+\.\d+) or newer/`) and the URI regex at `:60`, both parsed out of the shipped body |
| B5 | plan `:1212-1216` | **Discharged.** Builds first, then `node <abs>/apps/infra-kit/cli/dist/cli.js audit --fix --root`, with `pnpm exec` excluded by name |
| B6 | plan `:394-398` | **Discharged.** `:4` → ``ik audit --fix --root``, `:15` → `ik setup`. Neither string claims the other's job, which was the whole of the ask |

The `0.6.0` → `0.7.0` sweep is complete: all six surviving `0.6.0` occurrences (`:25`, `:26`, `:1248`,
`:1249`, `:1253`, `:1259`) are historical narration of the change itself; every live instruction —
the deprecation string `:450`, I-3 `:1008`, I-10 `:1014`, U-S7 `:999`, E-4 `:1034`, Observability `:1047`,
§5 `:801`, §2 `:605`, Phase 3 `:1196` — reads `0.7.0`.

The `readTokenStore` correction is right and the architect was wrong: `doctor.ts:38` is
`import { getTokenStorePath, readTokenStore } from 'src/lib/env-tokens'`, and `readStore` defaults to it at
**`:341` and `:501`** — two sites, not three.

## R2.1 — The deprecation conjunction is sound

The reasoning at `:1256-1263` is correct and is the strongest new thinking in this revision: a version
floor counts *CLI releases*, while what actually goes stale is the *committed block*, which advances only
when someone runs the regenerating command inside that repo. starter-workspace's `0.3.14` marker against a
published `0.4.0` is proof that the two clocks are independent, so no number of minors bounds the risk on
its own. Gating on **both** — at or after `0.7.0` **and** every consumer marker ≥ `0.5.0` — measures both
clocks.

It is also fail-safe by construction: a conjunction of necessary conditions can only delay the removal,
never accelerate it. And the closed-set caveat at `:1384-1387` has the right polarity — *"a fifth [consumer]
is a reason to re-open the removal date, not to waive the check"*. The opposite reading (sweep the four we
know, ship) is the one that would convert an unknown into a pass, and the plan explicitly refuses it.

Nothing here blocks code: `init`'s removal is out of scope for this plan and sits in §Follow-ups. Recorded
as sound so a later round does not re-derive it.

## R2.2 — U-D2(b): the positive control can go green while the negative half is dead. **This is the fifth vacuum.**

The lead asked me to look specifically at whether the positive assertion can pass for a reason other than
the code being correct. It can't — that half is fine. The defect is one layer over: **the positive
assertion, by passing, destroys the fixture the negative assertion depends on.**

### The mechanism

Three facts, each verified at source this pass:

1. **`vi.spyOn` calls the original through by default.** Not inferred from docs — proven from this repo:
   `src/lib/config-bootstrap/__tests__/config-bootstrap.test.ts:115-122` installs a bare
   `vi.spyOn(fsp, 'writeFile')`, asserts `toHaveBeenCalledTimes(1)`, **and then reads the file back and
   asserts the new bytes are on disk**. The real write happened. Vitest 5.0.0.
2. **No mock state is auto-cleared.** `apps/infra-kit/cli/vitest.config.ts`'s `test` block sets no
   `clearMocks`, `restoreMocks` or `mockReset`. The repo knows this — `config-bootstrap.test.ts:99` calls
   `infoSpy.mockClear()` by hand.
3. **§5b orders the assertions positive-first, in one test.** Plan `:991` — *"One test, one fixture, two
   assertions in opposite directions"* — and `:1131-1137`, numbered 1 = positive control, 2 = the
   invariant.

Compose them:

- **Assertion 1** runs `await doctor({ fix: true })`. `checkTokenStorePerms(true)` finds `loose.length === 4`
  and calls `chmodPath` four times. The spy **calls through**, so the fixture's four paths are physically
  chmod'ed to `0o700`/`0o700`/`0o700`/`0o600` — *exactly the expected modes* (`doctor.ts:274-275`). The
  fixture is now tight.
- **Assertion 2** then runs the handler against that tight fixture. Under the mutation
  `handler: (params) => doctor(params)`, `checkTokenStorePerms(true)` computes `loose.length === 0` and
  returns at **`doctor.ts:601`** — the early return §5b's own table at `:1095` lists as one of the four
  zero-chmod routes. **Zero chmod calls. Assertion 2 green. The mutation is undetected.**

### The trap closes itself

On *correct* code the same ordering makes assertion 2 red for an unrelated reason — the spy still holds
assertion 1's four calls, because nothing cleared it (fact 2). So the implementer's very first run fails,
and the obvious repair is `spy.mockClear()` between the halves. That edit turns "red on correct code" into
"green on the mutation". The default trajectory does not merely permit the vacuum; it walks into it.

Everything §5b needs to see this is already in §5b — it names the call-through seam, and its own table
names `loose.length === 0` as a zero-chmod route. It just never connects the two.

### The fix is one sentence: **run the negative assertion first**

On a fresh loose fixture, with the spy starting empty:

- Correct code: handler → `options.fix` is `false` → path `:610` → **zero** fixture-path calls ✓. Then
  `doctor({ fix: true })` → **four** ✓. Both halves green, both meaningful.
- Mutated code: handler → `fix` forwarded, `loose.length === 4` → four chmods → **the negative assertion
  reds immediately** ✓.

No `mockClear`, no `mockImplementation`, no fixture rebuild. Just the opposite order from the one written
down.

Two alternatives, either acceptable, both more moving parts: (a) `mockImplementation(() => {})` to suppress
call-through so the fixture stays loose, plus an explicit `mockClear()` between halves; (b) split into two
`it`s with a `beforeEach` that rebuilds the fixture **and** clears the spy — note the clear is *not*
optional, since fact 2 means mock state survives across tests in this config.

Whichever is chosen, §5b must say why: *the positive control mutates the fixture it shares with the
negative one.* Left unstated, the next editor reorders the assertions back for readability and re-opens it.

## VERDICT: ITERATE

### The one thing that blocks code

**U-D2(b)'s two assertions must not run positive-first against a shared fixture** (plan `:991`,
`:1131-1137`). `vi.spyOn` calls through (`config-bootstrap.test.ts:115-122`), no mock state is auto-cleared
(`vitest.config.ts`), so assertion 1 tightens the fixture and assertion 2 then takes the
`loose.length === 0` early return at `doctor.ts:601` — green on the mutation `handler: (params) => doctor(params)`.
Reverse the order (negative first), or suppress call-through and clear between halves, and record the
reason in §5b so it cannot be reordered back.

Everything else in revision 6 is approved. This is a one-sentence change to one section — not a redesign,
and not a reason to touch any other part of the document. Nothing else goes to §Cut/deferred; there is
nothing else.

For the record, since §4's funding has now failed five times for five *different* reasons — self-call spy,
wrong module, bare negative, and now self-defeating fixture order — the stop condition at `:1148-1150` is
the right instrument and should be exercised literally: **run the mutation before believing the test.**
Write `handler: (params) => doctor(params)`, run U-D2(b), and require a red. A green there means the sixth
vacuum, whatever the assertion text says.

---

# Round 3 — review of revision 7 (2026-09-10)

## R3.1 — The ordering fix closes the hole. Verified, not accepted.

§5b `:1179-1189` now runs the negative assertion first. I traced both code paths against source rather
than against the plan's description:

**Assertion 1, correct code.** `doctorMcpTool.handler` is nullary (`doctor.ts:1541-1543`), so `options`
takes its `= {}` default at `:1396`, `options.fix ?? false` is `false` at `:1451`, and
`checkTokenStorePerms(false)` walks past `loose.length === 4` and returns at **`:610`** (`!fix` → fail).
**Zero chmods, and — this is the load-bearing part — zero writes of any kind.** The fixture is untouched.

**Assertion 2.** The fixture is therefore still loose when `doctor({ fix: true })` runs, `loose.length`
is still `4`, and the `:619` loop fires four times. Cumulative counts 0 → 4, exactly as `:1188-1189`
claims.

**Under the mutation.** `handler: (params) => doctor(params)` forwards `fix: true`, `checkTokenStorePerms(true)`
finds four loose entries, and assertion 1 sees four calls where it requires zero — **red on the first
assertion**, before the fixture is altered.

**Does anything between the two calls perturb the tree?** No, and I checked the two candidates rather than
assuming:

- `chmodSync` has **exactly one** call site in the file — `doctor.ts:571` resolves it, `:619` calls it.
  Nothing else in the ~95-check pass can touch a mode.
- The `--fix`-only branch at `doctor.ts:1461` does not run during assertion 1 at all, because
  `options.fix` is `false` there. Assertion 1 is inert by construction, not merely by convention.

The "still-loose fixture" claim at `:1184` holds. The hole is closed.

The supporting material is right too: `:1198-1203` records both environmental facts with the precedents I
cited, and I re-confirmed each (`config-bootstrap.test.ts:115-122` proves call-through; `:99` shows the
manual clear; no `clearMocks`/`restoreMocks`/`mockReset` in either config). `:1211-1216` names
`spy.mockClear()` as the wrong repair and says why — which is the part that matters, because the fix
itself is invisible unless the reason travels with it. `:1218-1222`'s justification for preferring
negative-first over the two sanctioned variants (no cleanup step a later edit can drop) is the correct
reason to prefer it. And `:1194` marks the escape route as `doctor.ts:601` by name.

Zero occurrences of a positive-first residual. Confirmed.

## R3.2 — The count correction is right, and my "five times" was the loose one

Four specifications (1, 3, 5, 6 — the §5b table at `:1129-1134`), five failure modes, because revision 1
was wrong in two independent ways (§5a). That is internally consistent and it is the accurate count. The
planner was right to refuse a number that its own table contradicts, in a section whose entire force is
the history.

**One straggler, and it is in the place reported as synchronized.** The Phase 4 criterion still reads
*"specified wrongly **five revisions** with five distinct failure modes"* (plan `:1303`), against §5b's
heading `:1121`, its body `:1123`, its stop-condition paragraph `:1235`, and the changelog `:41`, all of
which now read "four". Documentation only — the procedure in that same criterion ("write the mutation, run
it, observe the red, revert, record it in the PR") is unambiguous and unaffected — so it does not block
code and I am not making it a condition. Fix it in passing.

## R3.3 — Nothing else moved

Spot-checked the sections a §5b edit could plausibly have disturbed: the §5b table, the four-path
early-return table (`:1139-1144`), the fixture layout (`:1158-1164`), the `readTokenStore` note
(`:1172-1177`), Phase 4 (`:1291-1305`), and the changelog. The +99 lines are where they were reported to
be. All six of my round-1 blockers remain discharged as verified in round 2; the 0.7.0 conjunction and its
closed-set caveat are unchanged.

## VERDICT: APPROVE

---

## The single thing most likely to go wrong despite the plan

**`doctor({ fix: true })` deletes the developer's portless routes, and U-D2(b) now calls it deliberately —
twice.**

`doctor.ts:1461-1470`: `if (options.fix)` runs `pruneStalePortlessRoutes()`, whose loop is
`await removeAlias(alias)` — a real mutation of the machine's portless config. The gate is
`decidePrune(probed, devSessionRunning)` (`prune-routes.ts:67-81`), and it returns `prunable: dead` —
every non-live route — **whenever no `infra-kit dev` runner is alive**. That is the ordinary state of a
machine running a unit suite. The prune is not withheld during tests; it is *enabled* by them.

U-D2(b)'s assertion 2 is `await doctor({ fix: true })`. Phase 4's new mutation drill then runs the suite
again with the handler forwarding `fix: true` as well. So the plan's own acceptance procedure invokes the
route remover at least twice, on the implementer's host.

Why this is the thing that goes wrong *despite* the plan rather than because of a gap in reasoning:

- **It is silent.** No assertion in U-D2(b) observes it. Both halves match on fixture paths (`:1191-1192`),
  which is correct for the chmod seam and blind to this. The suite goes green.
- **The plan looks like it covered it and stops one line short.** `:1228-1230` enumerates the cost of
  driving the full `doctor()` — *"~95 checks including `gh`/`doppler`/`aws` spawns, so this test is slow
  and touches the network"* — and says stub them for speed. Every item there is a *reader*. The one
  **writer** on the `fix: true` path is not named anywhere in the document: `pruneStalePortlessRoutes`,
  `removeAlias` and "portless route" have **zero occurrences** in all 1572 lines. A reader who follows
  §5b's cost paragraph will stub the spawns and leave the writer running.
- **The damage surfaces somewhere else entirely**, hours later, as a dev proxy that 502s — the symptom
  this repo has already recorded from a different cause, which makes it likely to be misdiagnosed rather
  than traced back to a test run.

**The mitigation is one line and belongs in §5b's fixture setup, not in review:** mock
`src/commands/doctor/prune-routes` (or stub `pruneStalePortlessRoutes`) for this test. It is independent
of the chmod seam, so it costs the assertions nothing — the same argument §5b already makes for stubbing
the gh/doppler/aws spawns. Add it to the same paragraph.

Two smaller places a literal reader could stumble, recorded so they are not rediscovered: §5b cites
`doctor-corrupt-token-store.test.ts:12-21` as the proven `vi.mock` boundary but not `:23-34`, where that
same file **partially** mocks `src/integrations/doppler` via `importOriginal` because *"`env-load` pulls
its own constants off this barrel, so a wholesale replacement breaks the import graph before a single
check runs"* — a new doctor-driving test will meet that wall, and it fails at import time in a way that
looks nothing like a fixture problem. And §Known limitations still records that U-D2(b)'s soundness rests
on `doctor.ts:1` staying a default `import fs from 'node:fs'`, with two hardenings offered and neither
adopted; in a repo whose post-edit formatter is recorded to rewrite imports, that is the one silent
re-vacuation path left open. Neither blocks code. Both are cheaper to read here than to debug.
