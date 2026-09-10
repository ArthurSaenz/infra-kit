# Commit 1 (CLI) — independent verification

Reviewer: `verify-commit1`. Read-only pass.

**Verdict: APPROVED** (re-review, after the blocking fix). See **Re-review** at the end of this
document for the evidence.

Verdict history — the middle entry is the one that matters for reading the body below:
**APPROVED** (superseded — predates adjudication 4) → **REJECTED, one blocking fix**
(Adjudication 4) → **APPROVED** (fix verified end-to-end against a bundle built in the re-review).
Everything in the criteria pass below stood throughout; only Adjudication 2's recommendation changed,
and it is marked WITHDRAWN in place.

## Lanes, re-run independently (zsh, no pipes, `echo "EXIT=$?"`)

| Lane | Command | Result |
| --- | --- | --- |
| tsc | `pnpm exec tsc --noEmit` (in `apps/infra-kit/cli`) | `TSC_EXIT=0` |
| prettier | `pnpm exec prettier --check <13 files, each quoted>` | `PRETTIER_EXIT=0`, "All matched files use Prettier code style!" |
| eslint | `pnpm exec eslint --no-cache <13 files>` | `ESLINT_EXIT=0`, 1 warning: `init.ts:37 @ik/max-jsdoc-summary-lines` (8 > 5) |
| vitest (targeted) | 11 suites incl. the 3 reverted ones | 11 files / 140 tests, `EXIT=0` |
| vitest (whole package) | `pnpm exec vitest run` | **260 files passed, `FULL_EXIT=0`** |

The eslint warning is confirmed pre-existing: `git show HEAD:…/init.ts` carries the same
8-line summary paragraph on the `MARKER_END`/zshrc block JSDoc, and no hunk in this diff
touches it.

`sonarjs/cognitive-complexity` is confirmed **active and erroring**, not merely present:
`pnpm exec eslint --print-config src/lib/plugin-pointer/mcp-registration.ts` reports
`'sonarjs/cognitive-complexity': [2, 15]` (severity 2 = error). eslint exit 0 therefore
discharges the ≤ 15 constraint on the new code. (For contrast, `sonarjs/cyclomatic-complexity`
and `sonarjs/expression-complexity` are both severity 0 in this package — off.)

## Per-criterion findings

### US-001 — the gate split (`agent-files.ts`)

- **`resolveGitRoot` exported, null on throw / blank / whitespace / `$HOME`, every null logs `logger.info`** — **PASS**.
  `agent-files.ts:88-124`. Rejection is `root === '' || root === os.homedir()` after a `.trim()`,
  so whitespace-only stdout is covered by the same branch. Both null paths call
  `logger.info(SKIPPED_GIT_ROOT_STEPS)`; there is no `logger.debug` anywhere in either resolver, and
  `resolve-roots.test.ts:102` asserts `logger.debug` was *not* called on the reject path.
- **`resolveInfraKitRoot` exported, = `resolveGitRoot` + `<root>/infra-kit.json`, own message** — **PASS**.
  `agent-files.ts:126-140`, `SKIPPED_GUIDANCE_ONLY`.
- **The two skip strings AMENDED, not added to** — **PASS**. HEAD's two literals
  (`'Skipped agent-instruction files — not inside an infra-kit repo'` and
  `'… — no infra-kit.json at the repo root'`) are both gone from the file; the diff replaces them
  in place with `SKIPPED_GIT_ROOT_STEPS` (names guidance + pointer + install + `.mcp.json`) and
  `SKIPPED_GUIDANCE_ONLY` (names guidance, and explicitly says the other three are *unaffected*).
  Nothing was appended alongside the old text.
- **Former callers compile; `syncRepoGuidance` keeps the `infra-kit.json` predicate** — **PASS**.
  `writeAgentFiles` (`:163`) and `syncRepoGuidance` (`:244`) both now call `resolveInfraKitRoot`,
  which is the same predicate they had. `tsc` exit 0.
- **Unit test pins blank → null and `$HOME` → null** — **PASS**, and both are genuine
  (see adjudication 3, criterion 2.4).

### US-002 — the `.mcp.json` writer

- **1.1 byte-for-byte unchanged when already registered** — **PASS**. `mcp-registration.test.ts:162-177`:
  `read()` equals `BOTH_SERVERS` exactly, **and** `statSync().mtimeMs` is unchanged after a real 10 ms
  sleep, so "no write" is proven rather than "an identical write". Zero warns.
  A second case (`:179`) proves a *deliberately different* `infra-kit` entry
  (`command: '/usr/local/bin/infra-kit'`, extra `--cwd` args) is left alone — that is the case a
  naive "normalise to the canonical entry" writer would break.
