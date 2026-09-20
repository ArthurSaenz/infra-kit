# `[DO]` release create: a per-release release date · `release desc-edit` → `release edit`

**Status:** pending approval · ralplan `--deliberate` · 2026-09-20 · rev 3 · Architect + Critic passes applied (rev 1 ITERATE → rev 2 conditional APPROVE; the four rev-3 conditions folded in, design unchanged)

Two user-facing changes to the CLI in `apps/infra-kit/cli`:

1. `release create` accepts an optional **release date** per release — the day the release is planned to reach production. It is the Jira fix version's `releaseDate` (`POST`/`PUT /rest/api/3/version`, ISO `yyyy-mm-dd`). Driving case: a PM tells an agent "create release 1.64.0 with release date 28 October" and the agent runs the CLI.
2. `release desc-edit` becomes `release edit` and edits the description **and/or** the release date.

---

## 0. Where the feature is today

| Piece                                           | State                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations/jira/types.ts`                    | `CreateJiraVersionParams.releaseDate?` and `UpdateJiraVersionParams.releaseDate?` already declared; `JiraVersion.releaseDate?` already read. `types.ts:35` carries a false JSDoc ("Defaults to current date if not provided") — nothing defaults it.                                                                          |
| `integrations/jira/api.ts` `createJiraVersion`  | Builds the POST body from `name, projectId, description, released, archived` — **drops `params.releaseDate`**.                                                                                                                                                                                                                |
| `integrations/jira/api.ts` `updateJiraVersion`  | Already forwards `releaseDate` when `!== undefined`. How Jira Cloud _clears_ a date on PUT is unverified (`null` per most reports; some say `""`).                                                                                                                                                                            |
| `integrations/jira/api.ts` `deliverJiraRelease` | `api.ts:218-224` sets `released: true, releaseDate: today` — delivery overwrites the planned date with the actual one.                                                                                                                                                                                                        |
| `lib/version-utils/next-version.ts`             | `--release` grammar `<token>[:type[:description]]`; `parseReleaseSpec` ⇄ `formatReleaseSpec` are inverses and the `rerun` argv is built from `formatReleaseSpec`, so **every per-entry field must round-trip through the spec string**. `formatReleaseSpec` is _minimal_.                                                     |
| `lib/release-form/release-form.ts`              | Agent-mode form: `type`, `release`, `description`. House rule at `:103-106`: no measured wire shape on form fields (no `.min`/`.regex`); blanks are `toArgs`'s job. A bad name is refused on round 2 by the tool, not by the form (`:140-142`).                                                                               |
| `commands/release-create/release-create.ts`     | Wizard asks kind → type → token → description; `formatReleaseSummary` renders `label · type · description`; `releaseCreateMcpTool` schema `{ version?, name?, type, description? }`; headless-without-arguments refusal precedent at `:252-260`.                                                                              |
| `lib/release-utils/release-utils.ts`            | `ensureJiraVersion` is idempotent and writes a differing non-empty description through; `getJiraDescriptions()` (`:205-231`) is a name → description map, returns an **empty map** when Jira config is absent and **warns + returns what it has** when the fetch throws.                                                      |
| `commands/release-desc-edit/`                   | `releaseDescEdit({ version?, description?, confirmedCommand })`; tool `release-desc-edit` with both args required; sits in `LOW_RISK_MUTATING_ALLOWLIST` (`command-catalog.ts:566`), no `requiresHumanConfirm`; 6 tests across two files; the confirm-refusal test fully mocks the `src/integrations/jira` barrel (`:13-22`). |
| `desc-edit` references outside `docs/`          | 47 lines in 22 files (full list in §3.6) — source, tests, one snapshot, the esbuild-inlined guidance `resources/root/body.md`, the generated block in root `CLAUDE.md`, `apps/infra-kit/cli/readme.md`, `plugins/infra-kit/README.md`, and a comment in `jira/api.ts:52`.                                                     |

---

## 1. RALPLAN-DR

### Principles

1. **One spec string carries the whole release.** Whatever the wizard or the form collects per release must survive `formatReleaseSpec` → `--release <spec>` → `parseReleaseSpec`, or the `--yes` re-run silently loses it.
2. **Jira is the single source of truth for the date.** The PR body keeps its canonical `<jiraUrl>\n\n<description>` shape; `release list` reads the date from Jira. No second copy to drift.
3. **One validator, one wire-format owner.** ISO-date validation lives in one module and is called from the parser, the Commander option, the wizard, and the tool schemas. Whatever Jira needs to _clear_ a date lives only in `updateJiraVersion`; callers express intent (`null`).
4. **Rename is a pure move, then a sweep.** No `.alias('desc-edit')`, no re-export shim (a shim defeats `git diff -M` rename detection — see memory `git-mv-plus-shim-defeats-rename-detection`). Pre-1.0, the global CLI and the plugin ship in lockstep and guidance blocks are regenerated.
5. **Additive output only.** Every structured field that exists today keeps its name and shape; new fields are added with `null` when absent, so agents that already parse `release create` / `release list` / `release desc-edit` output keep working.

### Decision drivers (top 3)

1. **Agent re-run parity** — the preview/`--yes` protocol is the product; a per-entry field that the echo cannot reproduce is a bug, not a feature.
2. **Blast radius of the rename** — 22 files including a snapshot, a generated `CLAUDE.md` block, a doctor allowlist test, and consumer-facing README/skill text. A missed reference shows up as `ik audit` drift in consumer repos or a red doctor check.
3. **Jira semantics we do not control** — clear-on-PUT payload and the delivery overwrite are facts to encode, not choices to make.

### Options

**D1 — how the date rides in `--release <spec>`**

| Option                                                                                                                                                                                          | Pros                                                                                                                                                                                                                                                                                                                                                                                                                                | Cons                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A′ (recommended)** — date attached to the token: `<token>[@yyyy-mm-dd][:type[:description]]`, e.g. `1.64.0@2026-10-28`, `next@2026-10-28`, `checkout-redesign@2026-10-28:hotfix:Fix the cart` | **Collision-free by construction**: `@` is legal in neither a semver token, `next`, nor a kebab-case name, so the first segment splits unambiguously and the description grammar ("everything after the second colon") is untouched. Shortest form for the common case (`1.64.0@2026-10-28` — no `:regular:` filler needed to reach the date). Parser change is local to the token segment; `formatReleaseSpec` inverse is trivial. | New punctuation to document in the skill and `-r` help. Reads slightly less "column-like" than colon-positional. **Constraint it creates:** `@` must stay disallowed in every future token grammar (`validateName`, `VERSION_RE`) — record it in `parseReleaseSpec`'s JSDoc.               |
| **A** (lead's proposal) — positional third segment sniffed by shape: `<token>[:type[:date][:description]]`                                                                                      | Only colons; reads as a table.                                                                                                                                                                                                                                                                                                                                                                                                      | One documented collision (a description that _starts_ with `yyyy-mm-dd` is eaten as the date — must be escaped by prefixing a space or a word). Reaching the date on a regular release forces `token:regular:date`. Parser needs a lookahead on segment 3; two grammars for the same slot. |
| **B** — batch-wide `--release-date <yyyy-mm-dd>` flag on `release create`                                                                                                                       | Trivial to type and parse.                                                                                                                                                                                                                                                                                                                                                                                                          | **Invalidated by driver 1**: the wizard collects per entry, but a batch flag cannot echo per-entry dates, so the wizard would have to ask once per batch — inconsistent with the per-entry description and wrong for mixed batches (a hotfix today + a regular next month).                |

Recommendation: **A′**. The rest of this plan is identical under A; only §3.3's parser and the skill text change. Open question Q1.

**D4 — rename strategy**

| Option                                         | Pros                                                                                                | Cons                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hard rename, no alias (recommended)**        | One name everywhere; guidance/catalog/palette/doctor allowlist all agree; sweep is grep-verifiable. | Any consumer on an older plugin skill text gets "unknown command" for one release — mitigated by lockstep publish + `ik audit --fix` regenerating consumer blocks. |
| Rename + `.alias('desc-edit')` for one release | Old muscle memory keeps working.                                                                    | The catalog, palette, allowlist, guidance and rerun-argv fixtures would need to know both names or the alias is a lie for agents; a second cleanup commit later.   |

Recommendation: hard rename. Open question Q3.

**D5 — `release edit` field semantics (decided, not optioned)**: flags `-v/--version`, `-d/--description` (`""` clears), `--release-date <yyyy-mm-dd>` (`""` clears). Any field flag present → non-interactive for fields, only given fields change. No field flag on a TTY → prompt both (Enter keeps current; interactive cannot clear — same as today). **Headless with no field → refused before any prompt** by a handler-level `StructuredRefusalError` (`argument_required`, `argument: 'description'`, keeps the existing test contract) whose remediation names both flags: "pass --description and/or --release-date on the re-run" — `withEscape`'s `{ refuse }` remediation is fixed at `escapable-context.ts:71-76` and can only name one flag, so the prompt sites cannot carry this message. Nothing changed → `changed: false` short-circuit before the confirm gate. Confirm text lists only the changed fields as `from → to`. Jira PUT carries only changed fields; `updateReleasePRBody` runs only when the description changed.

**D2 / D3 / D6 / D7 / D8** — taken as stated in §3; each is an open question only where marked.

---

## 2. Scope

**In:** the validator module; `createJiraVersion` body; `updateJiraVersion` clear intent; spec grammar + form + tool schema + wizard + summary/echo + `ensureJiraVersion` write-through + result field; the rename (move + sweep); `release edit` behaviour; `release list` date column; skill/README/guidance/snapshot; full `pnpm run qa`.

**Out (follow-ups, §7):** the lockstep `[DO] release` publish, `plugin.json` version alignment, `pnpm add -g infra-kit@<exact>`, consumer `.claude/` rsync from starter, historical `docs/*-plan.md` mentions of `desc-edit` (left as history).

---

## 3. Changes (all under `apps/infra-kit/cli` unless noted)

Commit plan — four `[DO]` commits straight to `main`, in this order (memory: no branches/PRs in infra-kit):

- C1 `[DO] release create: per-release date (-r token@yyyy-mm-dd), written to the Jira fix version` — §3.1–3.5
- C2 `[DO] release desc-edit → release edit: pure rename + reference sweep` — §3.6 (no behaviour change; `git mv`, no shim)
- C3 `[DO] release edit: edit the release date alongside the description` — §3.7
- C4 `[DO] release list: show the Jira release date; skill/README/guidance for the date + rename` — §3.8–3.9

### 3.1 `src/lib/release-date/release-date.ts` (new) + `index.ts` — the one validator (D2)

- `export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/`
- `export const isIsoDate = (raw: string): boolean` — shape **and** calendar validity. Build with `Date.UTC(y, m - 1, d)` and compare the UTC getters back to `y/m/d` (rejects `2026-02-30`, `2026-13-01`). Because construction and read-back are both UTC, the check is **independent of the process timezone** — the comment says so and links MDN's note that the date-only form parses as UTC, which is why local getters would be wrong here. A second comment states the coverage honestly: the 4-digit regex plus the UTC round-trip is what excludes `0026-01-01` and `+002026-…`; this is not full ISO 8601 coverage and is not meant to be.
- `export class InvalidReleaseDateError extends Error` with a message that names the offender and the expected form: `Release date "28-10-2026" is not a calendar date in yyyy-mm-dd form.` (memory: messages are the agent's interface — name the offender + the fix).
- `export const assertIsoDate = (raw: string): string` — trims, validates, returns the canonical string.
- `export const isoDateSchema = z.string().refine(isIsoDate, { message: … })` — used by the **tool** schemas (`release-create`, `release-edit`); the agent form deliberately does not use it (§3.4).
- No past-date guard (D2): a PM legitimately back-fills; the confirm summary shows the date, which is enough.
- Test `src/lib/release-date/__tests__/release-date.test.ts`: valid dates (incl. leap day `2024-02-29`), invalid shapes (`2026-1-5`, `28/10/2026`, `20261028`, `2026-10-28T00:00:00Z`), invalid calendar (`2026-02-30`, `2026-13-01`, `2023-02-29`), whitespace trimming, error message text. **No `process.env.TZ` mutation** — `TZ` is worker-global under vitest and the design is TZ-independent by construction; the UTC choice is pinned by the comment and by the `2026-02-30`/leap cases, which would pass or fail identically in any zone.

### 3.2 `src/integrations/jira/api.ts` + `types.ts` — wire format (D7, D8, clear intent)

- `createJiraVersion`: add `releaseDate` to `requestBody` via conditional spread, **only when `params.releaseDate !== undefined`**, so the body is byte-identical to today's when no date is given. (No code comment about `JSON.stringify` dropping `undefined` — the spread is self-explanatory.)
- `types.ts:35`: delete the false "Defaults to current date if not provided" sentence (C1).
- `UpdateJiraVersionParams.releaseDate?: string | null` — `null` = clear. `updateJiraVersion` translates the intent to whatever Jira Cloud accepts. Implementation starts with `releaseDate: null`; §5.3 step 3 verifies against the real tenant **before C3 is committed**, and the comment links the Jira Cloud REST "Update version" doc plus the community thread that reports `""` if that turns out to be required. Callers never know the wire form.
- **Post-PUT echo comparison, scoped to the clear intent only.** When and only when `params.releaseDate === null`, compare `version.releaseDate || null` (Jira's echo of the updated version) against `null`; on mismatch throw `Jira accepted the update (the write happened) but still reports releaseDate=<got>; the clear payload in updateJiraVersion needs revisiting`. Scoping it to `null` is what keeps `deliverJiraRelease` (`api.ts:218-224`, `released: true, releaseDate: today`) genuinely untouched and avoids second-guessing Jira's date normalisation on ordinary sets (pre-mortem P1).
- `deliverJiraRelease` unchanged: delivery overwrites the planned date with today — this is Jira's own meaning of a released version's date (D8). Add one sentence to its JSDoc so the next reader does not "fix" it.
- Comment at `api.ts:52` mentioning `release desc-edit` → `release edit` (part of C2's sweep).
- Tests `src/integrations/jira/__tests__/version-body.test.ts` (new): mock `fetch`; POST body includes `releaseDate` iff given (and is byte-identical to today's otherwise); PUT body for `{ releaseDate: null }` matches the verified clear payload; PUT `{ releaseDate: null }` whose echo still carries a date throws with the "write happened" text; a deliver-shaped PUT (`released: true, releaseDate: today`) whose echo differs (e.g. Jira normalises) **does not** throw — proves the comparison never enters the deliver path. Existing `jira-api-error.test.ts` / `remove-version.test.ts` untouched.

### 3.3 `src/lib/version-utils/next-version.ts` — grammar (D1 A′)

- `ReleaseSpec`, `NamedReleaseInput`, `ReleaseEntry` gain `releaseDate?: string`.
- `parseReleaseSpec`: split the first colon-segment on the first `@`; left = token (as today), right = `assertIsoDate(...)`. An empty right side (`1.64.0@`) is an error naming the form. More than one `@` → error. Type/description parsing unchanged. JSDoc records the grammar invariant: the `@` split is sound only while `@` is illegal in every token form (`VERSION_RE`, `next`, `validateName`).
- `formatReleaseSpec`: token becomes `${id.raw}@${releaseDate}` when a date is present; the type/description tail rules are unchanged and still minimal (`1.2.5@2026-10-28:regular` formats as `1.2.5@2026-10-28`). Update the JSDoc's "minimal form" enumeration.
- `withDescription` → generalise to `withOptionalFields(base, { description, releaseDate })` built with conditional spreads (never a `releaseDate: undefined` key — `ensure-jira-version.test.ts:95` and the form gate both compare objects exactly); `resolveReleaseEntries`/`resolveNamedInput` carry the date through.
- `-r` help text in `program.ts:144-166`: grammar becomes `"<version|next|name>[@yyyy-mm-dd][:type[:description]]"`, plus one example.
- Tests `src/lib/version-utils/__tests__/next-version.test.ts`: parse `1.64.0@2026-10-28`, `next@2026-10-28`, `checkout-redesign@2026-10-28:hotfix:desc with: colons`; invalid date via `@` surfaces `InvalidReleaseDateError`; `1.64.0@` and `a@b@c` refused; description that _starts_ with an ISO date is still a description (`1.64.0:regular:2026-10-28 is the day` → description, no date); **round-trip property**: for a table of entries covering every combination of {type, description?, date?}, `parseReleaseSpec(formatReleaseSpec(resolve(e)))` equals the resolved entry, and `formatReleaseSpec` is idempotent under one parse→format (canonical form).

### 3.4 Agent surfaces — form, tool schema, wizard, summary/echo, result

- `src/lib/release-form/release-form.ts`: fourth field `releaseDate: z.string().optional()` **on the wire — no `isoDateSchema`** (house rule at `:103-106`: no measured wire shape on form fields). Prose: "Optional. Planned production date, yyyy-mm-dd. Becomes the Jira fix version's release date; delivery overwrites it with the actual date." The `release` field's prose gains one sentence: "no `@` here — the date has its own field", because `classifyReleaseToken('1.64.0@…')` at `:143` would otherwise produce a misleading "not kebab-case" refusal on round 2. `toArgs` trims and emits `releaseDate` **iff non-blank via conditional spread**, on the same key the tool transform reads — so the round-1 signed arguments equal the round-2 parsed arguments (no `releaseDate: undefined` key, mirroring `description` at `:135-147`). An invalid date is **not** refused by the form. Nothing parses `inputSchema` at runtime (`command-catalog.ts:40` only types it, the guard test wraps it, and `toArgs` has had no runtime caller since the MCP server was removed in 0.10.0): the real round 2 is the agent re-running `release create -r <token>@<date>` → `parseReleaseSpec` → the date validator → a plain `Error` out of `.action`, the same channel as "Invalid release type". So the field's prose also tells the agent where the value goes on the re-run: "On the re-run it is passed as `<token>@yyyy-mm-dd` inside `-r`." Test `release-form.test.ts`: field present with the prose; blank → key absent (the `toArgs` unit assertion, kept as an R7 row); "invalid → round-2 refusal names the date" drives the form value through `formatReleaseSpec`/`parseReleaseSpec` and asserts `InvalidReleaseDateError` naming it.
- `commands/release-create/release-create.ts`:
  - `releaseCreateMcpTool.inputSchema.releases[]`: `releaseDate: isoDateSchema.optional().describe(...)`; the `.transform` passes it into `ReleaseInput` by conditional spread.
  - Wizard: after the description prompt, `input({ message: '  Release date (yyyy-mm-dd, optional, press Enter to skip): ', validate })` where `validate` returns the validator's message; wrapped in `withEscape(..., { whenHeadless: 'refuse' })` like its siblings (the escapability + headless-policy sweeps in `lib/prompts/__tests__` will catch a bare call).
  - `formatReleaseSummary`: `label · type · description · ships 2026-10-28` (omit the segment when absent) — this is the confirm text the human approves.
  - `echoReleases` needs no change: it calls `formatReleaseSpec`, which now carries the date (principle 1).
  - `createSingleRelease` args gain `releaseDate?`; `ReleaseCreationResult` gains `releaseDate: string | null` **read from Jira's echo**, not from the argument: `created.version.releaseDate || null` on create, `{ ...existing, releaseDate }` after a reuse write-through, `existing.releaseDate || null` otherwise (§3.5). `outputSchema.results[]` mirrors it.
  - Tests: `release-create-batch.test.ts` — an explicit `--release 1.2.5@2026-10-28` reaches `createSingleRelease` with the date and the echo argv contains the canonical spec; `release-create-prompts.test.ts` — the new prompt keeps-empty, accepts a valid date, and re-asks on an invalid one; `release-create-confirm-refusal.test.ts` — confirm summary contains `ships 2026-10-28`.
- `src/lib/program/__tests__/rerun-argv.test.ts`: add a fixture `['release', 'create', '--release', '1.2.5@2026-10-28:regular:desc']` — the rerun argv is identical **after one parse→format** (pre-mortem P7: `formatReleaseSpec` is minimal, so fixtures use the canonical form; `1.2.5@2026-10-28:regular` echoes as `1.2.5@2026-10-28`).

### 3.5 `src/lib/release-utils/release-utils.ts` — `ensureJiraVersion` (D7)

- `EnsureJiraVersionArgs`/`CreateSingleReleaseArgs` gain `releaseDate?`.
- Create path: pass `releaseDate` to `createJiraVersion` (conditional spread).
- Reuse path: mirror the description rule — a given date that differs from `existing.releaseDate` is written through; an absent date never clears an existing one (creating must not be a way to erase). One PUT when both differ, built with conditional spreads so `ensure-jira-version.test.ts:95`'s exact-object assertion (`{ versionId: '42', description: 'current' }`) keeps passing untouched. Comment states the why: the confirm summary the human approved shows the date, so Jira must end up matching it.
- Return value carries the post-write date so `ReleaseCreationResult.releaseDate` reflects Jira, not the request (§3.4).
- Test `release-utils/__tests__/ensure-jira-version.test.ts` (exists): three new cases — create carries the date; reuse with a differing date PUTs exactly `{ versionId, releaseDate }`; reuse with no date PUTs nothing for the date (existing description-only assertion stays exact).

### 3.6 C2 — pure rename `release desc-edit` → `release edit` (D4)

`git mv src/commands/release-desc-edit src/commands/release-edit`, then `git mv` the three files inside to `release-edit.ts`, `__tests__/release-edit-confirm-refusal.test.ts`, `__tests__/release-edit-prompts.test.ts`. Identifiers: `releaseDescEdit` → `releaseEdit`, `ReleaseDescEditArgs` → `ReleaseEditArgs`, `releaseDescEditMcpTool` → `releaseEditMcpTool`, tool `name: 'release-edit'`. **No re-export shim.** Behaviour, flags, output, the Commander description string (`program.ts:170`) and the tool `description` are byte-identical in this commit except where the old command name itself appears; the wording changes belong to C3 (§3.7).

Reference sweep (every non-`docs/` hit of `grep -rnE 'desc-edit|descEdit|DescEdit'` today; the acceptance gate in §6 is that this grep returns nothing):

| File                                                                                  | What changes                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/lib/program/program.ts:25,168-183,439`                                           | import; `configureReleaseDescEdit` → `configureReleaseEdit`; `releaseGroup.command('edit')`          |
| `src/lib/command-catalog/command-catalog.ts:19,227-233,566`                           | import; `cliName: 'release-edit'`, `groupPath: ['release','edit']`; allowlist entry `'release-edit'` |
| `src/lib/command-catalog/__tests__/command-catalog.test.ts:50,391,440`                | expected names                                                                                       |
| `src/lib/command-catalog/__tests__/palette.test.ts:48`                                | expected path                                                                                        |
| `src/lib/program/__tests__/rerun-argv.test.ts:95-96`                                  | fixture path + argv                                                                                  |
| `src/tui/screens/__tests__/frame-height.test.tsx:136-137`                             | tool name (C2); the pinned Commander description string changes again in C3                          |
| `src/tui/__tests__/no-react-boundary.test.ts:20`                                      | file path                                                                                            |
| `src/lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts:178`              | file path                                                                                            |
| `src/lib/prompts/__tests__/headless-policy-guards.test.ts:62-66,300`                  | POLICY_SITES key + `tools` (C2); a second site row is added in C3                                    |
| `src/commands/doctor/__tests__/agent-allowlist.test.ts:218`                           | allowlist expectation                                                                                |
| `src/commands/doctor/__tests__/claude-plugin-checks.test.ts:618`                      | expectation                                                                                          |
| `src/integrations/jira/api.ts:52`                                                     | comment                                                                                              |
| `resources/root/body.md:10,27`                                                        | command list + confirm-gated list (esbuild-inlined; source of the generated block)                   |
| `src/lib/agent-guidance/__tests__/bodies.test.ts:190`                                 | expected line                                                                                        |
| `src/lib/agent-guidance/__tests__/__snapshots__/bodies-snapshot.test.ts.snap:351,368` | regenerate with `vitest -u` for that file only, then diff-review the two changed lines               |
| repo root `CLAUDE.md:29,46`                                                           | **never hand-edit** — `pnpm exec infra-kit audit --fix --root` after the CLI is rebuilt              |
| `apps/infra-kit/cli/readme.md:60,110`                                                 | command table + tool list                                                                            |
| `plugins/infra-kit/README.md:28,55`                                                   | confirm-gated lists                                                                                  |

`coverage/coverage-final.json`, `.eslintcache`, `dist/` are build artefacts, ignored.

### 3.7 C3 — `release edit` behaviour (D5)

`src/commands/release-edit/release-edit.ts` (new imports only from `src/lib/release-date` — `release-edit-confirm-refusal.test.ts:13-22` fully mocks the `src/integrations/jira` barrel, so any new barrel import there would need a mock entry):

- Args `{ version?, description?, releaseDate?: string | null, confirmedCommand }`.
- **Normalise the clear intent once, at the handler boundary, before change detection**: `const wantedDate = releaseDateArg === undefined ? undefined : (releaseDateArg === '' ? null : releaseDateArg)`. CLI `--release-date ""` and MCP `releaseDate: ''` are therefore the same intent, and clearing an already-empty date is a no-op (`changed: false`).
- Commander (`program.ts`): `--release-date <yyyy-mm-dd>` with an `argParser` that returns `''` unchanged and otherwise calls `assertIsoDate`, rethrowing as `commander.InvalidArgumentError(message)`. Why the argParser and not `.action`: Commander formats **only** `InvalidArgumentError` into its standard `error: option '--release-date <yyyy-mm-dd>' argument '2026-02-30' is invalid. <message>` line and exits 1; a custom error class from an argParser propagates raw to `entry/cli.ts`, and validating in `.action` (the `-r` pattern at `program.ts:156-158`) would run after Commander has already accepted the argv, which for a single scalar option buys nothing. `-d` keeps its `""`-clears rule. Parse coverage lives in `src/lib/program/__tests__/rerun-argv.test.ts` (a `release edit --version 1.2.3 --release-date 2026-10-28` fixture) plus one negative case in the same file asserting the `InvalidArgumentError` message for `2026-02-30`; there is no separate parse harness.
- Resolve branch + Jira version as today; `previous = { description: jiraVersion.description ?? '', releaseDate: jiraVersion.releaseDate || null }`.
- **Headless-without-a-field refusal, before any prompt** (shape precedent `release-create.ts:252-260`): placed exactly where `promptDescription` is reached today (`release-desc-edit.ts:132-140`, i.e. after branch + Jira resolution, so a missing version or PR still gets its own `OperationError` first). Condition `descriptionArg === undefined && wantedDate === undefined && isHeadless()` → `throw new StructuredRefusalError({ status: 'argument_required', argument: 'description', agentMode: agentMode.source }, 2, { operation: 'edit release', remediation: 'pass --description and/or --release-date on the re-run' })`. Keyed on `isHeadless()` (`agent-mode.ts:38-40`: `isAgentMode() || jsonOutput.enabled`), **not** `isAgentMode()` as the release-create precedent is: that site pre-empts a whole wizard behind an `argument_required` for `release`, whereas this one pre-empts a field-valued prompt that itself refuses on `isHeadless()` — the handler check must fire in every case the prompt would, `--json` included, or `--json` without a field would reach the prompt and get the one-flag remediation. Keeps `release-desc-edit-confirm-refusal.test.ts:80-90`'s asserted `structuredContent` shape unchanged.
- Field resolution: `const anyFlag = descriptionArg !== undefined || wantedDate !== undefined`. If `anyFlag`: `next.description = descriptionArg ?? previous.description`, `next.releaseDate = wantedDate === undefined ? previous.releaseDate : wantedDate`. Else (TTY): `promptDescription(previous.description)` then new `promptReleaseDate(previous.releaseDate)` — `input` with `validate`, Enter keeps; `withEscape(..., { whenHeadless: { refuse: 'releaseDate' } })`. The prompt-level refusals are unreachable in agent mode (the handler refused first) but the policy must still be declared: add the POLICY_SITES row `'commands/release-edit/release-edit.ts#promptReleaseDate': { policy: 'argument', tools: ['release-edit'], fields: ['releaseDate'] }` to `headless-policy-guards.test.ts` so G6/G7/G8 stay green.
- `changedFields = (['description','releaseDate'] as const).filter(f => next[f] !== previous[f])`; empty → return `changed: false` before the gate.
- Echo: `commandEcho.addOption('--description', …)` / `('--release-date', …)` only for changed fields (`''` for a clear), then `--yes` after the gate, as today.
- Confirm text: `Update 1.64.0?\n  description: "old" → "new"\n  release date: 2026-10-28 → (none)` — one line per changed field.
- Writes: `updateJiraVersion({ versionId, ...(descChanged ? { description } : {}), ...(dateChanged ? { releaseDate } : {}) })`; `updateReleasePRBody` only when the description changed.
- `structuredContent`: keep `version, branch, jiraVersionUrl, previousDescription, newDescription, changed`; add `previousReleaseDate: string | null`, `newReleaseDate: string | null`, `changedFields: ('description' | 'releaseDate')[]`.
- `releaseEditMcpTool.inputSchema` is a `ZodRawShape` (`headless-policy-guards.test.ts:102` calls `z.object(tool.inputSchema)`), so **no `.refine` across fields**: `version: z.string()`, `description: z.string().optional()`, `releaseDate: z.union([isoDateSchema, z.literal('')]).optional()`. The at-least-one rule **is** the handler refusal above. `outputSchema` mirrors the new fields. Tool `description` must keep a phrase matching the PROMISE regex (`headless-policy-guards.test.ts:94`: `/without a TTY|no TTY|required for MCP|required when invoked via MCP/i`; `:300` pins `release-desc-edit` → `release-edit` on the promise list): "Edit a release's description and/or planned release date in Jira; a changed description is mirrored into the GitHub release PR body. `version` and at least one of `description`/`releaseDate` are required for MCP calls (the picker and prompts are unreachable without a TTY). Empty string clears a field." It stays in `LOW_RISK_MUTATING_ALLOWLIST` (unchanged risk class: metadata on an unreleased fix version).
- Commander description (`program.ts:170`) becomes "Edit a release's description and/or release date in Jira (description also in the matching GitHub PR body)" — **`frame-height.test.tsx:137` pins this string and changes again in C3**; `command-catalog.test.ts` is checked for a pinned tool `description` at the same time.
- Cross-command asymmetry (Architect): a user who learned `1.64.0@2026-10-28` will try it as `--version`. The hint lives in `parseReleaseRef`'s own error (`release-id.ts:133`, the `InvalidReleaseRefError` path): when the input contains `@`, the message reads "the `@date` suffix belongs to `release create`; pass the version alone here and use `--release-date` on `release edit`". One place serves all seven call sites — `resolveReleaseBranch`'s four (edit, deliver, remove, deploy) plus `worktrees-add.ts:158`, `worktrees-remove.ts:161`, `gh-merge-dev.ts:112` — so `resolveReleaseBranch` itself is untouched. One test in `src/lib/release-id/__tests__/release-id.test.ts`.
- Tests: `release-edit-confirm-refusal.test.ts` — keep the two existing contracts (unconfirmed → `confirmation_required`; no field in agent mode → `argument_required` naming `description` with the two-flag remediation, refused before any prompt: assert no inquirer mock was invoked); add: `--release-date` only → Jira PUT carries exactly `{ versionId, releaseDate }`, PR body untouched; `--description` only → PUT carries exactly `{ versionId, description }`, PR body updated; both → one PUT with both; same values → `changed: false`, no PUT, no gate; `--release-date ""` on a dated version → PUT `{ versionId, releaseDate: null }`; **MCP `releaseDate: ''` on a version with no date → `changed: false`, no PUT**. `release-edit-prompts.test.ts` — existing four + `promptReleaseDate` keeps-current on Enter, accepts valid, re-asks invalid.

### 3.8 C4 — `release list` shows the date (D6)

- `release-utils.ts`: `getJiraDescriptions` → one fetch, `getJiraVersionInfo(): Promise<Map<string, { description: string | null; releaseDate: string | null }>>`; keep `getJiraDescriptions` as a one-line projection so `formatBranchPickerItems` and the pickers are untouched. Baseline behaviour preserved exactly: **empty map** when Jira config is absent, **warn and return the (possibly empty) map** when the fetch throws — never rethrow (`worktrees list` awaits it inside a `Promise.all`, per the comment at `:222-224`).
- `commands/gh-release-list/gh-release-list.ts`: row `label  description  · ships 2026-10-28` (omit when null); `structuredContent.releases[].releaseDate: string | null`; `outputSchema` mirrors; tool `description` mentions the date.
- Test: `gh-release-list` has no `__tests__/` today — add `__tests__/gh-release-list-output.test.ts` with a mocked `getJiraVersionInfo`: row text with/without a date; `releaseDate: null` when Jira has none; the Jira-unavailable branch (mock resolves to an empty map, as the baseline does) still renders rows with `description: null, releaseDate: null`.

### 3.9 Docs, skill, guidance

- `plugins/infra-kit/skills/release-create/SKILL.md` §3 "What goes in `-r`": the `@yyyy-mm-dd` segment with the examples `1.64.0@2026-10-28` and `next@2026-10-28`; a "Reading `$ARGUMENTS`" line: `--date <text>` or any natural-language date ("28 October") is translated by the agent to ISO **using today's date for the year** and echoed back in the preview for the human to check — the CLI never parses prose. `argument-hint` becomes `[--hotfix] [--desc <text>] [--date <yyyy-mm-dd>] [<version|next|name>]`.
- `plugins/infra-kit/README.md`, `apps/infra-kit/cli/readme.md`: rename + one line for the date.
- `resources/root/body.md` → rebuild the CLI → `pnpm exec infra-kit audit --fix --root` regenerates root `CLAUDE.md` inside the markers.
- No new plan doc beyond this file; §7 ADR is the record.

---

## 4. Pre-mortem (deliberate mode)

| #   | Failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Guard                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Jira Cloud ignores `releaseDate: null` on PUT; `release edit --release-date ""` reports `changed: true` while the Jira UI still shows the date.                                                                                                                                                                                                                                                                                                                                                                         | §3.2 echo comparison on the clear intent throws (and says the write happened); §5.3 step 3 manual clear run before C3 is committed; the wire form lives in one function.                                                                                    |
| P2  | Spec round-trip silently drops the date (e.g. `formatReleaseSpec` updated, `resolveReleaseEntries` not), so the human approves a dated preview and the `--yes` re-run creates an undated version.                                                                                                                                                                                                                                                                                                                       | §3.3 round-trip property test over every field combination + §3.4 rerun-argv fixture + §3.4 batch test asserting the echo argv.                                                                                                                             |
| P3  | A stale `desc-edit` survives (snapshot, doctor allowlist test, `body.md`), so `ik audit` reports drift in every consumer repo after the next publish, or the plugin doctor check goes red.                                                                                                                                                                                                                                                                                                                              | §6 grep gate is empty; `bodies-snapshot` regenerated and diff-reviewed; `audit --fix --root` run as part of C4, not "later".                                                                                                                                |
| P4  | Off-by-one date: a validator built on local getters rejects `2026-10-28` or accepts `2026-03-01` as `02-29` on a machine west of UTC.                                                                                                                                                                                                                                                                                                                                                                                   | UTC construction + UTC getters make the check TZ-independent (§3.1); the leap/`02-30` cases fail identically in any zone.                                                                                                                                   |
| P5  | `ensureJiraVersion` reuse path clears an existing date because the caller passed none.                                                                                                                                                                                                                                                                                                                                                                                                                                  | §3.5 rule: absent never clears; test "reuse with no date PUTs nothing for the date".                                                                                                                                                                        |
| P6  | **The most likely red of C3 is the guard suite, not Jira**: a new inquirer site without a written-out `whenHeadless` (G7 — the escapability sweep `every-inquirer-site-is-escapable`, per `escapable-context.ts:57`), a new `withEscape` site without a POLICY_SITES row (the unnamed `describe('the site table tracks the code it makes claims about')` at `headless-policy-guards.test.ts:142-181`), a tool description that lost its PROMISE phrase (G6), a `.refine` on the raw shape (G8), or the bodies snapshot. | §3.7 items: `{ refuse: 'releaseDate' }` + POLICY_SITES row; PROMISE phrase kept in the tool description; no cross-field `.refine`; §5.2 runs `headless-policy-guards`, `every-inquirer-site-is-escapable`, `bodies-snapshot` by name before the full suite. |
| P7  | Rerun canonicalisation: `-r 1.2.5@2026-10-28:regular` echoes as `1.2.5@2026-10-28` because `formatReleaseSpec` is minimal, so a "byte-identical argv" assertion is wrong by design.                                                                                                                                                                                                                                                                                                                                     | Parity is defined as "identical after one parse→format"; rerun-argv fixtures use the canonical form (§3.4); the idempotence case in §3.3 pins it.                                                                                                           |

---

## 5. Test plan

### 5.1 Unit

- `release-date.test.ts` — validator (§3.1).
- `next-version.test.ts` — grammar + round-trip property + idempotence + collision/refusal cases (§3.3).
- `release-form.test.ts` — fourth field; blank → absent; invalid → round-2 refusal (§3.4).
- `ensure-jira-version.test.ts` — create/reuse date rules with exact PUT objects (§3.5).
- `version-body.test.ts` — POST/PUT bodies, clear-intent echo throw, deliver path excluded (§3.2).
- `release-edit-*.test.ts` — partial fields, no-change, `''`-normalisation, headless refusal before prompts, clear (§3.7).
- `release-id.test.ts` — `@` hint in `parseReleaseRef`'s error (§3.7).
- `gh-release-list-output.test.ts` — row + structured date + Jira-unavailable baseline (§3.8).

### 5.2 Integration

- `rerun-argv.test.ts` — `release create -r 1.2.5@2026-10-28:regular:desc` (canonical) and `release edit --version 1.2.3 --release-date 2026-10-28` parity; `--release-date 2026-02-30` → `InvalidArgumentError` message.
- `command-catalog.test.ts` / `palette.test.ts` / `agent-allowlist.test.ts` / `claude-plugin-checks.test.ts` — `release-edit` in every registry.
- Run by name before the full suite (P6): `headless-policy-guards.test.ts`, `every-inquirer-site-is-escapable.test.ts`, `bodies-snapshot.test.ts`, `frame-height.test.tsx`.

### 5.3 Manual e2e (user's machine, real Jira + GitHub, one throw-away release)

1. `infra-kit release create -r 9.9.9-test@2026-10-28:regular:plan-test` → approve → Jira UI shows the fix version with release date 28 Oct 2026; `release list --json` shows `releaseDate: "2026-10-28"`.
2. `infra-kit release edit -v 9.9.9-test --release-date 2026-11-04` → Jira shows 4 Nov; PR body unchanged.
3. `infra-kit release edit -v 9.9.9-test --release-date ""` → Jira shows no date. **This step verifies the clear payload; if it fails, fix `updateJiraVersion` before committing C3.**
4. `infra-kit release edit -v 9.9.9-test -d "new text"` → PR body updated, date untouched.
5. `infra-kit release edit -v 9.9.9-test@2026-10-28` → refused with the "belongs to `release create`" remediation.
6. `infra-kit release remove -v 9.9.9-test` to clean up.

### 5.4 Observability

- `release create` result: `results[].releaseDate` (Jira's echo); `release edit` result: `previousReleaseDate`, `newReleaseDate`, `changedFields`; `release list`: `releases[].releaseDate`. All `null` when absent — an agent asked "when does 1.64.0 ship?" reads `release list --json`.
- Log lines (existing `logger`): `updateJiraVersion` logs the field set it sent at `debug`; the clear-intent mismatch throw names what Jira still reports and states the write happened.

---

## 6. Acceptance criteria (verifier-checkable)

1. `parseReleaseSpec('1.64.0@2026-10-28:hotfix:Fix: cart')` → `{ version:'1.64.0', type:'hotfix', description:'Fix: cart', releaseDate:'2026-10-28' }` and `formatReleaseSpec` of its resolved entry reproduces the same string; `formatReleaseSpec(resolve(parse('1.2.5@2026-10-28:regular')))` is `1.2.5@2026-10-28`.
2. `parseReleaseSpec('1.64.0:regular:2026-10-28 launch')` has **no** `releaseDate` (description grammar unchanged).
3. `parseReleaseSpec('1.64.0@2026-02-30')` throws `InvalidReleaseDateError` naming `2026-02-30`.
4. A mocked `createJiraVersion` POST body contains `releaseDate` iff the entry has one; without one the body is byte-identical to today's. A mocked PUT `{ releaseDate: null }` whose echo still carries a date throws; a deliver-shaped PUT never enters the comparison.
5. `infra-kit release desc-edit` prints Commander's unknown-command error; `infra-kit release edit --help` lists `-v`, `-d`, `--release-date`, `-y`; `release edit --release-date 2026-02-30` exits 1 with Commander's `InvalidArgumentError` line carrying the validator message.
6. `release edit --version X --release-date Y` (agent, unconfirmed) → `confirmation_required`, zero Jira/GitHub writes; with `--yes` → one PUT containing exactly `{ versionId, releaseDate }`, no PR body write.
7. `release edit --version X` in agent mode with no field → `argument_required` naming `description` from the **handler-level** `StructuredRefusalError` (not a prompt site), `structuredContent` equal to `{ status:'argument_required', argument:'description', agentMode }`, remediation "pass --description and/or --release-date on the re-run", and no inquirer prompt constructed.
8. The form's signed round-1 arguments for a blank date carry no `releaseDate` key; `release create -r 1.64.0@2026-02-30` exits with the validator's message naming `2026-02-30`.
9. Grep gate, run from the repo root: `grep -rnE 'desc-edit|descEdit|DescEdit' apps packages plugins .claude .claude-plugin .github CLAUDE.md --include='*.ts' --include='*.tsx' --include='*.md' --include='*.snap' --include='*.json' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage --exclude-dir=.omc --exclude='.eslintcache'` returns nothing (`docs/` is deliberately outside the roots — history stays).
10. Root `CLAUDE.md` block regenerated by `audit --fix --root`; `ik audit` on this repo reports no drift.
11. `headless-policy-guards`, `every-inquirer-site-is-escapable`, `bodies-snapshot`, `frame-height` green by name, then `pnpm run qa` green at the root: `tsc`, `vitest` (full suite, not filtered), `eslint --no-cache`, `prettier --check` (memories: rtk swallows exit codes — gate on the raw exit code; `--cache` hides errors).
12. §5.3 steps 1–5 observed in the Jira UI / terminal by the user.

---

## 7. ADR

**Decision.** Add an optional per-release release date to `release create`, carried in the `--release` spec as `<token>@yyyy-mm-dd`, validated by one shared module, written to the Jira fix version on create (and on reuse when it differs), never to the PR body. Rename `release desc-edit` to `release edit` with no alias and extend it to edit description and/or date with per-field change detection, the at-least-one rule enforced by a handler-level refusal. Expose the date in `release list`.

**Drivers.** Re-run parity of the preview/`--yes` protocol; one source of truth for the date; a rename whose completeness is grep-verifiable.

**Alternatives considered.** D1-A colon-positional date (accepted fallback; one collision); D1-B batch-wide flag (rejected: cannot echo per entry); alias for one release (rejected: doubles every registry). Putting the date in the PR body (rejected: second copy that `release edit` would have to keep in sync; Jira already renders it). A cross-field `.refine` on the tool schema (rejected: `inputSchema` is a raw shape consumed by the guard suite).

**Why chosen.** `@` on the token is collision-free because the token grammar excludes it; the rest of the design is the minimum that keeps every existing field, test contract, guard-suite ledger and output shape intact while adding the date additively.

**Consequences.** Delivery overwrites the planned date with the actual one (Jira semantics, unchanged). `ensureJiraVersion` may now issue a PUT for the date on reuse. The clear-on-PUT wire form is empirical and lives only in `updateJiraVersion`, guarded by an echo comparison scoped to that intent. `@` becomes a reserved character in every token grammar. Consumers see the new name only after the lockstep publish.

**Follow-ups (out of scope here).** `[DO] release <next>` lockstep publish; `plugin.json` version aligned in the same bump (memory: it is the 6th version field); `pnpm add -g infra-kit@<exact>` on the user's machine (memory: `@latest` is a stale cache hit); consumer repos pick up the skill/README text via the starter `.claude/` rsync and the regenerated guidance via `ik audit --fix`.

---

## 8. Open questions for the user (each with the default this plan assumes)

- **Q1 (D1)** — date on the token `1.64.0@2026-10-28` (A′, default) or positional `1.64.0:regular:2026-10-28[:desc]` (A)? Both keep every current spec valid.
- **Q2 (D3)** — keep the date out of the PR body (default: yes, Jira only)?
- **Q3 (D4)** — hard rename with no `desc-edit` alias (default: yes)?
- **Q4 (D6)** — include the `release list` date column/field in this change (default: yes, it is what makes the date observable to an agent; drop C4's list half if not)?

## Revision log

- rev 1 (2026-09-20) — Planner draft.
- rev 2 (2026-09-20) — Architect + Critic corrections: form field is a bare `z.string().optional()` with round-2 refusal and a "no `@`" hint; `''`→`null` normalised at the handler boundary; `promptReleaseDate` gets `{ refuse: 'releaseDate' }` + a POLICY_SITES row; headless no-field refusal is a handler-level `StructuredRefusalError` with a two-flag remediation; tool schema loses the cross-field `.refine` (raw shape) and keeps a PROMISE phrase; echo comparison scoped to the clear intent so deliver is untouched; Commander `InvalidArgumentError` for `--release-date`; `frame-height` listed under C3 too; TZ test dropped (validator is TZ-independent); false `types.ts:35` JSDoc deleted; conditional spreads everywhere an exact-object assertion exists; P6/P7 added; grep gate roots/excludes fixed; `ReleaseCreationResult.releaseDate` from Jira's echo; `getJiraDescriptions` baseline stated; SKILL `next@…` example + `--date` hint; `@` reserved in future token grammars; `resolveReleaseBranch` `@` remediation.
- rev 3 (2026-09-20) — Critic conditions: form "round 2" corrected to the `-r <token>@<date>` re-run through `parseReleaseSpec` (no runtime `inputSchema` parse), field prose says so, acceptance #8 rewritten; handler refusal keyed on `isHeadless()` at the `promptDescription` site with the why vs the release-create precedent; `@` hint moved into `parseReleaseRef`'s error (one place for seven call sites), test moved to `release-id.test.ts`; P6 relabelled (G7 = escapability sweep; POLICY_SITES check is the unnamed `describe` at `headless-policy-guards.test.ts:142-181`).
