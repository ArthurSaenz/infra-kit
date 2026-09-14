# `/infra-kit:session` — plan

**Status: S1–S3 shipped (S1 `5a34d47`, S2 infra-kit 0.5.2, S3 `plugins/infra-kit/commands/session.md`, plugin 0.4.0). S4 run 2026-09-14: AC1–AC4 pass, the PM-4 tie is unreachable by design, one out-of-scope stdout finding recorded.**

Read §1 to review scope. The derivation that produced it is in Appendix A; the ADR is Appendix B.

---

# 1. The epic

## `[DO] epic: /infra-kit:session — one entry point for switching a terminal's context`

**Outcome.** A user types `/infra-kit:session` in Claude Code. With no argument they are shown the
environments this project has and asked which one; with an argument, that environment is loaded into
the terminal that launched Claude Code. `--clear` unloads it. The procedure the agent follows ships
**inside the MCP server** as the resource `infra-kit://workflow/session`, so the command file stays
three lines and the logic is versioned with the server that serves it. No MCP tool is written or
changed: `session` composes `env-list`, `env-load` and `env-clear`, each of which stays usable on its
own. The name and the body are shaped so that a second provider — an AWS profile, a kubectl context —
is a later insertion rather than a second command.

### 1.1 What the user actually sees

Illustrative — the exact agent wording is not enforceable, but every value below comes from real code
(`env-load.ts:212-213` builds the path).

**No environments table is rendered.** `env-list`'s aligned table is `formatEnvTable`, printed with
`logger.info` on the CLI path only; over MCP the tool returns `structuredContent`
(`{ project, configs, tokens: [{ env, source, hasToken }] }`) and the table never reaches the agent.
Reproducing it would be the agent hand-building a CLI artefact it was not given. Of the two extra
columns, only one is actionable: `hasToken: false` means `resolveEnvToken` throws `EnvAuthError`
(`token-resolver.ts:63`), so that choice is guaranteed to fail — it is shown inline, with its fix.
`source` (`gh-workflow` vs `token-only`) is provenance of how we know the environment exists, which
is an artefact of `env-list` being unable to enumerate Doppler; it does not help anyone choose, so it
is not shown.

```
❯ /infra-kit:session

  ? Which environment do you want in this terminal?  (Doppler project: hulyo)
    ▸ dev
      stage
      arthur
      prod     no token — run `infra-kit env-token-set prod` first
      Other…   a name env-list does not know is still valid

❯ dev

  Loaded dev — 47 variables, Doppler project hulyo.
  Session f44a3ff4  (~/.cache/infra-kit/f44a3ff4/env-load.sh)

  They appear in your terminal at its next prompt — after Claude Code exits or is
  backgrounded. If `echo $INFRA_KIT_SESSION` there is not f44a3ff4, this landed in a
  different terminal.
```

```
❯ /infra-kit:session --clear

  Clearing 47 variables (dev, project hulyo) from session f44a3ff4.
  [host confirmation prompt — approve to continue]

❯ (approves)

  Cleared. At your prompt you should see: infra-kit: auto-cleared env
  If you instead see `infra-kit: auto-loaded vars for dev`, run --clear once more —
  the load and the clear landed in the same wall-clock second.
```

### 1.2 Completion condition

**The epic closes when S3 is merged — not when S2 publishes.**

This is a criterion, not a formality. `infra-kit://workflow/setup` shipped in the CLI and is
registered at `resources/index.ts:139-141`; its comments name a `/infra-kit:setup` plugin command,
and `plugins/infra-kit/commands/` contains **only `release-create.md`**. The one prior run of this
exact CLI-first pattern produced a published resource whose plugin command still does not exist. That
is the precedent this criterion exists to break, and it is why the ordering below is stated as a
single epic rather than "publish, then see".

### 1.3 The ordering is enforced, not preferred

`scripts/check-workflow-resource-published.mjs` runs in `plugin-ci.yml` on every PR touching
`plugins/**`. It reads a floor out of the literal `it needs infra-kit X.Y.Z or newer` (`:59`, `:80`)
and an `infra-kit://workflow/<slug>` URI (`:60`, `:86`) out of **every** command body, and refuses
the PR until the **published** `infra-kit@latest` both meets the floor and answers `resources/list`
with that URI. Published today == local == `0.5.1`.

So: **S1 merges → S2 publishes to npm → only then is S3 opened.** A command merged early is not
slightly early; it turns plugin CI red for everyone until the publish lands, and every user who
installs in that window gets a command whose first instruction is a 404.

---

## S1 — `[DO] session: author, serve and test the workflow procedure`

One PR. CLI-only; touches no plugin file.

**Files**