- **1.2 sibling byte-identical and STILL FIRST** — **PASS**. `:190-201`. Three independent
  assertions: whole-file equality against a hand-written expected string, `toContain(SIBLING_BLOCK)`
  (the sibling's own lines at their own indentation, so "identical" is bytes not a parsed deep-equal),
  and `Object.keys(serversOf(...))` equals `['linear-server', 'infra-kit']` — order asserted, not
  membership.
- **1.3 tab indent, key ABSENT** — **PASS**, not nominal. `TAB_INDENTED` (`:80`) contains only
  `linear-server`; the test additionally guards the guard at `:219`
  (`expect(serversOf(TAB_INDENTED)['infra-kit']).toBeUndefined()`), so `detectIndent` is provably
  entered. `:224` asserts `not.toContain('\n  "')` — no space-indented line anywhere in the result,
  which is what catches a reindent-the-whole-file regression.
- **1.4 misfiled key: no write, one warn, both keys named** — **PASS**. `:236-249`. mtime unchanged,
  bytes equal, `warnings()` length exactly 1, and that one string contains `"ik"`, `"infra-kit"` and
  the absolute path.
- **1.5a JSONC refused** — **PASS**. `:253-262`, plus two beyond-spec cases: a JSON **array** is
  refused rather than merged into (`:264`) and a non-object `mcpServers` is refused rather than
  clobbered (`:272`). Both land on `unparseable` with exactly one warn.
- **1.5b `{"$schema": …}` container created additively** — **PASS**. `:284-295`. `$schema` line
  asserted as a byte substring *at its original 4-space indent*, top-level key order asserted
  `['$schema','mcpServers']`, trailing newline asserted. This is the case the reader itself calls
  `unparseable` (`install-state.ts:228`), and the writer correctly keys off its own `JSON.parse`
  instead — the design point in the fileoverview at `mcp-registration.ts:21-25`.
- **1.6 absent file created** — **PASS**. `:306-328`, full expected bytes, exactly one server key,
  trailing newline.
- **1.7 three assertions, not a `kind === 'ok'` round-trip** — **PASS**, and stronger than specified.
  See adjudication 3.
- **Key is `MARKETPLACE_NAME`, never a fresh literal** — **PASS**. `mcp-registration.ts:7` imports it
  from `./plugin-pointer`; every key site (`:143`, `:184`, `:197`, `:213`) uses the constant. The
  *command* is a separate constant `SERVER_COMMAND = 'infra-kit'` (`:39`) with a comment stating the
  equality is coincidence (a PATH binary vs a marketplace name), which is the correct call — the
  criterion constrains the KEY only.
- **1.8 unwritable / non-file** — **PASS** (see US-004 for the `init`-level half).

### US-003 — doctor

- **2.6 `fixable` on every entry, true exactly for `FIXABLE_NAMES`; top-level `cliVersion`; the single
  outputSchema updated** — **PASS**. `doctor.ts:1504` adds `fixable: FIXABLE_NAMES.has(c.name)` to
  every mapped entry (not a subset); `:1510` adds `cliVersion: packageJson.version`. The outputSchema
  at `:1532`/`:1537` declares both. `report-inventory.test.ts` asserts *set equality* between the
  rows marked fixable and `FIXABLE_NAMES` itself (`[...fixable].sort()` vs `[...FIXABLE_NAMES].sort()`),
  not a hand-written literal list — so the test cannot drift from the source. `cliVersion` is asserted
  against `package.json` imported with `with { type: 'json' }`, again not a literal.
  `FIXABLE_NAMES` was already exported at `report.ts:123` on HEAD; this commit adds no export.
- **2.5 row renders in a git repo without `infra-kit.json`; missing-file message names
  `infra-kit init`** — **PASS**. `doctor.ts:1487` is
  `...(gitRoot === null ? [] : [checkMcpServerKey(gitRoot)])` — the predicate is `resolveGitRoot()`
  (`:1481`), while `resolveCheckedRepoRoot()` (`:1480`) is still used for the three
  `checkClaudePlugin` rows, which is correct: those read `~/.claude/`. `MCP_MESSAGES['missing-file']`
  is now `'No .mcp.json at the repo root yet, so there is no server key to check. Run: infra-kit init'`,
  and `claude-plugin-checks.test.ts:212-215` asserts both the new phrasing and `'infra-kit init'`.
- **2.8 (doctor half) blank git stdout → row OMITTED** — **PASS**.
  `report-inventory.test.ts` third gate test sets `gitTopLevel = ''` and asserts both
  `not.toContain('MCP server key')` **and** full set equality against
  `DOCTOR_CHECK_NAMES` minus that one name — so an omission that also lost some *other* row would
  fail.
- **The `doctor.ts:1456-1457` comment rewritten** — **PASS**. The "the same way the guidance check is"
  claim is gone; the replacement (now `:1471-1479`) states the row set follows the WRITER's gate, per
  writer, and explains why gating on `infra-kit.json` would leave the writer unmonitored in exactly
  the repos that lack one. It also records the blank-`rev-parse` reason.
- **2.9 all 30 names reconciled via a DELIBERATE `src/lib/git-utils` mock; zx mock NOT made
  command-aware** — **PASS**, proven causal. See adjudication 3.
- **`report.test.ts`'s `toHaveLength(30)` still passes; `SECTION_MEMBERS` NOT edited** — **PASS**.
  `git diff HEAD -- report.ts | grep -c SECTION_MEMBERS` = **0**; the whole `report.ts` diff is the
  one import line plus its 4-line comment. `report.test.ts` is green in both runs above.

### US-004 — init wiring

- **ONE `resolveGitRoot` root drives pointer + install + `.mcp.json`; guidance keeps
  `resolveInfraKitRoot`** — **PASS**. `init.ts:100-109`: `guidanceRoot` from `syncAgentGuidance()`,
  `gitRoot` from `resolveGitRoot()`, and `syncPluginPointer(gitRoot)` passes that single value to all
  three steps inside one function (`:366-384`). The pointer↔installation↔MCP one-root invariant holds:
  `ensurePluginPointer(path.join(root, …))`, `ensureMcpRegistration(root)` and
  `installPluginForProject({ projectRoot: root })` all read the same `root` parameter.
  Ordering is deliberate and correct — the MCP write precedes the install, because the install is the
  only step that spawns a process and so the only one that can fail for reasons unrelated to the repo.
- **2.1 non-git dir: both skips, neither file, exit 0** — **PASS**, with a recorded blemish.
  `init-plugin-pointer.test.ts:261-276`. See adjudication 2.
- **2.2 `.mcp.json` at the resolved ABSOLUTE root** — **PASS**. `:368-375` asserts the entry deep-equals
  the canonical value at `path.join(repo, '.mcp.json')`, that the path is absolute, **and** that
  `path.resolve('.mcp.json')` (the cwd-relative alternative) does **not** exist — the negative half is
  what makes this non-vacuous.
- **2.3 guidance skipped, other three performed, exactly one warn naming the absolute root and the
  files** — **PASS**. Two tests (`:278`, `:291`). The second filters warns on `line.includes(repo)`
  before asserting length 1, with a comment explaining why (a non-zsh `$SHELL` warn is legitimate and
  says nothing about this repo) — that filter is honest, not a loophole, because the assertion still
  pins "exactly one warn *about this root*". Content asserted: `'No infra-kit.json at'`,
  `.claude/settings.json`, `.mcp.json`, `PLUGIN_KEY`.
- **2.4 `$HOME` → nothing written** — **PASS**, genuinely on the `$HOME` branch. See adjudication 3.
- **2.8 (init half) blank seam → nothing written, skip, exit 0** — **PASS** and unusually strong:
  `:334-356` `chdir`s into a fresh empty tmpdir and asserts `fs.readdirSync(elsewhere)` is `[]`, so a
  regression that wrote cwd-relative files is caught positively rather than by a negative existence
  check at the intended root only. `process.chdir` is restored in `finally`.
- **1.8 unwritable / non-file `.mcp.json` → one WARN naming the path, init still exits 0** — **PASS**.
  Two tests: `.mcp.json` as a directory (`:377`, and the settings write is asserted to have still
  happened, proving the failure did not abandon the rest of `init`), and a real `chmod 0o500` root
  producing EACCES from the pointer's own `mkdirSync` (`:391`), which proves the `init.ts:373-383`
  catch now warns instead of the old `logger.debug` swallow. Residual gap noted below: EACCES on the
  `.mcp.json` path *specifically* is not directly exercised, but it lands in the same
  `writeFileOrWarn` catch the directory case covers.
- **2.7 additivity PER WRITER** — **PASS**. Three writers, three tests (`:421`, `:439`, `:454`):
  `.claude/settings.json` (a deliberate `false` opt-out and a forked marketplace source both survive),
  `.mcp.json` (bytes identical, so key order and the user's own `/custom/infra-kit` command survive),
  `CLAUDE.md` (hand-authored line survives the real, unmocked `syncRepoGuidance`). These are the three
  repo-scoped writers `syncPluginPointer` + guidance drive. The `~/.zshrc` managed-block writer is the
  fourth writer `init` drives and is not covered *here* — it has its own suite
  (`init-zshrc-write.test.ts`), so the criterion is met in substance; noting it only so the gap is on
  the record.

### US-005 — lanes

**PASS** on all four named lanes, numbers in the table above. The whole-package vitest run is 260
files / exit 0 — independently reproduced, not accepted. No `[FAIL]` line in the log is a test
failure (they are audit-fixture INFO lines, as reported).

`git status` shows `??` entries, but every one is either an intended new file of this commit
(`mcp-registration.ts`, `mcp-registration.test.ts`, `resolve-roots.test.ts`) or another session's
untracked work. No stray temp/scratch artefacts were left inside the repo.

## Constraint compliance

- **The peer's 3 uncommitted `specFor` lines** — **INTACT**. `doctor.ts:1404`, `:1416`, `:1422` are
  `specFor('gh').probeArgv` / `specFor('doppler').probeArgv` / `specFor('aws').probeArgv`, and the
  import is `import { specFor } from 'src/lib/dependency-registry'` at `:37` (the lead said "near :29"
  — it sits at 37 because this commit added the `FIXABLE_NAMES` import and two comment blocks above
  it; the line itself is unchanged). Unreformatted: `prettier --check` on `doctor.ts` is clean, so
  nothing reflowed them.
- **`SECTION_MEMBERS` unedited** — confirmed, 0 occurrences in the `report.ts` diff.
- **Nothing under `vendor/` touched *by this commit*** — confirmed: no vendor path is among the 13
  files. ⚠️ `vendor/packages/docs-ui/package.json` **is** dirty in the working tree from another
  session (the known `pnpm`-rewrites-the-vendor-mirror behaviour). It must not be swept into commit 1.
- **Other sessions' work untouched** — `lib/dependency-registry`, `lib/dependency-probe`,
  `lib/dependency-install`, `commands/setup-dependency-status/`, `lib/install-manager/`,
  `lib/command-catalog/`, `lib/program/program.ts`, `mcp/__tests__/mcp-stdio.e2e.test.ts` are all dirty
  in the working tree but none is among the 13 files this commit changed. Staging **must** be
  path-selective (`git add` the explicit list; never `git add -A`).
- **`sonarjs/cognitive-complexity ≤ 15`** — rule proven active at severity 2, eslint exit 0.
- **Writer never overwrites / never renames a misfiled key / never adds a second server alongside
  one** — held on every path the writer reaches through a successful read
  (`registerServer` returns `unchanged` on presence, `misfiled` on a sibling, `unparseable` on a
  hostile container). One narrow hole via the *read* path — finding B below.

## Adjudication 1 — the leaf import in `report.ts`

**CORRECT, safe, and the right call. Reverting the 3 suites was also right, and
`tool-command-checks` was NOT misclassified.**

Reproduced measurement: 22 files under `src` do `vi.mock('src/lib/infra-kit-config', …)`; **18** of
those 22 do not name `DEFAULT_DEV_PROXY_PORT` anywhere; **0** files mock
`src/lib/infra-kit-config/infra-kit-config`. Three of the 18 —
`check-ide-installed`, `check-legacy-user-global-config`, `check-user-override-path` — import
`../doctor`, which now imports `report.ts` at module scope for `FIXABLE_NAMES`. `report.ts:48` reads
`DEFAULT_DEV_PROXY_PORT` at module scope to build `PORTLESS_SERVING_NAME`. So a barrel import there
would be `undefined` in exactly those 3 suites at import time. The recorded repo lesson applies
verbatim.

Safety checks I ran rather than assumed:

- **No cycle.** `report.ts` imports `doctor.ts` with `import type` only, which is erased, so there is
  no runtime edge back. The leaf `infra-kit-config/infra-kit-config.ts` imports only `node:*`, `zod`,
  `src/lib/git-utils` and `src/lib/mcp-mode` — nothing that reaches `doctor.ts` or `report.ts`.
- **No new side effects, strictly fewer.** The barrel re-exports the leaf, so every byte the leaf
  executes was already executing; the leaf import *narrows* what `report.ts` pulls in rather than
  widening it.
- **No layering rule broken.** `eslint --print-config` on the package shows no
  `no-restricted-imports`/`import/no-internal-modules` constraint on that path, and
  `eslint --no-cache` on `report.ts` is clean.
- **No behavioural change in the suites that DO name the constant.** They mock it as `443`, which is
  the real value, so switching `report.ts` to the real one changes no assertion. `report.test.ts` and
  `report-inventory.test.ts` are both green.
- **Reverting the 3 was right** on principle, not just on taste: adding an unrelated constant to three
  suites' config mocks makes each of them assert something about a module they do not test, and the
  next module-scope constant added to `report.ts` would require a fourth, fifth… edit. The leaf import
  fixes the coupling once, at the site that caused it.
- **`tool-command-checks` is correctly kept.** Its change adds `fixable: false` to two
  `toEqual`-asserted payload rows. That is *required* by criterion 2.6 — the payload shape genuinely
  changed, and `toEqual` on the old shape would now fail. It has nothing to do with barrel mocks.

The only cost is that `DEFAULT_DEV_PROXY_PORT` is no longer mockable *for `report.ts`*. Nothing
depends on mocking it (its real value is what every mock already sets), so this is acceptable; if a
future suite needs to vary it, the fix is to pass the port in rather than to re-barrel the import.

## Adjudication 2 — the double `resolveGitRoot()`

**ACCEPTABLE. Not blocking. Do not take the signature change.**

Confirmed real, and visible in the test log: five identical
`Skipped agent-instruction files, the plugin pointer, the plugin install and .mcp.json — …` INFO lines
appear during the targeted run. In a non-git directory (and in the `$HOME` and blank cases),
`syncAgentGuidance → syncRepoGuidance → resolveInfraKitRoot → resolveGitRoot` logs it once and
`init.ts:105`'s own `resolveGitRoot()` logs it again. Two `git rev-parse --show-toplevel` shell-outs
in the same run, and in the *success* cases two shell-outs with no duplicate line at all.

Why it is not blocking:

1. Criterion 2.1's actual contract is that the reader be told all four steps were skipped. The single
   amended message discharges that alone. The duplicate is redundancy, not misinformation.
2. The message is idempotent and identical, so a reader cannot draw a wrong conclusion from seeing it
   twice — unlike, say, two *different* skip lines, which would suggest two different causes.
3. It fires only on the refusal paths, which are by definition the paths where `init` does nothing.
   The cost is one extra `git rev-parse` in a command that already spawns `claude`.
4. Test 2.1 pins `toHaveLength(2)` with a comment that states *why* it is 2 (one per gate that
   refused). That is honest pinning of current behaviour, not a disguised assertion that 2 is
   desirable — and it is what makes a later fix a visible, deliberate test edit.

If it is fixed later, **do not** thread a resolved root into `syncAgentGuidance` / change
`syncAgentGuidance`'s signature. That inverts the invariant's direction: the guidance writers would
then run against a root the *guidance* gate never verified, and `resolveInfraKitRoot`'s `existsSync`
would be checking a root handed to it by a caller rather than one it resolved. The cheap, local fix is
to memoise inside `agent-files.ts` — one module-scope `let` holding the resolved value (and the fact
that the skip was already logged), so both call sites share one shell-out and one line, with the
resolvers' signatures and the one-root invariant untouched. Test 2.1's `toHaveLength(2)` becomes
`toHaveLength(1)` at that point, deliberately.

## Adjudication 3 — the four criteria most at risk of passing nominally

**2.9 — PASS, and the green is provably caused by the mock, not by the live repo.**
Proof by contradiction, from the file itself: the suite's `zx` mock
(`report-inventory.test.ts:178-184`) returns `{ stdout: '' }` for every `$` call. `agent-files.ts`
imports `getProjectRoot` from the **barrel** `src/lib/git-utils`, which is exactly what the new mock
intercepts. Remove that mock and `getProjectRoot` falls through to the real implementation over the
blank-stdout `zx` mock → `''` → `resolveGitRoot` **refuses** → the `MCP server key` row is omitted →
the 30-name reconciliation **fails**. So the row can only be present because the mock supplied a
usable root. It supplies `ensureFixture()`, an absolute `mkdtempSync` path, so no cwd-relative read is
possible even in principle.
Independently, the suite carries its own cwd-independence guard: `ensureGitOnlyFixture()` writes
`'not json at all'` to the fixture's `.mcp.json`, and the second gate test asserts the row's message
contains `'Could not read mcpServers'`. That verdict is a fingerprint — the vitest cwd (the package
dir) has no `.mcp.json` and would read `missing-file`, and the repository root's own `.mcp.json` is
valid and would read `ok`. Neither can produce `unparseable`. A cwd-relative regression fails loudly.
Constraint honoured: the `zx` mock was **not** made command-aware.

**2.4 — PASS, exercises the `$HOME` branch.** `init-plugin-pointer.test.ts:313-332` stubs
`getProjectRoot` with `home` (a real `mkdtemp` absolute path) and `os.homedir()` with the same value,
then *asserts the stub itself* before calling `init`: `expect(stubbed).toBe(os.homedir())` and
`expect(stubbed).not.toBe('')`. The blank branch therefore cannot be the one that refused. The
resolver-level twin (`resolve-roots.test.ts:89-95`) does the same. The blank case is kept as its own
test (2.8) in both suites, so the two branches can never collapse into one.

**1.7 — PASS, and it does not reduce to `kind === 'ok'`.** `mcp-registration.test.ts:336-373`.
Assertion 1 (`:337`) deep-equals the written value against
`{ type: 'stdio', command: 'infra-kit', args: ['mcp'] }` — this is the assertion `kind === 'ok'`
cannot make, and it fails on `{"infra-kit": null}`. Assertion 2 (`:348`) is stronger than the PRD
asked: instead of calling the private `looksLikeInfraKitServer` directly, it writes the writer's *own*
value under `ik` in a second tmpdir and asserts `inspectMcpRegistration` returns
`{ kind: 'wrong-key', key: 'ik' }`. I verified at `install-state.ts:234-238` that `wrong-key` is only
reachable through `looksLikeInfraKitServer(servers[key])` — so the predicate is exercised through its
real caller, which is a better test than a direct call. Assertion 3 (`:363`) pins never-add-alongside.
`kind === 'ok'` appears once, as a corroborating third line in assertion 1, never as the assertion.

**1.3 — PASS.** `TAB_INDENTED` (`:80`) has only `linear-server`; `:219` asserts the `infra-kit` key is
absent from the fixture *before* the call, so `detectIndent` is provably entered. `:224`'s
`not.toContain('\n  "')` catches a whole-file reindent.

**2.7 — PASS per writer**, three writers each with their own test; the `~/.zshrc` writer is covered by
its own suite rather than here (noted, not held against it).

## Findings nobody asked about

**A. The lead's file list is 12; the commit is 13 files.**
`apps/infra-kit/cli/src/commands/init/__tests__/init-zshrc-write.test.ts` (+6 lines) is part of this
change and was omitted from the brief. It adds `resolveGitRoot: vi.fn(async () => null)` to that
suite's `../agent-files` module mock — a full module mock that would otherwise return `undefined` for
the new export and crash `init.ts:105`. The change is correct, well commented, and necessary; it just
needs to be in the commit. Verified green above.

**B. `readMcpFile` conflates "absent" with "unreadable", which can overwrite a consumer's file.**
`mcp-registration.ts:91-97` returns `null` for *any* read error, and `ensureMcpRegistration:233` maps
`null` to `createMcpFile`, which writes a file containing only our server. For a `.mcp.json` that is
unreadable but writable — mode `0o200`, or an ACL/ownership split — the read fails and the write
succeeds, so a consumer's `linear-server` entry is destroyed. I confirmed the mechanism empirically in
a tmpdir: mode `0o200` gives `readErr=EACCES, writeSucceeded=true`.
This is the one case that breaks the "never overwrite" invariant. It is narrow (write-only regular
files are rare) and strictly better than HEAD, which had no writer at all — so **not blocking** — but
it is a one-line fix worth folding in: distinguish `ENOENT` from everything else in `readMcpFile`
(`if (error.code === 'ENOENT') return null`), and route any other read error to `writeFileOrWarn`'s
warn + `failed` outcome instead of to `createMcpFile`. The `.mcp.json`-is-a-directory case (`EISDIR`)
survives today only because the subsequent write also fails; that is luck, not design, and the same
fix makes it intentional.

**C. Two `git rev-parse` shell-outs on the doctor path too.** `doctor.ts:1480-1481` calls
`resolveCheckedRepoRoot()` and `resolveGitRoot()` back to back, and both shell out. Correct (they are
different predicates and both roots are needed) but the same memoisation suggested in adjudication 2
would collapse them. Not a criterion, no action needed.

**D. `looksLikeInfraKitServer` is a substring match** (`install-state.ts:199-206`:
`` `${command} ${args}`.includes('infra-kit') ``). Pre-existing, not this commit's, but it means the
writer's misfiled-key refusal will also fire for an unrelated server whose command merely happens to
contain the string `infra-kit` — the refusal is safe (it never writes) but the warn text would name
the wrong thing. Out of scope for commit 1; worth a note for whoever owns the reader.

**E. Staging hazard.** The working tree carries at least four other sessions' uncommitted work plus a
dirty `vendor/packages/docs-ui/package.json`. `git add -A` would ship all of it. Stage the 13 paths
explicitly.

**F. `writeAgentFiles` has no in-`src` caller.** `grep -rn` across `src` (tests excluded) finds it only
at its definition and at the `src/commands/init/index.ts:6` re-export. Not this commit's doing and not
a defect — but it is load-bearing for Adjudication 4's fix, because it means `resolveInfraKitRoot`'s
only live path is `syncRepoGuidance`, whose only caller is `init.ts:254`.

## Adjudication 4 — `doctor` prints `init`'s skip line

**BLOCKING. Fix before commit.**

Reproduced independently against `dist/chunk-FFJUQVXQ.js` (the entry `dist/cli.js` is a thin minified
loader and does **not** contain the string; the chunk does — worth knowing for anyone re-running this
repro). In a non-git tmp dir, `node apps/infra-kit/cli/dist/cli.js doctor`:

- stderr line 1 is `INFO: Skipped agent-instruction files, the plugin pointer, the plugin install and .mcp.json — no usable git repo root here (…)`, exactly once, above the `infra-kit doctor` report header;
- the `MCP server key` row is correctly omitted (0 occurrences);
- `DOCTOR_EXIT=1`, as expected from `plugin installed`.

Confirmed a **regression introduced by this commit**, not pre-existing: HEAD's `doctor.ts` imports only
`AGENTS_MARKER_END` / `AGENTS_MARKER_START` from `agent-files` (line 10) — no resolver — and contains
zero `logger.info` calls. So HEAD's `doctor` says nothing in a non-git directory. The new
`doctor.ts:1481` `await resolveGitRoot()` is the whole cause.

### Why blocking

No acceptance criterion forbids it, and that is not the test. Three things make it more than cosmetic:

1. **It is a false statement, printed first, by a read-only command.** `doctor` skipped nothing and
   intended to write nothing. A user's most likely reading of "Skipped … the plugin install and
   .mcp.json" above a health report is that `doctor` tried to repair something and could not — which is
   precisely the wrong conclusion to hand someone who ran the diagnostic *because* they are already
   unsure what state their setup is in.
2. **The affected population is not marginal.** It fires in any non-git directory **and** in `$HOME`.
   Running `doctor` from `~` is an ordinary thing to do — arguably the most ordinary thing, for someone
   whose complaint is "the CLI doesn't work anywhere".
3. **It is invisible to the checks that were run.** `--json` silences the logger, so the JSON-path
   assertions and the whole vitest suite (which mocks `logger`) pass. Only the human path is affected,
   and only an end-to-end run against the bundle surfaces it. A defect class that the entire test suite
   is structurally blind to should not be waved through on the argument that the suite is green.

Against that, the only mitigations are that the row is correctly omitted, the exit code is unaffected,
and `--json` stays pure. Those establish that nothing is functionally broken; they do not excuse the
line. The fix is small and local, which removes the last reason to defer it.

### Which fix — (c), implemented as a decorator, not as a second predicate

Adopt **(c)**, but built so it cannot drift: make the shared predicate **silent** and give the
announcement its own thin wrapper in the same file.

```ts
// The shared predicate. SILENT: it answers a question, it does not narrate a decision.
// `doctor` imports THIS, by name — the same function the writer's gate is built from.
export const resolveGitRoot = async (): Promise<string | null> => { /* … no logger … */ }

// `init`'s variant. The announcement lives here because `init` is the only caller for whom the
// skip is otherwise invisible: the steps it gates write nothing and print nothing when they do
// not run, so this line is the only evidence they did not.
export const resolveGitRootForWrites = async (): Promise<string | null> => {
  const root = await resolveGitRoot()

  if (root === null) logger.info(SKIPPED_GIT_ROOT_STEPS)

  return root
}
```

Wiring: `init.ts:105` calls `resolveGitRootForWrites`. `resolveInfraKitRoot` calls the **silent**
`resolveGitRoot` and returns `null` without a line when the git gate refuses — it keeps logging
`SKIPPED_GUIDANCE_ONLY` for its own `infra-kit.json` predicate, which no other reader consults.
`doctor.ts:1481` is **unchanged, byte for byte**.

Why this and not the alternatives:

- **Not (b), the `quiet` flag.** A boolean on a primitive defaults to loud, so the next reader who
  needs the predicate forgets to pass it and the bug comes back silently. The decorator's default is
  the predicate: a new reader gets silence, and only a writer opts *into* announcing. That is the safe
  direction for a default to fail in.
- **Not (a), reason-returning + `init` logs.** Nearly the same idea, strictly worse in two ways. It
  needs a discriminated-union return that ripples into `doctor.ts:1481` — churn in exactly the lines
  already under review. And `resolveInfraKitRoot` still has to announce the same git refusal for its
  own path, so `SKIPPED_GIT_ROOT_STEPS` acquires two consumers in two files, and a future third reader
  of the reason has to rebuild the sentence. The decorator keeps predicate, message and emit site in
  one file with one emit.
- **(c) does not incur the drift the plan warned about.** The plan's principle was that the reader must
  not *re-derive* the writer's predicate. Nothing is re-derived here: `doctor` calls the identical
  exported function. What is separated is *announcement*, which was never part of the predicate. The
  hazard the plan named — two copies of a rule that can disagree — is not created.

### What `init`'s test must assert so criterion 2.1 still means something

`init-plugin-pointer.test.ts:261`'s `expect(skips).toHaveLength(2)` becomes **`toHaveLength(1)`**, and
the exactness is the load-bearing half: `1` forbids both the duplicate and the fail-open (`0`) that
US-001 exists to prevent, so no extra assertion is needed to stop "make it silent everywhere". Keep
both content assertions on that one line — it must still name `agent-instruction files` **and**
`the plugin pointer, the plugin install and .mcp.json`, which is what makes "the reader was told all
four steps were skipped" true from a single line. Update the comment above it, which currently explains
why 2 is expected.

Two further test changes the fix must carry:

1. **A doctor-side regression guard, and this one is not optional.** `report-inventory.test.ts`'s
   `gitTopLevel = ''` case should also assert that `doctor()` emitted **no** `logger.info` matching the
   four-step skip. Without it nothing stops someone moving the log back into the shared predicate. It
   is also the test that must **fail on today's code** — require that demonstration before accepting
   the fix.
2. **`resolve-roots.test.ts` repointed.** Its five `linesMatching(GIT_ROOT_SKIP)).toHaveLength(1)`
   assertions move to `resolveGitRootForWrites`, and the existing tests of `resolveGitRoot` gain the
   mirror assertion that it logs **nothing** on every null path. US-001's fifth criterion (blank → null,
   `$HOME` → null) is unaffected; only the announcement moves.

### Effect on open finding 2 — ruled together, not separately

**Yes, this changes the ruling, and the two should be fixed as one change.** They are the same defect:
a predicate that logs. My earlier ruling — the duplicate is acceptable, memoise it later if you care —
stands on its own merits, but it is now moot, because the fix above **closes both** with no extra work.
With `resolveInfraKitRoot` on the silent predicate and `init.ts:105` on the announcing wrapper, a
non-git `init` run emits the four-step skip exactly **once**: the guidance path returns silently, and
`init`'s own call announces. The memoisation I recommended in Adjudication 2 is no longer needed and
should **not** be added — it would put mutable module state in a process that also hosts the
long-lived MCP server, to solve a problem this fix removes.

The one thing the fix does not collapse is the two `git rev-parse` shell-outs (Adjudication 2's other
half, and finding C). Leave them. They are two honest resolutions by two gates, they cost nothing
measurable next to `init`'s `claude` spawn, and the alternative is the module-scope memo just argued
against.

### Scope of the re-review this fix needs

Small and bounded: `agent-files.ts` (the split), `init.ts:105` (one call site), and three test files
(`resolve-roots`, `init-plugin-pointer`, `report-inventory`). `doctor.ts` should not change at all — if
a diff appears there, something has gone wrong with the approach. Re-run the four named lanes plus the
non-git `dist/cli.js doctor` repro, which is the only check that actually proves the defect gone.

---

# Re-review — the blocking fix

**Verdict: APPROVED.**

## The shape, as built

`agent-files.ts` now carries three resolvers. `resolveGitRoot` is silent: same three `null`
conditions (a thrown resolve, `''` after `.trim()`, `=== os.homedir()`), same trimmed return, both
`logger.info` calls gone, and a JSDoc that records *why* silence is load-bearing rather than merely
stating it. `resolveGitRootForWrites` is the four-line decorator. `resolveInfraKitRoot` calls the
silent predicate, keeps `SKIPPED_GUIDANCE_ONLY` for its own predicate, and returns `null` without a
line when the git gate refuses — its comment names the duplicate that shape exists to prevent.
`init.ts:23` imports the wrapper, `init.ts:108` calls it. No memoisation. Both `git rev-parse`
shell-outs left in place, as agreed.

**`doctor.ts` and `report.ts` are byte-unchanged**, independently confirmed: `doctor.ts` mtime is
`00:49:12` (`report.ts` `00:58:43`), both older than the fix window, and `git diff HEAD` on `doctor.ts`
still shows only the commit-1 hunks already passed — its call site is `await resolveGitRoot()`, the
silent predicate, exactly as specified. This was the check I said would reveal a wrong approach; it
reveals the right one.

The scope is one file wider than I named, and the lead is right about why:
`init-zshrc-write.test.ts`'s `vi.mock('../agent-files')` stubbed `resolveGitRoot`, which `init` no
longer imports, so the stub had to be renamed to `resolveGitRootForWrites` or `init` would have called
`undefined()`. That is the same full-module-mock hazard as the 13th-file finding, one turn later.

## Lanes, re-run

`tsc` EXIT=0. `prettier --check` (8 changed files) EXIT=0. `eslint --no-cache` (same 8) EXIT=0 with
exactly the one pre-existing `init.ts:37` `@ik/max-jsdoc-summary-lines` warning — the count is back to
its baseline of 1, so the executor's new JSDoc is genuinely clean rather than masked. Whole-package
`vitest run`: **261 files passed, EXIT=0**.

`pnpm run build` EXIT=0, and the four-step string now lives in `dist/chunk-L26WOMN7.js` (the chunk hash
moved, which is itself evidence the bundle is the new one and not the 00:57 artefact).

## The defect is gone, both halves, verified here

**`doctor`** — non-git tmpdir, `node dist/cli.js doctor` against the bundle I built in this pass:
**0** occurrences of the skip line in stderr *and* stdout, first stderr line is the report header
`infra-kit doctor`, `MCP server key` row still correctly omitted (0 occurrences), exit 1.

**`init`** — the half the lead deliberately left unverified, to avoid repeated writes to the real
`~/.zshrc`. That concern is avoidable: redirect `HOME`. From a non-git tmpdir,
`HOME=<tmp>/fakehome node dist/cli.js init` gives the four-step skip **exactly 1** occurrence,
`SKIPPED_GUIDANCE_ONLY` **0** (correct — the git gate refused first, so the guidance-only line must
not fire), `INIT_EXIT=0`, the cwd left completely empty, and the 12 infra-kit lines landing in the
*fake* home's `.zshrc`, with the real `$HOME` untouched. So the duplicate is closed end-to-end, not
merely in the unit tests, and this half is no longer reported-not-verified.

## The three specific questions

**1. All three `toHaveLength` sites are `1`, and no content assertion was lost.** Confirmed by reading
each body, not by counting greps:

- **2.1** (`:260`) — `toHaveLength(1)`, and **both** content assertions survive on `skips[0]`:
  `'agent-instruction files'` and `'the plugin pointer, the plugin install and .mcp.json'`. Plus the
  two `existsSync` negatives. The comment above it was rewritten to explain why `1` is the load-bearing
  number (it forbids the duplicate *and* the fail-open), so the next reader cannot mistake it for a
  number that was merely made to match.
- **2.4** (`:314`) — `toHaveLength(1)`, and the branch-discrimination evidence survives intact: it
  still awaits the stub and asserts `toBe(os.homedir())` and `not.toBe('')` *before* calling `init`,
  which is what keeps this test on the `$HOME` branch rather than the blank one. All four
  `existsSync` negatives (both in `$HOME` and in the repo) survive.
- **2.8** (`:334`) — `toHaveLength(1)`, and the strongest assertion in the suite survives: the
  `process.chdir` into a fresh empty tmpdir with `expect(fs.readdirSync(elsewhere)).toEqual([])`,
  restored in `finally`.

Net effect on strength: each is strictly stronger than before, because `2` was satisfiable by a
duplicate *and* by any pairing that summed to two, whereas `1` pins the exact contract. Nothing was
traded away for the number. Separately, 2.3 still asserts `GIT_ROOT_SKIP` `toHaveLength(0)` alongside
`GUIDANCE_ONLY_SKIP` `toHaveLength(1)` — the case that proves the *guidance* line still fires where it
should, which is the assertion that stops "fix the noise by deleting all the logging".

**2. The spy cannot leak, and the method change is right.** `report-inventory.test.ts:194` is a
module-scope `vi.spyOn(logger, 'info').mockImplementation(() => {})`, and the existing `afterEach`
(`:209`) calls **`infoSpy.mockClear()`** — calls cleared, spy and implementation both retained. That is
the correct one of the three: `mockReset()` would drop the `mockImplementation` and let real log lines
through, and `mockRestore()` would detach the spy entirely, after which `infoSpy.mock.calls` stays
empty forever and the `toHaveLength(0)` assertion would pass vacuously — precisely the failure mode
raised. Neither appears anywhere in the file (`grep` for `restoreAllMocks|mockRestore|mockReset`
returns nothing), and `vitest.config.ts` sets no global `restoreMocks`/`clearMocks`/`mockReset`, so the
defaults (all `false`) apply and nothing detaches it between tests. The reason for preferring a spy
over `vi.mock` is also correct and is the same trap as the `report.ts` leaf import: `src/lib/logger`
also exports `LOG_FILE_PATH`, which other modules in `doctor`'s graph read, and a partial module
factory would blank it.

**3. The silence mirrors have teeth — by construction and by demonstration.** Three independent
arguments:

- **Same object.** `resolve-roots.test.ts` replaces `src/lib/logger` with a factory whose `logger.info`
  is a `vi.fn()`, and `agent-files.ts` calls `logger.info(...)` as a property access on that same
  mocked singleton — it never destructures or rebinds it. So a restored log call is necessarily
  recorded.
- **An internal control, which is what actually rules out "attached to the wrong object".** The very
  same `infoLines()` helper reads **non-empty** in the sibling `describe` for
  `resolveGitRootForWrites` (`:131`, `:138`, `:145`, `:152` each assert `toHaveLength(1)`), and
  non-empty again for `SKIPPED_GUIDANCE_ONLY` (`:170`). A helper that read empty always could not
  produce those passes. This is the strongest form of the argument: the file proves its own instrument
  works in the same run in which it asserts silence.
- **The mirrors are total, not pattern-scoped.** The five predicate tests assert
  `expect(infoLines()).toHaveLength(0)` — *nothing at all* was logged, not merely nothing matching
  `GIT_ROOT_SKIP`. Restoring the logging under any wording fails them.

Empirically, the lead's step-1 demonstration settles the doctor-side guard the same way: on pre-fix
code `report-inventory.test.ts:308` fails with `expected [ Array(1) ] to have a length of +0 but got 1`,
which is a test that fails on the defect and passes on the fix — the only ordering that proves an
assertion is not merely agreeing with the implementation it was written against.

## The `readMcpFile` narrowing (taken from finding B)

Not in my brief but worth recording as verified. `readMcpFile` now returns a three-state
`McpFileRead` (`absent` | `raw` | `unreadable`) and only `ENOENT` maps to `absent`; every other read
error warns once with the path and returns `status: 'failed'`, leaving the bytes alone
(`mcp-registration.ts:103-111`, call site `:243-255`). The new test (`:393`) is built the right way
round: it writes `BOTH_SERVERS`, chmods `0o200`, then **asserts the read genuinely throws before
calling the subject** — so running as root, or on a mode-ignoring filesystem, fails loudly instead of
passing vacuously. Then `status: 'failed'`, bytes `=== BOTH_SERVERS`, exactly one warn. Writer suite
17 → 18.

One incidental consequence, benign and worth knowing: the `.mcp.json`-is-a-directory case (1.8) now
refuses at the *read* (EISDIR → `unreadable`) rather than surviving because the subsequent write also
failed. Same single warn, same `failed` status, so the existing 1.8 tests are unaffected — but the
behaviour is now intentional rather than lucky, which is the improvement I asked for in finding B.

## Nothing left open

Findings A (13th file — now 14 files with `init-zshrc-write` counted once), B (`readMcpFile`), and the
Adjudication 4 defect are all closed. C (two `git rev-parse` shell-outs) and D
(`looksLikeInfraKitServer`'s substring match) were explicitly ruled no-action and remain so. E
(staging hazard) is procedural and still applies at commit time: stage the explicit path list, never
`git add -A`, because the tree still carries other sessions' work and a dirty
`vendor/packages/docs-ui/package.json`.

---

# Re-review addendum — the cwd-dependent 2.2

**Verdict unchanged: APPROVED.**

## 1. The new 2.2 is sound

Mechanism confirmed rather than accepted: the repository root does carry a **tracked** `.mcp.json`
(`git ls-files --error-unmatch .mcp.json` succeeds), so the old
`expect(fs.existsSync(path.resolve('.mcp.json'))).toBe(false)` was pointed at a real committed file
whenever vitest was launched from the root. The diagnosis is exactly right, and it is criterion 2.9's
own standard violated inside the assertion whose job was to prove cwd-independence.

Re-run in both directions myself:

- package dir → `init-plugin-pointer.test.ts` 1 file passed, `EXIT=0`
- repo root, `--root apps/infra-kit/cli` → 1 file passed, `EXIT=0`
- repo root, whole scoped set (`init/__tests__/ doctor/__tests__/ plugin-pointer/__tests__/`) →
  **29 files passed, `EXIT=0`**

Owning the cwd inside a test that also asserts against a fixture root introduces nothing, and the
reason is worth stating because it is what makes the ordering safe: every fixture-root assertion is
built on an **absolute** path (`mcpPath()` is `path.join(repo, '.mcp.json')`, `readMcp()` reads that),
so those assertions are cwd-invariant. Moving them after the `finally` is tidiness, not correctness —
they would have held inside the `try` too. The surrounding stubs close the other doors: `getProjectRoot`
is mocked to `repo`, so the chdir cannot change what `init` resolves; `os.homedir()` is mocked to
`home`, so the `.zshrc` write lands there and not in `elsewhere`; and `INFRA_KIT_NO_SEED=1` keeps
layer-3 seeding from writing. The `finally` restore matters more than it looks — a leaked chdir would
poison every later test in the file, which is the sibling bug of the one just fixed.

One observation the lead undersold: the new form is a **stronger** claim than 2.8's, not merely the
same pattern. 2.8 runs with a refused gate, where nothing should be written anywhere; 2.2 runs a
**successful** `init` with all three writers active and still asserts the cwd is untouched. That is the
assertion the criterion actually wanted, and the old form never made it.

## 2. A standing guard is worth it — as a second-launch-dir lane, not a lint rule. Follow-up, not commit 1.

**Not commit-1 scope.** This commit's set is clean and now verified from two launch directories; a
guard is a new mechanism with its own design and review, and it would immediately redden things that
are not this commit's (see below).

**Worth doing**, and the reason is stronger than "it survived two passes": the defect class has now
bitten **twice in one session, in two different files**, and I pinned the second one while checking the
lead's baseline claim — see the next section.

**The form matters.** Of the three candidates:

- **A lint rule: no.** The distinguishing feature of the bug is *reading* the ambient cwd, but the
  legitimate save-and-restore idiom this very fix uses also mentions `process.cwd()`. A rule that bans
  the read cannot tell the two apart without modelling intent, so it buys false positives on correct
  code and trains people to disable it. `path.resolve(` with a relative first argument is a narrower and
  more defensible target, but it is only one of the ways to read the cwd, so it is a partial guard sold
  as a complete one.
- **A `vitest.setup.ts` assertion that `process.cwd()` is unchanged after each test: cheap, worth
  adding, wrong bug.** It catches a *leaked* chdir — a test that moves the cwd without a `finally` and
  silently poisons every test after it. That is a real hazard and this suite now has two chdir sites,
  so I would take it. But it does not catch 2.2's bug at all: 2.2 never changed the cwd, it read it.
- **Running the suite from a second launch directory: yes, this is the guard.** It is the only one that
  catches "the verdict is a fact about the launcher" *by construction*, because a defect of that class
  is by definition invisible from a single cwd. Concretely: one extra lane that does
  `pnpm exec vitest run --root apps/infra-kit/cli` from the repo root. It would have caught both
  instances.

**Sequencing, if it is taken:** that lane goes red on day one, on `portless-driver.test.ts` (below), so
the follow-up has to fix or quarantine that test before the lane can be a gate rather than a nuisance.

## 3. Baseline correction — `portless-driver` is NOT a red baseline

The peer's report is real but its conclusion is wrong, and the cause is the same defect class as 2.2.
Measured:

- `src/dev/proxy/__tests__/portless-driver.test.ts` alone, **from the package dir** → 1 file passed,
  `EXIT=0`
- the same file alone, **from the repo root** via `--root apps/infra-kit/cli` → `EXIT=1`,
  `× produces a string a real shell actually executes`, `Error: portless should not be run via npx or pnpm dlx.`

So the discriminator is the **launch directory**. I also tested the `npm_command` hypothesis the repo's
own notes would suggest for that error string — forcing `npm_command=run-script` from the repo root
still fails, so `npm_*` is *not* what flips it here; the cwd is. (Presumably portless resolves a
different binary out of the root `node_modules` than out of the package's.)

This matters for what the lead carries forward: `turbo run test` runs each package's `test` script **in
that package's directory** (`cli`'s script is `pnpm exec vitest run --reporter=minimal`, root's is
`turbo run test --continue`), so CI and `pnpm run qa` take the passing path. My own two whole-package
runs (260 then 261 files) were both `EXIT=0` for the same reason. **The tree baseline is green**; the
peer's red is an artefact of launching vitest from the repo root, which no ordinary invocation does.

Note this is the *third* independent instance in this session of a test whose verdict was a fact about
its environment — the executor's original `report-inventory` cwd risk (caught by the plan), the lead's
2.2 (caught by a peer), and this pre-existing portless test (caught here). That is the evidence base for
the guard in section 2.