| File                                                  | Change                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/infra-kit/cli/resources/workflow/session.md`    | new — the procedure                                                                                                               |
| `apps/infra-kit/cli/src/mcp/workflow-bodies.ts`       | `?raw` import (flat/static/explicit, per `:1-11`), `WorkflowKey` gains `'session'`, `WORKFLOW_BODIES.session = session.trimEnd()` |
| `apps/infra-kit/cli/src/mcp/resources/index.ts`       | `SESSION_WORKFLOW_URI`, a third `registerWorkflow` call                                                                           |
| `apps/infra-kit/cli/src/mcp/__tests__/server.test.ts` | two new `it`s                                                                                                                     |
| `docs/session-context-orchestrator.md`                | new — the provider seam, written for a human                                                                                      |

### The procedure's sections

1. **What a session is** — a named context that today resolves to exactly one activation, the
   Doppler environment. The name **is** the Doppler config name; no mapping table exists. One line
   linking to `docs/session-context-orchestrator.md`. _Nothing else._ The
   `activate`/`deactivate`/`status` narration belongs in the doc, addressed to whoever adds provider
   two — an agent reading this body should spend its attention on §2 and §5.
2. **How this reaches the user's shell, and how it fails** — `env-load` writes `env-load.sh` into
   `${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION/` (`env-load.ts:212-213`,
   `constants/constants.ts:123-133`). The zsh block `infra-kit setup` installs registers a `precmd`
   hook (`init.ts:812-837`) that sources it when its mtime beats the last sourced one, shell start,
   and the clear file. Three things this section must say, in terms: the **timing**, the
   **destination**, and the **Bash lie**. Plus the loud failure: the tool throws
   `INFRA_KIT_SESSION is not set` → tell the human to run `infra-kit setup --skip-tools` then
   `source ~/.zshrc`; do not retry. The authoritative reading of what a terminal holds is
   `infra-kit env-status` **typed in the terminal, not over MCP**.
3. **Resolving `$ARGUMENTS`** — bare token → `env-load` with `config: <token>`. No token →
   `env-list`, then ask with `AskUserQuestion` — one option per environment, and **no table**: the
   agent receives `structuredContent`, not `formatEnvTable`'s CLI rendering, so a table would be
   hand-built from JSON. Carry one field into the options: an environment whose `hasToken` is `false`
   is annotated with `infra-kit env-token-set <env>` as its fix, because that choice cannot succeed.
   Do **not** surface `source` — it records how we learned the environment exists, not anything that
   helps choose. More than four ⇒ the four most likely plus a typed "Other". Then `env-load`. Never
   invent a name; never load without an explicit choice.
4. **The list is local and may be wrong** — `env-list` is a union of workflow-declared environments
   and environments the local token store holds a token for; a Doppler service token is
   config-scoped and cannot enumerate siblings. So an empty list is a legitimate result (say so, ask
   in prose), and a name absent from the list must still be passed to `env-load` — the list is not
   authoritative about what exists, only `hasToken` is authoritative about what will load (§3).
5. **The flag** — one definition line, in U17's required form (backticked flag + `→` on one line):
   ``- `--clear` → `mcp__infra-kit__env-clear`, the two-call confirm protocol in §6.``
   Plus: `--clear` together with a bare environment token is a usage error, refused, not resolved by
   precedence — the same reasoning `setup.md` §2 applies to `--skip-tools`.
6. **`--clear`'s confirm gate, and the tie hazard** — `env-clear` is `requiresHumanConfirm: true`
   (`env-clear.ts:128`). Call 1 (no `confirm`, no `confirmToken`) returns
   `{"status":"confirmation_required", …}` with `"isError": true`; **that is not a failure** — show
   the human the resolved action. Call 2 repeats identical args plus `"confirm": true` and the
   token; a mismatch is `confirmation_refused` and terminal. **`env-load` is not gated** — say so,
   so an agent does not wait for a gate that never comes. Then the hazard (verified, see PM-4): a
   `--clear` whose file lands in the same wall-clock second as the load it follows is swallowed.
   Instruct the agent to tell the human to confirm at their prompt, and that running `--clear` once
   more a second later is the recovery.

   **One frequency sentence, required.** On the shipped path the tie is rare, because the confirm
   gate puts a human approval between the load and the clear; it is common in scripted or
   back-to-back use, where nothing interposes. Without that sentence the agent narrates an exotic
   hazard on every clear. It is also exactly why S4's probe must bypass the human approval
   programmatically — see S4 AC5.

7. **What not to do** — no `doppler` shell-out, no `export` in `Bash`, and never echo a variable's
   value (`env-list` reports presence only; `env-load.sh` holds single-quoted secrets).

### The literal clauses

These are the exact substrings `server.test.ts` asserts. `proseWrap` is unset in
`vendor/configs/prettier-config/index.mjs:33`, so it defaults to `preserve` — prettier will **not**
reflow this file, but the author's own wrap will, and a fragment spanning an authored line break
fails `toContain`. **Every literal below must therefore be authored on a single line**, which is why
they are fragments rather than whole sentences.

| #   | Exact literal                                                           | Section |
| --- | ----------------------------------------------------------------------- | ------- |
| C1  | `mcp__infra-kit__env-list`                                              | §3      |
| C2  | `mcp__infra-kit__env-load`                                              | §3      |
| C3  | `` `--clear` → `mcp__infra-kit__env-clear` ``                           | §5      |
| C4  | `at its next prompt — after Claude Code exits or is backgrounded`       | §2      |
| C5  | `the terminal that launched Claude Code and no other`                   | §2      |
| C6  | `writes into a directory nothing is watching and still returns success` | §2      |
| C7  | `report the session id from the returned filePath`                      | §2      |
| C7b | `compare it with INFRA_KIT_SESSION at their own prompt`                 | §2      |
| C8  | `does not persist shell state between calls`                            | §2      |
| C9  | `INFRA_KIT_SESSION is not set`                                          | §2      |
| C10 | `infra-kit setup --skip-tools`                                          | §2      |
| C11 | `typed in the terminal, not over MCP`                                   | §2      |
| C12 | `not a live Doppler enumeration`                                        | §4      |
| C13 | `an empty list is a legitimate result`                                  | §4      |
| C14 | `confirmation_required`                                                 | §6      |
| C15 | `confirmToken`                                                          | §6      |
| C16 | `"confirm": true`                                                       | §6      |
| C17 | `` `env-load` is not gated ``                                           | §6      |
| C18 | `in the same wall-clock second`                                         | §6      |
| C19 | `infra-kit: auto-loaded vars for`                                       | §6      |
| C20 | `docs/session-context-orchestrator.md`                                  | §1      |
| C21 | `Bash`                                                                  | §2      |

**C7 and C7b are two fragments of one instruction**, authored on two consecutive lines. Split because
a single fragment carrying subject, object and rationale cannot fit one authored line — and C7b
alone would pin only the rationale tail, staying green while the instruction it guards disappeared.

**C20** is the body's only tether to the provider contract once the `activate`/`deactivate`/`status`
prose moves to the doc. Nothing else enforces that the link survives an edit.

**C21** pins the negative half of the Bash rule; C8 pins only the positive half. `server.test.ts:210`
sets the precedent — `release-create`'s rendered-shape test already asserts a bare `Bash`.

**What is enforced is that the body carries the instruction.** An agent's actual report is runtime
behaviour and no test can pin it. C7/C7b guarantee the sentence exists, never that it was obeyed.

### Acceptance criteria

1. `apps/infra-kit/cli/resources/workflow/session.md` exists and `pnpm exec prettier --check` passes
   on it.
2. Every literal C1–C21 (including C7b) appears in the file, each on a single authored line.
3. `WorkflowKey` is `'release-create' | 'setup' | 'session'` and `WORKFLOW_BODIES` has three entries.
4. `resources/list` on a locally built server includes `infra-kit://workflow/session`;
   `resources/read` on it returns one `text/markdown` content whose text `===`
   `WORKFLOW_BODIES.session` byte-for-byte.
5. **`prompts/list` still returns exactly `['release-create']`.** The existing test at
   `server.test.ts:131-146` is left untouched and still passes — that is the guard proving `session`
   is resource-only, on `setup`'s precedent.

   > **Superseded 2026-09-14 (prompt half only):** the MCP prompt was retired once the plugin command landed — see `docs/release-create-prompt-removal-plan.md`. The resource half stands.

6. **The `?raw` import survived the bundle**, checked against the built artifact and not `src` —
   `workflow-bodies.ts:1-8` records that every test in this package runs from `src/`, where a
   bundle-breaking refactor still passes. The check is:

   ```sh
   pnpm --filter infra-kit run build
   grep -rl 'the terminal that launched Claude Code and no other' apps/infra-kit/cli/dist/*.js
   ```

   It must name at least one file, and will name `dist/mcp.js`. **The build step is not optional:**
   `dist/**` is gitignored and the package's `test` script does not build.

   Two things this criterion is deliberately specific about, both verified against the current
   bundle:
   - **The target is `dist/*.js`, not `dist/cli.js`.** The CLI is code-split; the workflow bodies
     land in `dist/mcp.js`. `grep -c '<clause>' dist/cli.js` prints `0` on a fully correct build, so
     that form would fail a good build and its "free RED" would be vacuous rather than red.
   - **The grep literal must be pure ASCII.** esbuild rewrites every non-ASCII character in the
     bundle as a backslash-u escape, so a literal containing an em dash never matches: searching
     `dist/mcp.js` for `setup.md`'s phrase `confirm gate in section 4 — which` finds nothing,
     while `confirm gate in section 4 ` (ASCII prefix only) is followed there by `\u2014 whic`.
     C5 is ASCII-only for this reason; C4 carries an em dash and cannot be the grep target.

   **Free RED available today:** the same grep against the current bundle names no file and exits
   non-zero — proven with the green precedent
   `grep -rl 'does not mean the call failed' apps/infra-kit/cli/dist/*.js`, which names `dist/mcp.js`.

7. New `it('renders a session body that still carries the clauses an agent needs')` pins
   `body.split('\n')` to the actual line count, `endsWith('\n') === false`, and one `toContain` per
   literal in the table above.
8. **That test is proven RED twice** — once on **C4**, once on **C6**, the silent-failure clause whose
   absence is invisible on a read-through in a way C4's is not. Record both in the PR, and verify the
   file is byte-identical afterwards rather than merely restored-looking.

   **Reword the clause in place; do not delete its line.** A deletion also changes the line count, and
   `expect(body.split('\n')).toHaveLength(…)` runs before the `toContain` assertions — so vitest
   fails on the count and never evaluates the clause guard at all. The deletion mutation therefore
   proves the line-count tripwire twice and the clause guard zero times, which is the opposite of what
   this criterion is for. A single-word substitution on the same line (`backgrounded` →
   `put in the background`; `nothing is watching` → `nobody is watching`) keeps the count intact and
   fails exactly one `toContain`, naming it.

9. `docs/session-context-orchestrator.md` exists and states that adding a provider must **not**
   change the four env MCP tools nor the command's **frontmatter**, and explicitly lists the command
   body's fallback line as a thing to review at that time.
10. `pnpm run ts-check && pnpm run eslint-check && pnpm run test` green in `apps/infra-kit/cli`.

---

## S2 — `[DO] release: publish infra-kit 0.5.2 carrying infra-kit://workflow/session`

The gate S3 waits on. A patch bump on the `0.5.x` line, by the repo owner's decision — the addition is
additive and reaches no existing caller, so it does not need a version line of its own. Whatever
number publishes must be the number written into S3's floor sentence, character for character.

**Acceptance criteria**

1. `pnpm view infra-kit@latest version` reports `0.5.2`.
2. A hand-driven `pnpm dlx infra-kit@0.5.2 mcp` answers `resources/list` with
   `infra-kit://workflow/session`.
3. `node scripts/check-workflow-resource-published.mjs`, run before S3 exists, prints the published
   version and `OK` for the one command that exists.
4. Publish-order check: confirm S1 touched nothing in `@slip-stream-kit/config`. The CLI depends on
   it through a registry range, so if it did change the order is bump → publish config → re-pin →
   publish cli.

---

## S3 — `[DO] session: add the /infra-kit:session command and extend the guards`

One PR. **Do not open until S2 is on npm.**

**Files**

| File                                                | Change                                    |
| --------------------------------------------------- | ----------------------------------------- |
| `plugins/infra-kit/commands/session.md`             | new                                       |
| `plugins/infra-kit/__tests__/manifest.test.mjs`     | `EXPECTED_COMMANDS`; widen `T1b` half two |
| `plugins/infra-kit/__tests__/publish-gate.test.mjs` | new row `G-A6`                            |
| `plugins/infra-kit/.claude-plugin/plugin.json`      | `0.3.0` → `0.4.0`                         |

### The command file

```
---
name: session
description: Switch this terminal's context — load a named environment through the infra-kit MCP server.
argument-hint: [--clear] [<environment>]
---

Read the MCP resource `infra-kit://workflow/session` and follow it exactly, treating $ARGUMENTS as the environment and flags the user asked for.
If that resource cannot be read — this session may expose no resource tools, or the server may predate it: it needs infra-kit 0.5.2 or newer — call `mcp__infra-kit__env-list` to see the environments, ask the user which one, and load the Doppler environment with `mcp__infra-kit__env-load`.
If the infra-kit MCP server is not connected in this session, say so and stop — do not improvise with the doppler CLI or by exporting variables in Bash.
```

The fallback line says **"load the Doppler environment"** deliberately. It is a Doppler-specific
miniature of the procedure, and naming its own scope is what makes it read as knowingly degraded
rather than silently stale once a second provider exists. `docs/session-context-orchestrator.md`
lists it as a thing to review at that point.

### Guard changes

- `EXPECTED_COMMANDS = ['release-create.md', 'session.md']` (U13). U14 and U17 then cover the new
  file automatically: U14 pins 3 frontmatter keys / `name: session` / exactly 3 non-empty body lines
  (`manifest.test.mjs:646`); U17 requires the `--clear` definition line in
  `resources/workflow/session.md` (`:662-700`).
- **`T1b` half two must be widened.** It currently hardcodes `release-create.md` (`:717-722`), so
  `session.md`'s fallback clause would be unguarded and the "T1 is scoped to skills, therefore a
  command may name an MCP tool" boundary would be proven for one file only. Loop
  `EXPECTED_COMMANDS`, asserting each body names an `mcp__infra-kit__` tool. Half one (the
  `walkFiles(SKILLS_DIR)` source read) is unchanged.
- **`G-A6`**: two _real_ command names, `published` below the session floor, `servedUris` holding
  only the release-create URI ⇒ exactly one violation, naming `session` and its missing URI.
  G-A1–G-A5 all use the fictional `release-deploy`; this is the first row covering a second real one.
- `plugin.json` bump is mandatory — `scripts/check-plugin-version-bump.mjs` (CI step U9) fails any
  PR that changes `plugins/**` without it.

### Acceptance criteria

1. The body contains the literal `it needs infra-kit 0.5.2 or newer` (the gate's regex is
   `/it needs infra-kit (\d+\.\d+\.\d+) or newer/`) and the literal `infra-kit://workflow/session`.
2. `node --test 'plugins/infra-kit/__tests__/*.test.mjs'` green.
3. `node scripts/check-workflow-resource-published.mjs` exits **0**.
4. `claude plugin validate ./plugins/infra-kit --strict --json` passes.
5. **Every new guard is seen red once.** Delete `session.md` → U13 reddens. Rename `--clear` in the
   `argument-hint` only → U17 reddens. Strip `mcp__infra-kit__env-load` from the command body → the
   widened T1b reddens. Point the body's URI at a slug the published CLI does not serve →
   `check-workflow-resource-published.mjs` exits non-zero naming `session`. Record all four.

---

## S4 — `[DO] session: prove the shell round trip in a real terminal`

The one claim no unit test can make. Nothing is committed by this ticket; its deliverable is a
transcript pasted into it.

**Method**

1. From an integrated zsh, confirm `echo $INFRA_KIT_SESSION` is non-empty and note the value.
2. Run `infra-kit env-token-list` and pick a config that **has a token** — otherwise the call fails
   for a reason unrelated to the mechanism and the failure is misread.
3. `stat -f %m "$XDG_CACHE_HOME/infra-kit/$INFRA_KIT_SESSION/env-load.sh"` (accept absence as 0).
4. Drive the **published** server with a scripted stdio client: `initialize` →
   `notifications/initialized` → `tools/call env-load {"config":"<chosen>"}`. A stdio MCP server
   answers nothing before the handshake, so the script must send all three frames;
   `scripts/check-workflow-resource-published.mjs:162-176` is a working template.
5. Re-`stat`. Return to that terminal and press Enter.

**Acceptance criteria**

1. The mtime advanced, and the new value is `>= $_INFRA_KIT_SHELL_STARTED` (readable interactively in
   that shell).
2. The terminal prints `infra-kit: auto-loaded vars for <config>` at the next prompt, and
   `infra-kit env-status` **typed there** reports the config.
3. The `filePath` the tool returned has `$INFRA_KIT_SESSION` as its penultimate path segment —
   PM-2's indicator, confirmed positive on the happy path.
4. **Negative control (loud):** in a shell with `INFRA_KIT_SESSION` unset, the same call fails with
   the exact string `INFRA_KIT_SESSION is not set` — the string C9 teaches the agent to translate.
5. **Tie probe (PM-4), run entirely through the scripted stdio client of step 4.** Issue
   `tools/call env-load`, then immediately `tools/call env-clear` — satisfying the confirm gate
   **programmatically**: round 1 with no `confirm`, read the `confirmToken` out of the
   `confirmation_required` payload, round 2 with identical args plus `"confirm": true` and that
   token. **No human approval may sit between the two calls.** On the shipped path the host's
   confirm prompt interposes seconds of human latency, which makes the tie unreproducible — a probe
   that keeps the human in the loop would report a false negative and close a verified permanent bug.

   Record `stat -f %m` for **both** `env-load.sh` and `env-clear.sh`. Then press Enter at the prompt.

   - **Mtimes equal** ⇒ the tie was exercised. The symptom being looked for is the appearance of
     `infra-kit: auto-loaded vars for <cfg>` after a clear, or silence with the env still loaded —
     _not_ the absence of `infra-kit: auto-cleared env`. If it reproduces, open the spin-off ticket
     below. Do not fix it inside this epic.
   - **Mtimes differ** ⇒ the tie was **not exercised**. Record the run as **untested**, not as
     passed, and re-run. The hazard is unaffected by a run that never created the condition.

**Spin-off (out of scope, opened by S4 if it reproduces):**
`[DO] shell: the precmd clear gate loses a same-second tie to the load gate` — `init.ts:822` gates
the load on `load_mtime >= clear_mtime` (**non-strict**) while `:828` gates the clear on
`clear_mtime > load_mtime` (**strict**), and `zstat +mtime` is integer seconds. Verified by reading
both lines.

### S4 run — 2026-09-14, infra-kit@0.5.6 (published, `~/Library/pnpm/bin/infra-kit`), hulyo-monorepo

Terminal: a fresh `zsh -i` in tmux with `INFRA_KIT_SESSION` unset at spawn so the rc minted one.
Client: a scripted stdio client (`initialize` → `notifications/initialized` → `tools/call`) with
`INFRA_KIT_SESSION=6389e2c0` in its env, cwd `hulyo-monorepo`. Config `arthur` — the shell had
already warm-loaded `dev` at prompt 0, so `dev` would not have distinguished the load from the cache.

```
$ echo "SESSION=$INFRA_KIT_SESSION STARTED=$_INFRA_KIT_SHELL_STARTED"
SESSION=6389e2c0 STARTED=1789376034
infra-kit: auto-loaded vars for dev                      ← warm cache at prompt 0, not the probe

# stdio client: tools/call env-load {"config":"arthur"}
pre  mtime: 1789376540
post mtime: 1789376580                                   ← advanced, and ≥ 1789376034
structuredContent.filePath = /Users/arthur/.cache/infra-kit/6389e2c0/env-load.sh
                                                         ← penultimate segment == INFRA_KIT_SESSION
# ⏎ in the tmux shell
infra-kit: auto-loaded vars for arthur
$ infra-kit env-status
  arthur: 61 of 61 vars loaded (manually loaded, project: hulyo, loadedAt: 2026-09-14T09:03:00, session: 6389e2c0)

# negative control: same call, INFRA_KIT_SESSION unset in the client env
isError: true, text: "INFRA_KIT_SESSION is not set. Run `infra-kit setup --skip-tools` then `source ~/.zshrc`."

# tie probe: env-load, then env-clear round 1 → confirmation_required + confirmToken,
# round 2 {confirm:true, confirmToken} — no human between the calls
env-clear.sh mtime: 1789376604
env-load.sh  mtime: (file absent)
# ⏎ in the tmux shell
infra-kit: auto-cleared env
$ infra-kit env-status
  Session 6389e2c0: no env loaded (cleared — auto-load suppressed until a new shell or explicit env-load)
```

**Verdict.** AC1–AC4 pass. AC5 has a third outcome the criteria did not list: the tie **cannot be
constructed** on the shipped path, because `env-clear` unlinks `env-load.sh` after writing the clear
file (`env-clear.ts:108`, deliberate — "so the next env-clear call correctly reports 'no env
loaded'"). The precmd then reads `load_mtime=0`, and `clear_mtime > 0` holds regardless of the
second. The strict/non-strict asymmetry (`init.ts:928/934` today; the plan above cites the older `:822/828`) is real but unreachable; the PM-4
spin-off is **not opened**.

**Finding, out of scope (D2 forbids touching `env-load` here) — spin-off:**
`[DO] env-load/env-clear: keep filePath off stdout when served over MCP`. Both tools
`process.stdout.write(filePath)` unconditionally (`env-load.ts:293`, `env-clear.ts:104`) — the line
the zsh wrapper captures. Over `infra-kit mcp` stdout **is** the JSON-RPC transport, so every call
emits one bare, non-JSON line between frames. The v1 SDK's `ReadBuffer` consumes the line and routes
it to `onerror`, so Claude Code works by tolerance, and a strict client (or a v2 host that treats
transport errors as fatal) would not. Verified: the probe printed
`/Users/arthur/.cache/infra-kit/6389e2c0/env-load.sh` as a non-JSON stdout line on every call.

---

# 2. Non-goals

- **No new MCP tool, and no change to `env-load`, `env-list`, `env-status` or `env-clear`** — not
  their schemas, descriptions or handlers. This is the user's own binding constraint, not an
  inference.
- **No `--status` flag.** See Q2 — deferred with a recorded reason, not forgotten.
- **No workspace → provider-list mapping in config.** Not `infra-kit.json`, not `infra-kit.config.ts`.
- **No AWS SSO, AWS profile or kubectl context.** The seam is documented; nothing is implemented.
- **No MCP elicitation**, and no new server capability declaration.
- **No `session` prompt registration.** Resource-only.
- **No relaxation of U14's exactly-three-lines rule.** The design fits inside it.
- **No fix for the `precmd` mtime tie.** Pre-existing, surfaced by S4, spun off.
- **No root `pnpm run qa`, and no change to `vendor/`.** `vendor check` runs first in the root gate
  and is red on HEAD for reasons predating this work; per-package checks plus `plugin-ci.yml` are
  this epic's gate.

---

# 3. Decisions and open questions

**Settled — stated so they are not re-litigated:**

- **Name: `session`.** It is the user's own word, it is already this repo's word for a terminal
  (`INFRA_KIT_SESSION`), and it survives provider two — `env` names the one provider and would force
  a rename, `workspace` collides with pnpm-workspace vocabulary in this very repo. Expensive to
  reverse after S2 publishes (new URI, new floor, another publish), which is why it is called out.
- **Version: `0.5.2`.** A patch on the existing line, chosen by the repo owner over the `0.6.0` this
  plan first proposed. The reasoning that survives either way: the number is a user-visible promise
  because S3's floor sentence quotes it, so it must be decided before S2 publishes, not after.

**Open — each genuinely changes the work:**

**Q2 — does `--status` ship later, and in what form?**
It is cut because it is a surface this plan has _proven_ wrong: `env-status.ts:38-42` reads the
**calling process's** `process.env`, and `:43` gates the only file-based evidence
(`parseVarNamesFromEnvFile`) behind that same value — so over MCP it cannot fall back to the cache
file. From a Claude Code launched out of a clean shell it reports "no env loaded"; from one launched
out of a shell that had already auto-loaded it reports the **stale** config. Either way it can
contradict a load made moments earlier.
_Recommendation: defer, and when it returns, choose between three options, not two_ — (a) ship it
with the caveat documented, (b) leave it out permanently and point at `infra-kit env-status` typed in
the terminal, or (c) an honest status that never calls `env-status`: a read-only `stat` on the
`filePath` `env-load` returned plus a variable-**name** count (`grep -c`). Never `cat` —
`env-load.sh` holds single-quoted secret values.

**Q3 — does a `session` workspace map ship, and when?**
_Recommendation: not now._ With one provider it is `name → name`. `infraKitConfigObject` is
`.strict()` (`infra-kit-config.ts:224-236`), so a new key is a published-release dependency for every
consumer repo and a repo adopting it against an older CLI is refused outright. Ship it with provider
two, in `infra-kit.json`; the recipe is in `docs/session-context-orchestrator.md`.

**Q5 — do you want to revisit MCP elicitation?**
Only if you withdraw the no-change constraint on `env-load`. Elicitation is a branch inside
`env-load` plus a new server capability — precisely the change ruled out in the source conversation.
Cost if withdrawn: one probe of whether Claude Code answers `elicitation/create`, plus reopening
Axis C before S1 is written.
_Recommendation: leave closed._

---

---

# Appendix A — derivation

## A.1 Principles

1. **The command file cannot hold the procedure.** U14 pins a command body to exactly 3 non-empty
   lines (`manifest.test.mjs:641-646`) and the publish gate makes any command lacking a served
   `infra-kit://workflow/<slug>` URI a violation (`check-workflow-resource-published.mjs:86`).
   Together those two leave the CLI as the only place a procedure of this size can live and be
   versioned. **That constraint selects the shape** — not a claim about encapsulation.
2. **Compose, never replace.** `env-load`, `env-list`, `env-status`, `env-clear` keep working
   standalone and are not touched. `session` knows who to call and in what order.
3. **One entry point, extensible by insertion.** The name and the body are shaped so a second
   provider is an insertion, not a second command.
4. **Honesty about the shell boundary — applied to all three faces.** The command changes the
   _user's terminal_, not Claude Code's shell; at a later _moment_; in one specific _destination_.
   Timing, destination and the Bash lie are held to the same standard.

## A.2 Decision drivers

| #   | Driver                                                                                                                                                                                                                                  | Consequence                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The publish gate is a hard ordering constraint (`:59`, `:80`, `:86` + the `plugin-ci.yml` PM-C step). Published == local == `0.5.1`.                                                                                                    | CLI publishes before the command may merge. Two PRs and one release, minimum.                                                                                       |
| D2  | `env-load` must not change — the user's own words.                                                                                                                                                                                      | The orchestration is _text an agent executes_, not code. A resource is the only agent-reachable channel: an agent can read a resource, but cannot fetch a prompt.   |
| D3  | The shell round trip is real but conditional. `constants/constants.ts:123-133` throws without `INFRA_KIT_SESSION`; `init.ts:812-837` installs an mtime-comparing `precmd` sourcer, registered only when `_INFRA_KIT_SHELL_STARTED > 0`. | The mechanism, its preconditions, its timing and its destination must all be in the body, or the first user whose shell block is missing judges the feature broken. |

## A.3 Axes

**Axis A — how much orchestrator ships.** **A1 chosen:** Doppler-only, identity mapping, seam in
`docs/`. A2 (`session.workspaces` in `infra-kit.json`) deferred on `.strict()` — see Q3. A3 (a
provider registry in code) is a new tool in all but name; D2 invalidates it.

**Axis B — where a workspace map lives when it ships.** **B1:** `infra-kit.json`, next to
`envAutoLoad`. **B2** `infra-kit.config.ts` is invalidated on evidence: it holds audit rules only and
is read by nothing at session time.

**Axis C — picker mechanism.** **C1 chosen:** host-side `AskUserQuestion`, driven by the procedure.
Zero CLI change; degrades to a prose question; matches this repo's host-side confirm gates.
**C2 (MCP elicitation) invalidated on evidence, not on framing.** In the source conversation the user
asked whether the design changes his existing env-load MCP call and accepted the answer that his
current env-load tool must not change at all. Elicitation is a branch inside `env-load` plus a new
capability declaration — the change he excluded by name; his later statement supersedes the earlier
proposal. Reopening is Q5, not a phase-0 ticket.
**C3 (the TTY picker in `envLoad`) invalidated by two independent locks:**
`withEscape(..., { whenHeadless: 'unreachable' })` at `env-load.ts:264-280`, and non-optional
`config: z.string()` at `:535-538`.

**Axis D — name.** `session` chosen; see §3.

**Axis E — flag set.** **E1 chosen: `[--clear] [<environment>]`.** `--clear` earns its place: it is
the `deactivate` half of the contract the user named himself, and without it he is back to two
commands. **E2 (`--status`) cut** — see Q2; shipping a flag whose documented semantics are "this may
lie to you" is worse than not shipping it, and the asymmetry argument used to defer `--list` applies
_a fortiori_ to a flag with a proven defect. **E3 (`--list`) deferred** — the no-argument path
already renders that table, and `env-list` is a local union, so a dedicated flag over-advertises its
authority. Cheap to add (one hint edit, one body line); expensive to remove (a floor bump).

## A.4 Pre-mortem

**PM-1 — "It says loaded, but my shell has nothing." (loud)**
Claude Code launched from a terminal whose zsh block was never installed, or with no
`INFRA_KIT_SESSION`.
_Leading indicator:_ the literal `INFRA_KIT_SESSION is not set` in a transcript.
_Mitigation:_ body §2 (clauses C4, C8, C9, C10, C11, C21); S4's negative control asserts the exact
string.

**PM-2 — the load lands in a terminal nobody is looking at. (silent)**
Claude Code launched from terminal A while the human types in terminal B; or a long-lived server
whose captured `INFRA_KIT_SESSION` no longer matches any live shell (tab closed, `--resume` across a
reboot). `env-load` writes into a dead directory and returns `{ project, config, variableCount }`
that looks exactly like success. Same root cause as Q2's staleness, applied to the _load_ path.
_Leading indicator (manufactured by the mitigation):_ the session id in the reported `filePath`
differs from `echo $INFRA_KIT_SESSION` at the user's own prompt. The comparison is **human-performed
and unenforced** — what the plan guarantees is that the body carries the instruction (C7 + C7b),
never that an agent obeyed it.
_Mitigation:_ clauses C5, C6, C7, C7b; S4 acceptance criterion 3 confirms the indicator on the happy
path; S1 AC8's second mutation keeps C6 honest.

**PM-3 — the command never ships and `session` is a published resource nobody can reach.**
Not hypothetical: `infra-kit://workflow/setup` is exactly that today (§1.2).
_Leading indicator:_ S2 merged, S3 not opened within one release cycle.
_Mitigation, structural rather than documentary:_ the epic's completion condition is **S3 merged**
(§1.2), and `setup` is cited there as the precedent being broken rather than as reassurance.

**PM-4 — `--clear` succeeds and the terminal loads the env anyway. (silent, permanent)**
Verified at both lines. `init.ts:822` gates the load on
`load_mtime > _INFRA_KIT_LAST_LOAD_MTIME && load_mtime >= _INFRA_KIT_SHELL_STARTED && load_mtime >= clear_mtime`
— **non-strict** against `clear_mtime`. `init.ts:828` gates the clear on
`clear_mtime > _INFRA_KIT_LAST_CLEAR_MTIME && clear_mtime >= _INFRA_KIT_SHELL_STARTED && clear_mtime > load_mtime`
— **strict**. `zstat +mtime` is integer seconds, and `precmd` cannot fire while Claude Code holds the
foreground, so a scripted load-then-clear normally lands _both_ files before the next prompt. At
mtime tie `T`:

- load gate → `T > 0 && T >= start && T >= T` → **true**: sources the load and prints
  `infra-kit: auto-loaded vars for <cfg>`;
- clear gate → `T > T` → **false**, and `_INFRA_KIT_LAST_CLEAR_MTIME` is never advanced, so every
  later `precmd` re-evaluates the same false comparison.

The user asked to clear and the terminal announces a load. (Variant: if a `precmd` happened to fire
between the two writes, `_INFRA_KIT_LAST_LOAD_MTIME` is already `T`, both gates are false, and the
env simply stays loaded with no notice at all.) Recovery exists but is not discoverable: another
`env-clear` at `T+1` has `clear_mtime > load_mtime` and fires.
_Frequency:_ rare on the shipped path, where the confirm gate puts human latency between the two
writes; common in scripted or back-to-back use. Body §6 says so, and S4 AC5 bypasses the approval
programmatically for exactly that reason.
_Leading indicator:_ an `auto-loaded` notice immediately after a `--clear`.
_Mitigation:_ body §6 (clauses C18, C19) tells the agent to have the human confirm at the prompt and
names the re-run as the recovery; S4 AC5 probes it and distinguishes "not exercised" from "passed";
the fix is spun off as its own `[DO]` ticket against the zsh block, because it is a pre-existing bug
this epic surfaced.

## A.5 Test plan

**Unit — `plugins/infra-kit/__tests__/manifest.test.mjs`.** U13 literal gains `session.md`. U14
inherits: 3 frontmatter keys, `name: session`, exactly 3 non-empty body lines. U17 inherits: the
`--clear` definition line must exist in `resources/workflow/session.md` carrying both `` `--clear ``
and `→`. T1b half two widened to loop `EXPECTED_COMMANDS`. Gap G-U6 (U6/U12 not walking `commands/`)
is unchanged and not this epic's to close.

**Unit — `plugins/infra-kit/__tests__/publish-gate.test.mjs`.** New row `G-A6` (see S3).

**Integration — `apps/infra-kit/cli/src/mcp/__tests__/server.test.ts`.** Resource identity
(byte-equality with `WORKFLOW_BODIES.session` — the drift `registerWorkflow` exists to prevent) and
rendered shape (line count, no trailing newline, one `toContain` per clause). The exactly-one-prompt
assertion at `:131-146` is untouched and is itself a guard on this work.

**E2E.** The publish gate in both directions — a violation naming `session` before S2, `OK` after.
And S4's real terminal, which is the only test that can prove PM-1, PM-2 and PM-4 at all.

**Every new guard is seen red once**, on both sides of the epic: S1 AC8's two mutations (C4 and C6),
S1 AC6's free RED against the current bundle, and S3 AC5's four mutations.

**Observability.** No new telemetry; the body names the surfaces that already exist — the returned
`filePath` (its mtime is the audit trail, its session-id segment is PM-2's indicator), the
`infra-kit: auto-loaded vars for <config>` / `infra-kit: auto-cleared env` stderr notices the
`precmd` hook prints, and `infra-kit env-status` typed in the terminal as the authoritative reading.

---

# Appendix B — ADR

**Ships as `docs/session-context-orchestrator.md`** (S1). This appendix is the draft; the durable
copy is that file, so the rejected-alternatives list is maintained in one place, not two.

**Status.** Proposed, pending approval.

**Decision.** Ship `/infra-kit:session` as a three-line plugin command that defers to a new MCP
_resource_, `infra-kit://workflow/session`, authored in the CLI at
`apps/infra-kit/cli/resources/workflow/session.md`. It composes `env-list`, `env-load` and
`env-clear`, asks the human with host-side `AskUserQuestion` when no environment is given, and
carries one flag, `--clear`. No MCP tool is added or modified.

**Drivers.** D1 the publish gate forces CLI-then-plugin; D2 the user's binding constraint that
`env-load` must not change; D3 the shell round trip is real but conditional, so its mechanism must
live where an agent will read it.

**Alternatives considered.** A new `session` MCP tool with a provider registry (D2). MCP elicitation
(excluded by name; Q5 reopens it if the constraint is withdrawn). Branching in the command body
(U14's three-line rule refuses it, and it is the option rejected in the source conversation). A
workspace map in config now (`.strict()` makes it a consumer-wide migration for a `name → name`
identity). Naming it `env` or `workspace`. Shipping `--status` (proven to be able to contradict a
load; Q2).

**Why chosen.** It is the only shape the two gates leave open — a command must name a served workflow
URI, and a command body must be three lines — while honouring the constraint that `env-load` does not
change. Every alternative fails one of those two, or was excluded by the user himself.

**Consequences.**

- Two PRs and one npm publish between approval and a usable command. The gate makes that
  non-negotiable, and §1.2 makes the second PR the completion condition rather than an optional
  follow-up.
- **Nothing enforces that an agent follows the resource.** `server.test.ts` proves the sentences
  exist; it cannot prove they were obeyed. The resource buys versioning and a length budget larger
  than three lines. It does not buy a boundary, and this plan does not claim one.
- The command's fallback line is a Doppler-specific miniature of the procedure. That duplication is
  deliberate and bounded by U14; it is scoped in its own words ("load the Doppler environment") so it
  reads as degraded rather than stale after provider two, and the docs list it for review then.
- `--status` is not shipped, so the terminal-typed `infra-kit env-status` is the only reading of what
  a shell holds. That was always the authoritative one.
- Renaming the command after S2 costs a new URI, a new floor and another publish.

**Follow-ups.** Q2 (`--status`, three options). Q3 + provider two (the workspace map). Q5
(elicitation, only if the `env-load` constraint is withdrawn). The `precmd` mtime-tie fix (S4's
spin-off). Closing gap G-U6 so U6/U12 walk `commands/`.
