# `~/.zshenv` session-env block — plan

**Status: approved 2026-09-14 (ralplan consensus, 3 iterations); S1–S3 implemented the same day. S4 — the published-CLI proof — waits for the release that carries them (0.7.1 or later); a hermetic run of the block through the real Claude Code Bash tool (scratch `ZDOTDIR`, built body) is recorded under S4.**

Read §0 for the decision, §1 for scope. The derivation is Appendix A; the ADR is Appendix B. This
plan extends `docs/session-command-plan.md` — same vocabulary, same session-file mechanics, and it
reuses that plan's S4 method for its own real-terminal proof.

---

# 0. Summary (RALPLAN-DR)

## 0.1 The problem, measured

`/infra-kit:session <env>` → MCP `env-load` writes
`${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION/env-load.sh`
(`constants.ts:216-233`, `env-load.ts:212`). Only the **interactive** terminal picks it up, through
the `precmd` hook in the `~/.zshrc` block `infra-kit setup` installs (`init.ts:918-943`). Claude
Code's `Bash` tool spawns `/bin/zsh` as a **login, non-interactive** shell that inherits
`INFRA_KIT_SESSION` from the launching terminal and never reads `~/.zshrc`. Probed on this machine,
2026-09-14, from inside the Bash tool itself:

```
login=y inter=n SHELL=/bin/zsh ZSH_VERSION=5.9 session=[dd44f64a] cfg=[] ppid_cmd=/Users/arthur/.local/bin/claude
```

`session` is set, `INFRA_KIT_ENV_CONFIG` is empty, the parent is `claude` directly. Every command the
agent runs after a load is blind to it; `source`-ing the file by hand inside one call yields the
variables for that call only. Neither `~/.zshenv` nor `/etc/zshenv` exists on this machine today;
`/etc/zprofile` (Apple's `path_helper`) does.

**Goal.** After `/infra-kit:session arthur`, every command the agent runs in that Claude Code session
_and_ the terminal after Claude Code exits both see the loaded env; `--clear` takes effect for the
agent's next command with no further step.

## 0.2 Principles

1. **One artifact, all descendants.** The signal is already on disk and keyed by a value every
   descendant inherits. The fix reads it at the one point every zsh passes through — `.zshenv` — and
   nowhere else. No second signal, no host-specific plumbing.
2. **Cheap enough to run on every zsh on the box.** Pure zsh, no `zmodload`, no node spawn, no
   `sched`, no output of its own. Measured on the final body (A.6): 200 `zsh -c :` spawns cost
   0.82 s with the block against 0.75 s without — ≈0.35 ms each.
3. **Prints nothing of its own.** A non-interactive zsh's stderr is somebody's tool output. The block
   emits no notice, ever; notification stays the `precmd` hook's job, where a human is reading. A
   broken `env-load.sh`'s own `source` error is deliberately **not** silenced — that is PM-2, and
   hiding it would leave a half-loaded env with no symptom.
4. **Same words as the `.zshrc` block.** Same markers, same writer, same doctor shape, same
   remediation string (`infra-kit setup --skip-tools`). A second convention is a second thing to get
   wrong.
5. **Compose with the session-file protocol as it is.** `env-load`/`env-clear` are not touched (the
   prior plan's D2 still binds). The block reads what they already write, with the same
   load-wins-ties rule the `precmd` gate uses.

## 0.3 Decision drivers

| #   | Driver                                                                                                                                                                                                                                           | Consequence                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The Bash tool is a fresh **login, non-interactive** zsh per call (probe above). `.zshenv` is the only user startup file every zsh reads (`zsh -c`, `zsh -lc`, `zsh -ic`; skipped only by `zsh -f`). Verified with a scratch `ZDOTDIR` — see A.6. | `.zshenv` is the mechanism. `.zprofile` is login-only, `.zshrc` interactive-only; neither covers `zsh script.sh` or a tool's `zsh -c`. |
| D2  | `INFRA_KIT_SESSION` is minted in `.zshrc` (`init.ts:883-885`), which runs **after** `.zshenv`. A brand-new terminal has no session at `.zshenv` time.                                                                                            | The block is a no-op without a session, by its first line. It fires only in descendants that inherited one.                            |
| D3  | The user's instruction fixes the mechanism (a managed `.zshenv` block via the existing marker/upsert machinery) and asks that alternatives be listed, not re-litigated.                                                                          | §0.4 lists them fairly and invalidates each on evidence; the tickets plan (A) only.                                                    |

## 0.4 Options

**(A) — a second managed block in `~/.zshenv`, installed by `infra-kit setup`. CHOSEN.**
Pros: covers the Bash tool, `zsh script.sh`, the infra-kit session shell's children, tmux windows —
every zsh that inherited a session; one writer (`upsertManagedBlock`, `managed-block.ts:116-136`),
one doctor shape (`doctor.ts:160-192`), ~13 lines of zsh; `--clear` needs nothing extra because
`env-clear` already unlinks `env-load.sh` (`env-clear.ts:104`) and writes an `unset` list the block
can source for inherited vars. Cons: runs on every zsh on the box (bounded — P2); widens the
_moment_ at which descendants see secrets (A.4 PM-1 measures how much); zsh-only, like everything
else in the shell integration (`init.ts:303-317` already warns non-zsh users).

**(B) — a Claude Code hook.** Two real mechanisms, checked against the hooks reference on 2026-09-14:
`SessionStart` hooks may append `export` lines to `$CLAUDE_ENV_FILE`, which later Bash calls source;
`PreToolUse` hooks may return `updatedInput` and rewrite a Bash `command`. Honest assessment: the
first fires only on `startup|resume|clear|compact|fork`, never on an MCP tool call, so a load made
mid-session cannot reach it until the next `/clear` — it does not meet the goal. The second can
prefix `source <file>;` to every Bash command and would work — but only for Claude Code (not
`zsh script.sh`, not the session shell), only when the hook is installed in the host's settings or
the plugin's `hooks/hooks.json`, and it rewrites the input shown at every permission prompt.
**Invalidated** as the primary mechanism: it is narrower on the axis that matters (every zsh the
terminal spawns) and wider on one that does not matter today (a non-zsh `$SHELL`), at a higher
coupling cost. Recorded as the right complement _if_ a non-zsh `$SHELL` user ever appears — and, per
the Architect's antithesis in Appendix B, as a live Claude-Code-scoped alternative rather than a
dead one.

**(C) — the `session` procedure tells the agent to prefix every Bash call with `source …`.**
**Rejected.** Unenforceable (the prior plan's own words: a body proves a sentence exists, never that
it was obeyed); leaks the cache path into every command; forgotten by subagents and by any tool that
is not Bash; and it contradicts C8/C21 of the shipped body (`resources/workflow/session.md:34-36`),
which teach the agent that a `source` in Bash is _not_ a substitute.

**(D) — `~/.zprofile`.** Read by login shells only. The Bash tool _is_ a login shell today, so (D)
would pass the headline probe — and fail `zsh script.sh`, a tool's `zsh -c`, and any host that drops
`-l`. It also runs after `/etc/zprofile` and before `.zshrc`, so it buys nothing for the interactive
terminal that (A) does not. **Invalidated**: strictly narrower coverage for the same cost, resting on
a host detail (`-l`) nobody here controls.

Only (A) remains.

---

# 1. The epic

## `[DO] epic: session env reaches every zsh the terminal spawns`

**Outcome.** `infra-kit setup` (and `setup --skip-tools`) installs a second managed block, in
`~/.zshenv`, between the same `# -- infra-kit:begin --` / `# -- infra-kit:end --` markers
(`init.ts:33-34`). The block sources the session's `env-load.sh` — or, when the load has been
cleared, its `env-clear.sh` — into every zsh that inherited `INFRA_KIT_SESSION`. `doctor` reports the
block's presence and freshness as one row; `setup` reports the step over MCP. Nothing about
`env-load`, `env-clear`, or the `.zshrc` block changes.

### 1.1 What the user actually sees

```
❯ /infra-kit:session arthur
  Loaded arthur — 61 variables, Doppler project hulyo. Session dd44f64a.

❯ (agent runs `infra-kit env-status` through Bash)
  arthur: 61 of 61 vars loaded (manually loaded, project: hulyo, …, session: dd44f64a)

❯ /infra-kit:session --clear
  [host confirmation] … Cleared.

❯ (agent runs `echo ${INFRA_KIT_ENV_CONFIG:-unset}` through Bash)
  unset

❯ (user quits Claude Code, presses ⏎)
infra-kit: auto-cleared env
```

The last line is the existing `precmd` hook (`init.ts:934-938`), unchanged. Nothing new prints.

### 1.2 The block

The exact body `buildZshenvBody()` returns. Verified line-for-line with a scratch `ZDOTDIR` against
the cases in A.6; every line below is load-bearing.

```zsh
# Inherit this terminal's infra-kit session env into every zsh it spawns, interactive or not.
# A fresh terminal has no session yet (it is minted in .zshrc, after this file) and skips.
# Only the canonical 8-hex id .zshrc mints is honoured. Load wins a tie with clear, as the
# .zshrc precmd gate does. Prints nothing of its own.
if [[ -n "${INFRA_KIT_SESSION:-}" ]]; then
  () {
    emulate -L zsh -o extendedglob
    [[ "${INFRA_KIT_SESSION:-}" == [0-9a-f](#c8) ]] || return
    local _ik_dir="${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION"
    local _ik_load="$_ik_dir/env-load.sh" _ik_clear="$_ik_dir/env-clear.sh"
    if [[ -r "$_ik_load" && ! "$_ik_clear" -nt "$_ik_load" ]]; then
      source "$_ik_load"
    elif [[ -r "$_ik_clear" ]]; then
      source "$_ik_clear"
    fi
  }
fi
```

Why each choice:

- **Anonymous function** (`() { … }`): gives `local` a scope and leaves no name behind. The `.zshrc`
  block's `_infra_kit_autoload` needs a name because a hook calls it later; nothing calls this twice.
- **`emulate -L zsh -o extendedglob`, first line.** Two jobs. (1) `-L` makes every option change
  local to the function, so the `set -a` inside a sourced file is undone at return **even when the
  file never reaches its `set +a`** — a parse error mid-file (`FOO='x` unterminated) otherwise leaves
  `allexport` ON in the surviving shell, and every later assignment in that shell leaks to its
  children. Probed both ways (A.6 cases 11/11b): with the line, `allexport=0` afterwards and a
  variable assigned after the block is invisible to a `/bin/sh` child; without it, `allexport=1` and
  the child sees it. Variables the file did assign are already exported by then, so a good file still
  reaches children (A.6 case 12). (2) `-L zsh` also resets a user's `setopt` choices for the
  function's duration — `nounset`, `ksharrays`, `shwordsplit` — so the body reads the same on every
  machine. `-o extendedglob` is on the same line because `emulate -L zsh` **turns extendedglob off**,
  and the id guard below needs it.
- **The id guard.** `[[ "${INFRA_KIT_SESSION:-}" == [0-9a-f](#c8) ]] || return` honours exactly
  what the `.zshrc` block mints — `head -c 4 /dev/urandom | xxd -p` (`init.ts:884`), eight lowercase
  hex digits — and nothing else. It closes a same-uid hygiene hole (a value like `../../evil` would
  otherwise resolve `$_ik_dir` outside the cache root — reproduced, A.6 case 10b) and refuses any
  hand-set or foreign value. It is **not** a security boundary: the file is `0600` in a `0700` dir
  (`env-load.ts:219-220`), and anyone who can set your environment can already do worse. The
  contract it states is: **the block honours only the canonical id; a session id of any other shape
  is treated as no session.** Two separate facts about the pattern. First, `(#c8)` is an
  `extendedglob` flag: under bare `emulate -L zsh` that option is **off**, the count is not parsed as
  a flag, the match never succeeds, and the block becomes a permanent no-op with every string test
  green — `[0-9a-f](#c8)` and `[[:xdigit:]](#c8)` fail identically there (reproduced, A.6 cases 6
  and 6'). That is why `-o extendedglob` sits on the `emulate` line. Second, `[0-9a-f]` is preferred
  over `[[:xdigit:]]` because it refuses **uppercase** — `xxd -p` emits lowercase only, and
  `ABCD1234` is not an id this box ever minted (A.6 row 8). The outer `if [[ -n … ]]` is a cheap
  early exit and nothing more: Z10 already refuses an empty id, so the outer line has no observable
  behaviour of its own (A.6 row 10c'). `${…:-}` on both guards because `setopt nounset` set above the
  block (a user's own `.zshenv`) otherwise prints `parameter not set` on every sessionless zsh (A.6
  case 5b).
- **`_ik_`-prefixed locals.** A Doppler key named `dir`, `load` or `clear` — all plausible — would
  otherwise be assigned into the function's `local` and vanish at return. Probed: with the prefix a
  load file carrying `dir='D' load='L' clear='C'` delivers all three (A.6 case 1).
- **`-nt`, not `zstat`.** `[[ a -nt b ]]` is a `[[` primitive — no `zmodload zsh/stat`, which the
  `.zshrc` block needs only because it compares against remembered mtimes (`init.ts:926-927`).
  `! clear -nt load` is `load ≥ clear`: the same rule for whole-second ties as `init.ts:928`
  (`load_mtime >= clear_mtime`); `-nt` also resolves sub-second order, which `zstat +mtime`
  (integer seconds) cannot see — the one place the two readers can disagree is PM-6. When `$clear`
  is absent `-nt` is false, so the load branch runs.
- **Why source the clear file at all.** A descendant can inherit _already-exported_ vars: the
  terminal `precmd`-sourced a load before Claude Code launched, Claude Code inherited them, every
  Bash-tool zsh inherits them again. Removing `env-load.sh` (`env-clear.ts:104`) does not unset an
  inherited variable — only sourcing the `unset` list `buildEnvClearLines` writes does
  (`env-clear.ts:58-71`). Verified: case 2 in A.6 — inherited `FOO=inherited` becomes empty. The
  same file also exports `INFRA_KIT_ENV_CLEARED=1` (`:69`), which `env-autoload.ts:387` reads into
  `env.cleared` — the child ends up in exactly the state the terminal will be in at its next prompt.
  **Intended consequence:** a `.zshenv`-primed child that runs a cli-invocation auto-load hits the
  `env.cleared` skip (`env-autoload.ts:176`) after a clear, or the manual-load skip (`:179`) after a
  load, and spawns no Doppler fetch — the same short-circuits the interactive terminal gets.
- **No `_INFRA_KIT_LAST_*` writes, no `_INFRA_KIT_SHELL_STARTED` gate.** See §3, Settled.
- **`-r`, not `-f`**: an unreadable load file (mode `000`, another uid) falls through to the clear
  branch instead of printing a permission error into tool output (A.6 case 7).
- **No `print`, no `echo`, no `zle`**: P3. The only bytes the block can ever emit are a sourced
  file's own errors, and those are PM-2's leading indicator, kept on purpose.

### 1.3 Who inherits it — the widened scope, named

`INFRA_KIT_SESSION` is exported by the `.zshrc` block (`init.ts:884`), so **every** process the
terminal starts carries it. The block, however, runs only where `.zshenv` is read — **zsh** — so the
set that newly sees the env is: Claude Code's Bash tool; `zsh script.sh` / `#!/bin/zsh` scripts run
from that terminal; the infra-kit session shell's children; `zsh` typed at the prompt; tmux windows
of a server that inherited the session; an editor launched from that terminal (`code .`) whose
integrated terminal is zsh. **Not** affected, verified: `/bin/sh` (case "sh -c" in A.6 — the shell
node's `child_process.exec`, pnpm scripts and turbo use), bash, fish, `zsh -f`, `sudo`
(`env_reset` drops `INFRA_KIT_SESSION`), `ssh`, apps launched from the Dock.

What descendants now see is every file the session directory can hold: a manual `env-load`, a
`/infra-kit:session` load over MCP, **and the shell-startup auto-load** (`envAutoLoad.trigger:
"shell-startup"`, spawned at `init.ts:1022` and written to the same `env-load.sh` path) — the warm
cache's project-scoped copy under `projects/<key>/` is _not_ read by the block, only the session file
the refresh writes.

The honest measure of the widening (A.4 PM-1). Descendants of a process that started **after** the
terminal's `precmd` sourced a load already inherit the secrets through the environment — sh, node,
everything — so for them the block changes only _when_ (from the file landing instead of the next
prompt). The **new principals** are the zsh children of long-lived processes that **predate** the
load: Claude Code itself, a tmux server, an editor — processes whose own environment was frozen
before `env-load.sh` existed and whose children, until now, could never see it. That set is not a
side effect; it is the headline case (§0.1) itself, and the clear branch is what takes it back out.

### 1.4 Completion condition

The epic closes when S4's transcript shows a Bash-tool call reading the loaded config and, after
`--clear`, reading nothing — in a real Claude Code session against the **published** CLI. S1–S3 are
the code; S4 is the claim.

---

## S1 — `[DO] setup: install the ~/.zshenv session-env block`

One PR. `init` + `setup`, because `InitStepName` (`init.ts:40-49`) and the duplicated
`initStepSchema` enum (`setup.ts:282-296`) must change together — `setup`'s MCP payload is typed by
the enum, so a step name the enum lacks fails `ts-check` before it fails a test.

**Files**

| File                                                                        | Change                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/infra-kit/cli/src/commands/init/init.ts`                              | `InitStepName` gains `'zshenv'` (after `'zshrc'`, `:49`); new `buildZshenvBody()` / `buildZshenvBlock()` beside `buildShellBody`/`buildShellBlock` (`:875`, `:1041`); new `writeZshenvBlock()` beside `writeShellBlock` (`:259-279`); `initCore` records it right after the `zshrc` step (`:172-174`). `SHELL_ACTIVATION_REMINDER` (`:121`) unchanged. |
| `apps/infra-kit/cli/src/commands/init/index.ts`                             | export the two new builders (doctor imports them)                                                                                                                                                                                                                                                                                                      |
| `apps/infra-kit/cli/src/commands/setup/setup.ts`                            | `initStepSchema` enum gains `'zshenv'` after `'zshrc'` (`:284`); the tool description (`:359`) says "into .zshrc and the session-env block into .zshenv"                                                                                                                                                                                               |
| `apps/infra-kit/cli/resources/workflow/setup.md`                            | step list (`:26`) gains item "the managed block in `~/.zshenv` — the session-env inheritance"; `server.test.ts:196` line-count pin `163` → new count                                                                                                                                                                                                   |
| `apps/infra-kit/cli/src/commands/init/__tests__/zshenv-body.test.ts`        | new — string guards on the body                                                                                                                                                                                                                                                                                                                        |
| `apps/infra-kit/cli/src/commands/init/__tests__/init-zshenv-write.test.ts`  | new — mirrors `init-zshrc-write.test.ts` (same mocks, same `os.homedir` spy at `:45`)                                                                                                                                                                                                                                                                  |
| `apps/infra-kit/cli/src/commands/init/__tests__/zshenv-inherit.test.ts`     | new — real `/bin/zsh -c` against a scratch `ZDOTDIR` (the integration proof, A.5)                                                                                                                                                                                                                                                                      |
| `apps/infra-kit/cli/src/commands/setup/__tests__/setup-init-report.test.ts` | step set (`:119-131`) gains `'zshenv'`; a `toContainEqual` sibling of `:133-136`; a `.zshenv` sibling of the marker read at `:143`                                                                                                                                                                                                                     |

### The writer

`writeZshenvBlock()` is `writeShellBlock` (`init.ts:259-279`) with three deliberate differences:

1. **No `removeExistingBlock`.** That function exists for the `.zshrc` block's two legacy formats
   (`init.ts:838-869`); `.zshenv` has never carried an infra-kit block, so there is nothing legacy to
   strip. `upsertManagedBlock` alone.
2. **Default placement (`replace-in-place`), not `append-end`.** First install appends at
   end-of-file (`managed-block.ts:132-135`) — so a user's own `export XDG_CACHE_HOME=…` above it is
   honoured; later runs replace in place (`:126-130`) and preserve whatever order the user chose.
   The `.zshrc` block uses `append-end` because its legacy strip already moved it; that reason does
   not apply here.
3. **Entry:** `{ step: 'zshenv', outcome: 'written', message: 'Added infra-kit session-env block to
<path>', level: 'info' }`.

`initCore` order: `zshrc` → **`zshenv`** → `migrations` → … . The closing `shell` entries
(`init.ts:306-324`) are unchanged: the reminder `Run \`source ~/.zshrc\` or open a new terminal to
activate.`stays word-for-word, because it is still true for the interactive shell's functions and
is pinned at`setup-init-report.test.ts:172`and`program`tests.`.zshenv` needs no activation
step — the next zsh spawned reads it; the sentence's "open a new terminal" already covers that.

### The literal clauses

Guards `zshenv-body.test.ts` asserts on `buildZshenvBody()`, each on one authored line of the body:

| #   | Exact literal                                                                           | Guards                                                                                                                      |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Z1  | `if [[ -n "${INFRA_KIT_SESSION:-}" ]]; then`                                            | no-op in a fresh terminal (D2); `:-` survives `nounset`                                                                     |
| Z2  | `${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION`                          | same path as `getCacheRoot` (`constants.ts:216-221`)                                                                        |
| Z3  | `[[ -r "$_ik_load" && ! "$_ik_clear" -nt "$_ik_load" ]]`                                | load wins ties; unreadable falls through                                                                                    |
| Z4  | `elif [[ -r "$_ik_clear" ]]; then`                                                      | clear reaches inherited vars                                                                                                |
| Z5  | body contains no `print`, no `echo`, no `zle`                                           | P3                                                                                                                          |
| Z6  | body contains no `zmodload`, no `sched`, no `add-zsh-hook`, no `infra-kit`, no `pnpm`   | P2 — no module, no hook, no spawn                                                                                           |
| Z7  | body contains no `_INFRA_KIT_LAST_` and no `_INFRA_KIT_SHELL_STARTED`                   | §3 Settled #2                                                                                                               |
| Z8  | `buildZshenvBlock()` `===` `` `${MARKER_START}\n${buildZshenvBody()}\n${MARKER_END}` `` | doctor's exact match stays valid                                                                                            |
| Z9  | `emulate -L zsh -o extendedglob` is the first line inside `() {`                        | options local; `allexport` cannot leak (PM-2); `extendedglob` on for Z10                                                    |
| Z10 | `[[ "${INFRA_KIT_SESSION:-}" == [0-9a-f](#c8) ]] \|\| return`                           | only the canonical id is honoured; `[0-9a-f]` refuses uppercase (A.6 row 8); `(#c8)` needs Z9's `extendedglob` (A.6 case 6) |
| Z11 | every `local` name starts with `_ik_`; no `local dir`, `load` or `clear`                | a Doppler key of that name survives the function                                                                            |

Z9 and Z10 are string guards on lines whose failure modes are **invisible to string tests** (a
permanent no-op, an `allexport` leak) — which is why each has a real-zsh twin in A.5 (cases 9 and 10) and why S1 AC8 mutates them there, not here.

### Acceptance criteria

1. `initCore` on an empty temp `$HOME` creates `~/.zshenv` containing exactly `buildZshenvBlock()`
   followed by `\n`, and `~/.zshrc` as before.
2. Idempotent: two runs leave exactly one `MARKER_START` in `~/.zshenv`; a third run after the
   block is hand-moved above user content keeps it there (replace-in-place).
3. User content outside the markers is byte-identical before and after (the `assertOutsideMarkersUnchanged`
   idea from `agent-guidance/write-managed-file.ts:97`, applied here by the test).
4. Z1–Z11 pass.
5. `zshenv-inherit.test.ts` (A.5) passes on a machine with `/bin/zsh`; it is `skipIf`'d on one
   without, and that skip is the **only** skip the PR introduces — recorded in the PR body.
6. `setup({ skipTools: true })`'s `structuredContent.init` carries a `zshenv` entry with
   `outcome: 'written'`, and the step set equals the existing nine plus `zshenv`.
7. `pnpm run ts-check && pnpm run eslint-check && pnpm run test` green in `apps/infra-kit/cli`.
8. **Red once, recorded.** (a) Z3: change `-nt` to `-ot` in the body → `zshenv-body` reddens on Z3
   _and_ `zshenv-inherit` reddens on the clear-newer case (two independent guards on the same
   line — that is the point). (b) Z10: replace the id-guard line with `true` → case 10
   (_malformed id_) reddens: `INFRA_KIT_SESSION='../../evil'` with a load file planted at
   `<cache>/../evil/env-load.sh`, outside the cache root — green with the guard, `cfg=[EVIL]`
   without (A.6 row 10b). Case 6 stays **green** under this mutation: the outer `[[ -n … ]]` still
   returns on an empty id (A.6 row 10c). (b') Case 6 (_no session_) has its own row and needs
   **both** guard lines replaced — `if [[ -n … ]]; then` → `if true; then` **and** Z10 → `true` —
   because each refuses an empty id on its own: replacing only the outer line leaves Z10 to return
   (A.6 row 10c', `DECOY=[]`), replacing only Z10 leaves the outer line to skip (row 10c). With both
   gone, `$_ik_load` expands to `<cache>/infra-kit//env-load.sh`, which the kernel collapses to
   `<cache>/infra-kit/env-load.sh`, so the test plants a decoy load file **there** and asserts its
   vars are absent — `DECOY=[1]` under the double mutation (row 10c''). Consequence, stated so the
   AC8 preamble stays true: the outer line is **not** a guard with behaviour of its own — it is an
   early exit that Z10 subsumes — so its only red is Z1's string assertion (remove the line →
   `zshenv-body` reddens on Z1); no real-zsh case can see it alone, and none claims to. (c) Z9, two mutations
   because the line does two jobs: **replace** `emulate -L zsh -o extendedglob` with
   `setopt extendedglob` (guard still works, options no longer local) → case 9 reddens on
   `allexport=1` and on the child seeing a post-block variable (A.6 case 11b); **delete** the line
   outright → `extendedglob` is off in a `zsh -c`, `(#c8)` is not a glob flag, the guard never
   matches, and case 1 reddens as a permanent no-op (A.6 case 6' — the same failure with the
   shipped `[0-9a-f]` pattern, not only with `[[:xdigit:]]`). A deletion alone would
   leave the `allexport` guard unproven — nothing is sourced, so nothing leaks. (d) AC2: switch the
   writer to `append-end` → the hand-moved-block test reddens.
   Verify the source is byte-identical after each revert (`git diff --stat` empty). Every probe of
   the no-session and malformed-id cases runs with `env -u INFRA_KIT_SESSION`; A.6 records why.

---

## S2 — `[DO] doctor: report the ~/.zshenv session-env block`

Same PR as S1 or the next; both orderings work because `doctor` imports the builder S1 exports.

**Files**

| File                                                                                | Change                                                                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/infra-kit/cli/src/commands/doctor/doctor.ts`                                  | `checkZshenvInitialized()` beside `checkZshrcInitialized` (`:160-192`); called at `:1853` right after it                         |
| `apps/infra-kit/cli/src/commands/doctor/report.ts`                                  | `SECTION_SHELL` row (`:82`) gains `'zshenv session block'` immediately after `'zshrc init block'`                                |
| `apps/infra-kit/cli/src/commands/doctor/__tests__/report.test.ts`                   | `covers exactly 32 checks` (`:89-93`) → `33`, with the one-line "why" comment updated in the same style                          |
| `apps/infra-kit/cli/src/commands/doctor/__tests__/check-zshenv-initialized.test.ts` | new — the five cases of `check-zshrc-initialized.test.ts:31-66` (verbatim / no file / block absent / reversed markers / drifted) |

`report-inventory.test.ts:240-261` needs no edit — it reconciles `DOCTOR_CHECK_NAMES`
(`report.ts:117-119`) against a real `doctor()` run, which is exactly why the `SECTION_MEMBERS` edit
is mandatory: without it the new row lands in `Other` and two inventory tests fail (the memory
`doctor-report-section-map` records this trap).

**Messages** (same shape as `doctor.ts:165, 175, 185, 191`):

- fail: `~/.zshenv not found. Run: infra-kit setup --skip-tools`
- fail: `infra-kit session-env block missing from ~/.zshenv. Run: infra-kit setup --skip-tools`
- fail: `infra-kit session-env block in ~/.zshenv is out of date. Run: infra-kit setup --skip-tools`
- pass: `infra-kit session-env block in ~/.zshenv is up to date`

**Acceptance criteria**

1. The five cases pass; `doctor()`'s check list contains `zshenv session block` exactly once,
   adjacent to `zshrc init block`.
2. `report.test.ts` `covers exactly 33 checks`; `maps every canonical check name to a real section`
   (`:79`) still passes.
3. **Red once:** add the check to `doctor.ts` _without_ the `SECTION_MEMBERS` row → `report-inventory`
   `produces exactly the names the section map is built from` reddens naming the row. Record it.
4. `pnpm run ts-check && pnpm run eslint-check && pnpm run test` green.

---

## S3 — `[DO] session: teach the procedure that the Bash tool now sees the env`

CLI-only; ships in the same release as S1. The plugin command needs **no** change: it already points
at `infra-kit://workflow/session` with floor `0.5.2`, and the URI does not move.

**Files**

| File                                                  | Change                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/infra-kit/cli/resources/workflow/session.md`    | §2 gains one paragraph after **Timing** (`:24-26`); **Sourcing it yourself is not a substitute** (`:34-36`) gains one sentence |
| `apps/infra-kit/cli/src/mcp/__tests__/server.test.ts` | line-count pin `109` (`:290`) → new count; two new `toContain`s in the clauses test (`:287-343`)                               |

**What the paragraph says.** The terminal itself still learns of the load at its next prompt (C4
stays true and stays pinned). _Every zsh spawned from that terminal after the file lands_ — the
`Bash` tool included — sees it immediately, **when `~/.zshenv` carries the infra-kit session-env
block**; `infra-kit doctor` reports the row `zshenv session block`, and a machine set up before that
row existed needs `infra-kit setup --skip-tools` once. So: `infra-kit env-status` run **through
`Bash`** is a truthful reading of what the agent's commands see — it reads that child's own
environment. `env-status` **over MCP** remains what C11 says it is: the long-lived server's frozen
environment, never a verification.

**New literals** (single authored lines, ASCII where they might be grepped in `dist/`):

| #   | Exact literal                            | Section |
| --- | ---------------------------------------- | ------- |
| C22 | `zshenv session block`                   | §2      |
| C23 | `run through Bash is a truthful reading` | §2      |

**Acceptance criteria**

1. C1–C23 pass; the line-count pin is updated to the real count, not loosened.
2. `prompts/list` is untouched (`server.test.ts:131-146` precedent: resource-only stays resource-only).
3. **Red once:** substitute `zshenv` → `zsh-env` on C22's line → the clauses test reddens on C22
   only (a reword, never a deletion — the prior plan's AC8 explains why a deletion trips the count
   first and proves nothing).
4. Build + grep, as the prior plan's S1 AC6:
   `pnpm --filter infra-kit run build && grep -rl 'run through Bash is a truthful reading' apps/infra-kit/cli/dist/*.js`
   names **`dist/mcp.js` and nothing else**. The literal must be C23, not C22: `zshenv session block`
   is also S2's doctor check name, which the bundle carries whether or not S3 shipped — today's
   `grep -l 'zshrc init block' dist/*.js` names `dist/chunk-TBBVG7F6.js`, not `dist/mcp.js`, so a C22
   grep would be green on a build with no procedure change at all. C23 is pure ASCII (the prior plan's
   esbuild `\u` escape caveat) and exists nowhere but the workflow body, so the same grep against the
   current bundle is a **free RED** today.

---

## S4 — `[DO] session: prove the Bash-tool round trip against the published CLI`

Nothing committed; the deliverable is a transcript pasted into the ticket. Runs after the release
that carries S1–S3 (a patch on `0.5.x`, `0.5.7` unless the owner decides otherwise — the S3 floor
sentence does not change, so the number is not user-visible this time).

**Method**

1. `pnpm add -g infra-kit@<exact version>` (the memory `pnpm-add-latest-served-from-stale-metadata-cache`:
   pin the exact version, never `@latest`). `infra-kit setup --skip-tools`. `infra-kit doctor` shows
   `zshenv session block … up to date`.
2. Open a **fresh** terminal (so `.zshenv` ran before `.zshrc` minted the session). Note
   `echo $INFRA_KIT_SESSION`.
3. Launch Claude Code there. In it, through the **Bash tool**: `echo "s=$INFRA_KIT_SESSION c=[${INFRA_KIT_ENV_CONFIG:-}]"`
   — `s` equals step 2, `c` is empty (baseline; if it is not empty, a warm/auto load already
   happened — pick a config the shell has not loaded, as the prior S4 did with `arthur`).
4. `/infra-kit:session <config-with-token>`.
5. Bash tool: `infra-kit env-status` → reports the config, `N of N vars loaded`, the same session id.
   Bash tool: `zsh -c 'setopt | grep -c allexport'` → `0` (the `emulate -L` restore, observed from
   the host's own spawn rather than the scratch one). Note one loaded variable's **name** from
   `env-status` for step 7 — never its value.
   Bash tool: `echo ${INFRA_KIT_ENV_CONFIG}` → the config. **Never** echo a secret value.
6. `/infra-kit:session --clear`, approve the host prompt.
7. Bash tool: `echo "[${INFRA_KIT_ENV_CONFIG:-}] cleared=[${INFRA_KIT_ENV_CLEARED:-}] key=[${+<NAME>}]"`
   → `[] cleared=[1] key=[0]`, with `<NAME>` the variable noted in step 5 — `${+NAME}` prints `0`
   when the parameter is unset and never prints a value. The marker alone would pass if the clear
   file had been sourced but its `unset` list were empty; the key proves the list.
8. Quit Claude Code, press ⏎: `infra-kit: auto-cleared env` (the `precmd`, unchanged).
9. **Negative control, loud:** `zsh -f -c 'echo [${INFRA_KIT_ENV_CONFIG:-}]'` from that terminal
   after a fresh load prints `[]` — the block is the only thing doing this.
10. **Inherited-vars control (the reason the clear branch exists):** in the terminal, `env-load
<config>` (the `.zshrc` function, `init.ts:897`), then launch Claude Code, then `--clear` from
    inside it, then step 7 again → still `[] cleared=[1]` even though Claude Code's own environment
    still holds the variables (visible via `infra-kit env-status` over **MCP**, which will still say
    loaded — that contrast is the Q2 caveat, reproduced on purpose).

### Pre-release run — 2026-09-14, this host, built body in a scratch `ZDOTDIR`

Not S4 (no release, no `/infra-kit:session` call, real `~/.zshenv` untouched) — the block as
`buildZshenvBody()` renders it, byte-identical to §1.2, placed between the real markers in a scratch
`ZDOTDIR`, exercised from **this** Claude Code session's Bash tool (`interactive=no login=yes`,
`ppid=claude`) with a scratch `XDG_CACHE_HOME` and session `abcd1234`:

```
after load  (zsh -c):   cfg=[arthur] key=[1] allexport=0
after load  (zsh -lc):  cfg=[arthur]
zsh -f control:         cfg=[]
after clear, HULYO_PROBE_KEY=leak INFRA_KIT_ENV_CONFIG=leak in the parent env:
                        [] cleared=[1] key=[0]
```

Steps 5, 7 and 9 of the method hold against the built body in the real host's spawn; steps 1–4, 6,
8 and 10 need the published CLI and stay open.

**Acceptance criteria**

1. Steps 5 and 7 read as stated, in the same Claude Code session, with no `source` in any command.
2. Step 8 prints the clear notice exactly once.
3. Step 9 prints `[]`; step 10 prints `[] cleared=[1]`.
4. The MCP `env-status` contrast in step 10 is recorded, not "fixed".

---

# 2. Non-goals

- **No change to `env-load`, `env-clear`, `env-status`, `env-list`** — the prior plan's D2 stands.
  The block consumes the files as written today, including `env-clear`'s unlink (`env-clear.ts:104`).
- **No change to the `.zshrc` block**, its gates (`init.ts:928/934`), its notify, or its exports.
- **Nothing printed by `.zshenv` itself**, in any shell type — P3 (a sourced file's own error stays audible, PM-2). An interactive descendant that needs
  a notice gets it from the `precmd`, when that gate fires (§3 Settled #2).
- **No `_INFRA_KIT_LAST_LOAD_MTIME` / `_INFRA_KIT_LAST_CLEAR_MTIME` writes** from `.zshenv`.
- **No bash/fish/sh support.** `.zshenv` is zsh's file; `shellEntries` already warns non-zsh users
  (`init.ts:310-317`). Option (B) is the recorded path if that ever matters.
- **No Claude Code hook**, no `CLAUDE_ENV_FILE`, no `PreToolUse` rewrite (§0.4 B).
- **No change to `SHELL_ACTIVATION_REMINDER`** (`init.ts:121`).
- **No legacy-marker handling for `.zshenv`**; no `removeExistingBlock` call.
- **No tmux session isolation.** Windows of one tmux server share a session id today; unchanged.
- **No fix for the MCP `env-status` staleness** (prior plan Q2). S4 step 10 reproduces it deliberately.
- **No root `pnpm run qa`, no `vendor/` edits** — per-package gates, as before.

---

# 3. Decisions and open questions

**Settled — stated so they are not re-litigated:**

1. **Same markers, same file-writer.** `MARKER_START`/`MARKER_END` (`init.ts:33-34`) in a different
   file cannot collide; `upsertManagedBlock` is the one writer. A distinct marker pair would buy a
   second doctor constant and nothing else.
2. **Double-source in interactive descendants is accepted; the block touches no `_INFRA_KIT_LAST_*`.**
   A `zsh` typed at a prompt, or a tmux window, reads `.zshenv` (sources the load) and then `.zshrc`,
   whose `precmd` compares the file's mtime with the **inherited, exported**
   `_INFRA_KIT_LAST_LOAD_MTIME` (`init.ts:896, 928`). Two cases, both verified (A.6 case 9): the
   parent had already sourced this load → inherited mtime equals the file's → the `precmd` is quiet
   and the vars came from `.zshenv`, correct and silent; the parent had **not** yet sourced it (the
   file landed while a foreground process held the parent) → the `precmd` sources again and prints
   `infra-kit: auto-loaded vars for <cfg>` — a true statement about a shell that did just pick it up.
   The re-source is idempotent (`set -a` assignments, `env-load.ts:164-174`). Having `.zshenv` set
   `_INFRA_KIT_LAST_LOAD_MTIME` instead would silence that second case and, worse, would have to
   know the `.zshrc` block's `:=` defaults (`init.ts:887-891`) — coupling in the wrong direction.
3. **No `_INFRA_KIT_SHELL_STARTED` gate — decided on cost and odds, not on principle.** For a
   per-terminal id the gate is a no-op: every file in that directory postdates the terminal that
   minted it, so `load_mtime >= _INFRA_KIT_SHELL_STARTED` is always true. It bites only for a
   **shared** id (PM-3: tmux windows, a `zsh` typed at a prompt) — and there the `precmd` accepts the
   very same loads today, because `_INFRA_KIT_SHELL_STARTED` is exported (`init.ts:896`) and the
   `:=` at `:891` keeps the inherited value. The stale-directory odds are real on this box — the
   Architect counted **1528** session directories under `~/.cache/infra-kit/`, **1255** holding an
   `env-load.sh`, **1183** of those older than a day, and nothing reaps them — but a stale directory
   is reachable only through a stale **id**, and `head -c 4 /dev/urandom` (`:884`) does not reissue
   one. The gate would cost the block a `zstat` (a `zmodload`, P2) to refuse a case that needs a
   shared id _and_ a parent that never sourced the file, which the `precmd` would then source on the
   next prompt anyway. Not worth the module. The reaper is a follow-up (Appendix B).
4. **Prints nothing of its own, in every shell type** — not "notify when `[[ -o interactive ]]`",
   and not `[[ -o interactive ]] && return` either (both reviewers: it would exclude the tmux and
   `zsh`-at-a-prompt descendants for nothing). The interactive descendant already has a notifier
   (item 2), and one behaviour is easier to prove than two. A sourced file's own error is not the
   block's output and is deliberately left audible (PM-2).
5. **Clear branch sources `env-clear.sh`** rather than treating the load file's absence as the whole
   signal — because inherited variables exist (§1.2, S4 step 10).
6. **Remediation string** is `infra-kit setup --skip-tools`, the same as the `.zshrc` row and the
   `INFRA_KIT_SESSION is not set` error (`constants.ts:227-229`).

**Open — each changes the work if answered differently:**

**Q1 — an opt-out variable (`INFRA_KIT_NO_INHERIT=1`)?** _Recommendation: no._ `zsh -f` skips the
file; removing the block is one `setup`-free edit outside nothing; and a one-line guard is a second
behaviour to test forever. Revisit only if PM-2 (A.4) is ever observed in practice.

**Q2 — `XDG_CACHE_HOME` set in `.zshrc`, not `.zshenv`.** Then node (launched from the terminal,
where it is exported) writes under `$XDG_CACHE_HOME`, while `.zshenv` — which runs before `.zshrc`
in a fresh terminal — resolves… the same value in every _descendant_, because the descendant
inherits the export. The mismatch exists only for the fresh terminal itself, where the block is a
no-op anyway (D2). A sibling caveat, `ZDOTDIR`: `doctor` reads `~/.zshenv` (`os.homedir()`, the
`checkZshrcInitialized` convention at `doctor.ts:162`), while zsh reads `$ZDOTDIR/.zshenv` when
`ZDOTDIR` is set — a user who relocates their dotfiles gets a truthful "not found" for a file zsh is
not reading either, and a false "up to date" if they keep a stale copy at `~`. _Recommendation: both
caveats in the doctor row's JSDoc; no check. `ZDOTDIR` users are already outside the `.zshrc` row's
contract._

**Q3 — should the Bash tool be able to call `env-load` / `env-clear` as functions?** It already can:
Claude Code's shell snapshot carries every function of the launching shell, and `type env-load` from
this Bash tool answers `shell function from ~/.claude/shell-snapshots/…` (probed). So the premise —
that the functions are unreachable there — is false, and moving them to `.zshenv` would buy nothing.
The objection that stands: each of them mutates the **calling** shell (`source "$f"`, `init.ts:897-898`),
which for the Bash tool dies with the call, so an agent that runs `env-load dev` there has loaded
nothing durable — the file it wrote is what the block will source on the _next_ call. That is the
prior plan's C8/C21 in different clothes. _Recommendation: leave the functions where they are; the
agent uses the MCP tools, the block does the inheriting._

**Q4 — does `setup.md`'s and `session.md`'s prose count as "changing a published resource" for the
plugin gate?** No: `check-workflow-resource-published.mjs` checks floor + URI presence only; neither
moves. Stated so nobody bumps the plugin for this.

---

# Appendix A — derivation

## A.1 Principles — see §0.2.

## A.2 Decision drivers — see §0.3.

## A.3 Axes

**Axis A — where the block lives.** `.zshenv` chosen (D1). `.zprofile` invalidated (§0.4 D).
`/etc/zshenv` rejected without a table: root-owned, machine-wide, outside `setup`'s write scope.

**Axis B — which file(s) the block sources.** B1 load only (absence = cleared) fails the
inherited-vars case (S4 step 10). **B2 load-else-clear chosen**; the ordering rule is the `.zshrc`
gate's own (`load >= clear`). B3 always source both in mtime order — needs `zstat`, and sourcing a
clear then a load is B2 with extra work.

**Axis C — how ties resolve.** `-nt` non-strict (load wins), matching `init.ts:928`. The strict
`clear > load` at `:934` is unreachable in practice because `env-clear` unlinks the load file
(`env-clear.ts:104`, the prior S4's finding); the block has one comparison, not two, so it cannot
disagree with itself — with the `precmd` it can, inside one second, because `-nt` sees sub-second
mtimes and `zstat +mtime` does not: PM-6, equally unreachable while the unlink stands.

**Axis D — output.** Silent (§3 Settled #4).

**Axis E — writer placement.** `replace-in-place` (S1, "The writer" #2).

**Axis F — doctor shape.** Exact match against `buildZshenvBlock()`, the `checkZshrcInitialized`
shape (`doctor.ts:160-192`). A looser "markers present" check would pass a stale block forever.

## A.4 Pre-mortem

**PM-1 — "My secrets are now in every zsh." (scope, not a bug)**
A `#!/bin/zsh` script run from the terminal dumps `env` into a log; a zsh-based tool prints its
environment on crash.
_Leading indicator:_ `INFRA_KIT_ENV_CONFIG` appearing in a process that never ran `env-load`.
_Measured size:_ §1.3. Two populations. Descendants of processes started **after** the terminal's
`precmd` sourced a load already inherit the exports; for them the block changes only the moment. The
**new principals** are zsh children of long-lived processes that **predate** the load — Claude Code,
a tmux server, an editor — whose frozen environments never carried the secrets and whose children now
read them from disk. That population is the feature, not a leak; the exposure to weigh is that it
includes every `#!/bin/zsh` script and `zsh -c` such a process runs, not only the Bash tool.
_Mitigation:_ §1.3 in this doc and the S3 paragraph in the procedure name the widened set; the `sh`
negative case in A.5 proves the boundary; the id guard refuses any directory but the canonical one;
`env-load.sh` stays `0600` in a `0700` dir (`env-load.ts:219-220`) so a different uid gets the `-r`
fall-through.

**PM-2 — a bad `env-load.sh` poisons every zsh spawn. (loud, then silent, machine-wide)**
A value `shellSingleQuote` (`env-load.ts:472`) mis-escapes, or a hand-edited file, makes `source`
stop mid-file on **every** `zsh -c` on the box, including every Bash-tool call. The loud half is the
error line. The **damage** is the silent half: `set -a` (`env-load.ts:164`) ran, `set +a` (`:174`) did
not, and without option scoping `allexport` stays ON in the surviving shell — every variable that
shell assigns from then on is exported to its children (probed, A.6 case 11b: a `/bin/sh` child sees a
variable assigned after the block).
_Leading indicator:_ the same stderr line on unrelated commands; `zsh -f -c :` is clean;
`setopt | grep allexport` non-empty in a fresh `zsh -c`.
_Mitigation:_ `emulate -L zsh` on the block's first line scopes every option to the function, so
`allexport` is restored at return whatever the file did (A.6 case 11: `allexport=0`, child sees
nothing) — the variables the file managed to assign before the error are already exported, which is
the best partial outcome available. The block never aborts the shell; `zsh -f` is the escape;
`infra-kit env-clear` from **any** terminal with that session id unlinks the file;
`atomicWriteFileSync` (`:220`) rules out truncation. Not silenced with `2>/dev/null` on purpose —
hiding the line would leave the user with a half-loaded env and no symptom.

**PM-3 — a shared session id loads into windows nobody asked for. (silent, pre-existing)**
tmux windows inherit the server's environment, so every window of a server started from an
integrated shell shares one `INFRA_KIT_SESSION`; the `.zshrc` block only mints when absent
(`init.ts:883`). Today those windows' `precmd`s already source the same file; the block extends that
to their non-interactive children. The directory population makes the odds concrete: 1528 session
directories on this box, 1183 `env-load.sh` older than a day, no reaper (§3 Settled #3).
_Leading indicator:_ `echo $INFRA_KIT_SESSION` equal across windows.
_Mitigation:_ named as a non-goal; the fix (mint per pty, not per env) belongs to the `.zshrc` block
and is a separate ticket if wanted; a reaper / age gate for `~/.cache/infra-kit/<id>/` is a
follow-up (Appendix B) that shrinks the stale population without touching the block.

**PM-4 — the doctor row goes red for everyone on the next block edit. (loud, cheap)**
Exact-match freshness means any future body change fails `doctor` until `setup --skip-tools` is
re-run — the same contract the `.zshrc` row has had. _Mitigation:_ the row's message says exactly
what to run; `setup` is idempotent.

**PM-5 — the S1 unit tests are green while the block is broken in real zsh.**
String assertions cannot catch `-nt`'s absent-file semantics or the anonymous-function scope.
_Mitigation:_ `zshenv-inherit.test.ts` runs `/bin/zsh` for real (A.5), and S1 AC8(a) proves it
reddens on the one-character mutation the string test would also catch — two guards, one line. The
starkest instance is Z9/Z10: `(#c8)` under bare `emulate -L zsh` — `extendedglob` off — is a
permanent no-op that every string test passes, with either character class (A.6 cases 6 and 6');
only case 1 in real zsh catches it.

**PM-6 — the two readers disagree inside one second. (silent, unreachable today)**
`-nt` sees sub-second mtimes; `zstat +mtime` (`init.ts:926-927`) sees whole seconds. A clear file
touched after a load file **within the same second** is "newer" to the block and "tied" to the
`precmd`: the block takes the **clear**, the `precmd` gate at `:928` (`load >= clear`) takes the
**load** — a descendant zsh and the terminal end up in opposite states with no notice on either side.
Reproduced (A.6 case 13): `zstat` equal, `-nt` true, block sourced the clear.
_Leading indicator:_ `zstat +mtime` equal for the two files while `[[ clear -nt load ]]` is true.
_Mitigation:_ unreachable on the shipped path — `env-clear` unlinks `env-load.sh` after writing the
clear (`env-clear.ts:104`), so the two files coexist only in the clear-then-load order, where the
load is the newer one and both readers agree. Recorded so that a future change to `env-clear`'s
unlink (or a `touch` by hand) is known to reopen it; the fix, if ever needed, is the same as the
prior plan's PM-4 spin-off — make the `precmd` gate strict, or give it sub-second time.

## A.5 Test plan

**Unit — `init/__tests__/zshenv-body.test.ts`.** Z1–Z11 on `buildZshenvBody()` / `buildZshenvBlock()`.
Style: `shell-body.test.ts` (one `it` per guarded property, `toContain` / `not.toContain`).

**Unit — `init/__tests__/init-zshenv-write.test.ts`.** The `init-zshrc-write.test.ts:1-66` harness
(same three `vi.mock`s, same `os.homedir` spy, `INFRA_KIT_NO_SEED=1`): create / idempotent /
preserves outside content / replace-in-place keeps a hand-moved block in place.

**Unit — `doctor/__tests__/check-zshenv-initialized.test.ts`** — five cases; **`report.test.ts`**
count 32 → 33; **`setup/__tests__/setup-init-report.test.ts`** step set + entry + marker read.

**Integration — `init/__tests__/zshenv-inherit.test.ts`.** The direct proof of the Bash-tool case,
in-process and hermetic: a temp dir as `HOME`, `ZDOTDIR` and `XDG_CACHE_HOME`; `buildZshenvBlock()`
written to `$ZDOTDIR/.zshenv`; `execFileSync('/bin/zsh', ['-c', <echo of the vars>], { env })` with a
**scrubbed** env (only `HOME`, `PATH`, `ZDOTDIR`, `XDG_CACHE_HOME`, `INFRA_KIT_SESSION` — the memory
`shell-autoload-startup-poll` on why PTY/shell tests must scrub). Fixture files are built with the real
builders — `buildEnvLoadFileLines` (`env-load.ts:138`) and `buildEnvClearLines` (`env-clear.ts:58`) —
so a change to their shape reaches this test. Cases, each asserting **stdout exactly and stderr
empty**:

1. load only → vars present;
2. clear only, with `FOO=inherited` and `INFRA_KIT_ENV_CONFIG=inherited` in the parent env → both
   empty, `INFRA_KIT_ENV_CLEARED=1`;
3. both, load newer → load;
4. both, clear newer, `FOO=inherited` → cleared;
5. tie (`utimesSync` to equal mtimes) → load;
6. no `INFRA_KIT_SESSION` → nothing sourced, made observable by the decoy at
   `<cache>/infra-kit/env-load.sh` (S1 AC8(b));
7. `-lc` (login) and `-c` (non-login) give identical results for case 1 — the Bash tool's flag does
   not matter;
8. `/bin/sh -c` with the same env → nothing (the boundary in §1.3);
9. **broken load file** — the builder's lines with the last value's closing quote removed
   (`FOO='x`), so `set -a` runs and `set +a` never does. Asserts three things: **stderr non-empty**
   (the only case that asserts a non-empty stderr, and it asserts the `unmatched '` line, not just
   non-emptiness); `INFRA_KIT_ENV_CONFIG` **set** (the assignments before the break landed); and a
   variable the `-c` script assigns **after** the block is **absent** from a `/bin/sh` grandchild's
   env — `allexport` was restored. Red-once: replace the `emulate` line with `setopt extendedglob`
   (S1 AC8(c));
10. **malformed id** — `INFRA_KIT_SESSION='../../evil'` with a load file planted at
    `<cache>/../evil/env-load.sh` → nothing sourced; plus `ABCD1234` (uppercase), `abcd123` (7),
    `abcd12345` (9) against a real file at the canonical path → nothing sourced. Red-once: replace
    the guard with `true` (S1 AC8(b));
11. **quoting round trip** — one fixture value built through `shellSingleQuote` (`env-load.ts:472`)
    containing `'`, `$(…)`, backticks and `"`, read back byte-identical (A.6 case 14). This is the
    one case whose subject is the writer's escaping rather than the block; it lives here because the
    block is where a mis-escape would first execute.

`it.skipIf(!fs.existsSync('/bin/zsh'))` on the whole `describe`, with a comment naming it as the one
platform skip in the package — the memory `no fake completion` rule is about hiding unimplemented
work, not about a capability the runner lacks.

**E2E.** S4, in a real Claude Code session against the published CLI: the only test that exercises
the actual host's spawn flags, `claude`'s inherited environment, and the confirm gate. Its step 9
(`zsh -f`) and step 10 (inherited vars) are the two controls that distinguish "the block did it" from
"something else did it".

**Every new guard is seen red once**: S1 AC8 (five mutations across four guards), S2 AC3 (the
section-map trap), S3 AC3 (C22 reword) and S3 AC4 (the C23 bundle grep, red against today's build).

**Observability.** One new `doctor` row. `infra-kit env-status` through the Bash tool becomes an
honest instrument (S3). The `precmd` notices are unchanged. No telemetry.

## A.6 Probe record — 2026-09-14, this machine, zsh 5.9

First round, the pre-revision body (no `emulate`, no id guard, bare `dir`/`load`/`clear` locals) —
kept because the load/clear/tie semantics it established are unchanged. Scratch `ZDOTDIR`, scratch
`XDG_CACHE_HOME`, `INFRA_KIT_SESSION=abcd1234`,
`env-load.sh` = `set -a / FOO='x' / INFRA_KIT_ENV_CONFIG='arthur' / unset INFRA_KIT_ENV_CLEARED / set +a`,
`env-clear.sh` = `unset FOO / unset INFRA_KIT_ENV_CONFIG / export INFRA_KIT_ENV_CLEARED='1'`.

```
zsh -c   with session, load only          cfg=[arthur] foo=[x]  cleared=[]   login=n inter=n
zsh -lc  with session, load only          cfg=[arthur]                        login=y
zsh -c   NO session                       cfg=[]
zsh -c   load unlinked (clear signal)     cfg=[]
sh -c    with session                     env=[] cfg=[]          ← .zshenv not read
zsh -fc  with session                     env=[]                 ← -f skips it
```

Second round, the **final** §1.2 body (`emulate -L zsh -o extendedglob`, id guard, `_ik_` locals),
every probe run under `env -u INFRA_KIT_SESSION` and the load file carrying `dir='D' load='L'
clear='C'` beside `FOO` and `INFRA_KIT_ENV_CONFIG`:

```
1   abcd1234, load only                      cfg=[arthur] foo=[x] dir=[D] load=[L] clear=[C] allexport=0
2   clear only, FOO/cfg=inherited in env     cfg=[] foo=[] cleared=[1]
3   both, load newer                         cfg=[arthur] foo=[x]
4   both, clear newer, FOO=inherited         cfg=[] foo=[] cleared=[1]
5   tie (touch -r)                           cfg=[arthur] foo=[x]                   ← load wins
5b  `setopt nounset` above the block, no session, `${…:-}` guards     "sessionless ok", stderr empty
5b' same with bare `${INFRA_KIT_SESSION}`   .zshenv:3: INFRA_KIT_SESSION: parameter not set
6   `[[:xdigit:]](#c8)` under bare `emulate -L zsh`, valid id          cfg=[]  ← permanent no-op
6'  `[0-9a-f](#c8)` under bare `emulate -L zsh`, valid id             cfg=[]  ← same: extendedglob off, not the class
7   load chmod 000                           cfg=[] foo=[] cleared=[1]              ← falls through to clear
8   ABCD1234 / abcd123 / abcd12345           cfg=[] ×3                              ← guard refuses
9   zsh -ic, inherited _INFRA_KIT_LAST_LOAD_MTIME == file mtime   precmd quiet         cfg=[arthur]
9'  zsh -ic, inherited _INFRA_KIT_LAST_LOAD_MTIME == 0            would re-source+notify cfg=[arthur]
10  '../../evil', file at <cache>/../evil/   cfg=[]                                 ← guard refuses
10b same, guard replaced by `true`           cfg=[EVIL]                             ← red, as required
10c no session, decoy at <cache>/infra-kit/env-load.sh, Z10 → `true`, outer intact   DECOY=[]  ← green: outer returns
10c' same decoy, outer `if` → `if true; then`, Z10 intact                          DECOY=[]  ← green: Z10 returns
10c'' same decoy, BOTH lines → `true`                                               DECOY=[1] ← red, as required
10d '../../evil', outer → `if true; then`, Z10 intact                               cfg=[]    ← Z10 alone refuses traversal
11  broken file (FOO='x unterminated)        cfg=[arthur] A=[1] allexport=0 child_sees_AFTER=[]
                                             stderr: …/env-load.sh:6: unmatched '   (158 bytes)
11b same, emulate line → `setopt extendedglob`   cfg=[arthur] allexport=1 child_sees_AFTER=[1]  ← the leak
12  good file, /bin/sh grandchild            child_cfg=[arthur] child_foo=[x]       ← exports survive -L
13  PM-6: touch load; touch clear, same sec  zstat load==clear (equal=1); [[ clear -nt load ]] TRUE
                                             block took: cfg=[] cleared=[1]        ← clear; precmd would take load
14  TRICKY='it'\''s $(echo pwned) `echo no` "q"'   read back  <it's $(echo pwned) `echo no` "q">
200 × zsh -c :  with block 0.817 s / without 0.746 s   (both under `env -u`; ≈0.35 ms per spawn)
this Bash tool: type env-load → "shell function from ~/.claude/shell-snapshots/…"   (Q3)
~/.cache/infra-kit: 1528 session dirs, 1255 env-load.sh, 1183 older than a day   (Settled #3, PM-3)
dist: 'the terminal that launched Claude Code and no other' → dist/mcp.js only;
      'zshrc init block' → dist/chunk-TBBVG7F6.js;  'run through Bash is a truthful reading' → none (exit 1)
```

Two fixture mistakes during the first round are worth recording because the test plan inherits both
lessons. `rm -f clear; touch clear` produced an **empty** clear file, and cases 2/4/7 first read as
"clear not sourced" when `-x` showed the branch _was_ taken — so A.5's fixtures are written by the
real builders, never `touch`ed into existence. And the AC8(b) decoy first stayed green under the
mutation because the probe ran from this Bash tool, which itself carries `INFRA_KIT_SESSION=dd44f64a`:
the "no session" case had a session. `env -u INFRA_KIT_SESSION` fixed it — which is why A.5 builds
the child env from an allow-list rather than from `process.env` minus a few names, and why the second
round ran every probe that way from the start.

---

# Appendix B — ADR

**Status.** Proposed, pending approval.

**Decision.** `infra-kit setup` installs a second managed block, in `~/.zshenv`, between the same
markers as the `~/.zshrc` block and through the same `upsertManagedBlock` writer. The block is pure
zsh, run inside an anonymous function under `emulate -L zsh -o extendedglob`: when
`INFRA_KIT_SESSION` is exactly eight lowercase hex digits — the id the `.zshrc` block mints — it
sources the session's `env-load.sh` if that file is readable and not older than `env-clear.sh`, else
`env-clear.sh` if readable; any other id shape is treated as no session; it prints nothing of its
own and remembers nothing, and no option a sourced file sets survives its return. `doctor` gains an
exact-match row for it; `setup` reports it as step `zshenv`; the `session` procedure gains one
paragraph saying the Bash tool now sees the env and that `env-status` run through Bash is a truthful
reading. `env-load`, `env-clear` and the `.zshrc` block are unchanged.

**Drivers.** D1 the Bash tool is a fresh login non-interactive zsh, and `.zshenv` is the one file
every zsh reads; D2 the session id is minted after `.zshenv`, so the block must be a no-op without
one; D3 the mechanism was fixed by the user, with alternatives to be listed and invalidated.

**Alternatives considered.** (B) Claude Code hooks — `CLAUDE_ENV_FILE` is `SessionStart`-only and
cannot see a mid-session load; a `PreToolUse` `updatedInput` rewrite would work for Claude Code
alone, at host-coupling cost. The Architect's antithesis is recorded here as the reason (B) stays a
**live, Claude-Code-scoped alternative** rather than a dead one: it is narrower than (A) on the axis
that matters today (every zsh the terminal spawns) and wider on one that does not yet (a non-zsh
`$SHELL`, which no `.zshenv` can ever reach); the day that second axis matters, (B) is the
complement, shipped as a plugin hook, and this plan's block keeps doing the zsh half. (C) telling the
agent to `source` per call — unenforceable and contradicts the shipped body. (D) `.zprofile` — a
strict subset of `.zshenv`'s coverage, resting on the host passing `-l`. Sourcing only the load file —
fails when the variables were inherited already. Notifying from `.zshenv` when interactive — a
second behaviour the `precmd` already provides; likewise `[[ -o interactive ]] && return`, which
would exclude the tmux/`zsh`-at-a-prompt descendants for nothing (Settled #4). Setting
`_INFRA_KIT_LAST_LOAD_MTIME` from `.zshenv` — couples the two blocks in the wrong direction and
silences a true notice. A `_INFRA_KIT_SHELL_STARTED` gate — a no-op for a per-terminal id and a
`zmodload` for the shared-id case the `precmd` already accepts (Settled #3).

**Why chosen.** It is the only option that meets both halves of the goal (the agent's commands and
the terminal afterwards) with one artifact and no change to the file protocol, and it is the one the
user asked for. Its cost was measured (≈0.35 ms per zsh spawn) and its scope widening was named
precisely (§1.3: the new principals are the zsh children of long-lived processes that predate the
load — the headline case itself).

**Consequences.**

- Every zsh on the box runs thirteen more lines of code (four more of comment) at startup; a fresh terminal runs one `[[ -n ]]`.
- A sourced file cannot leave an option behind: `emulate -L` restores `allexport` even when the
  file dies before its `set +a` (PM-2).
- A hand-set or foreign `INFRA_KIT_SESSION` is ignored, by contract. Only the id `.zshrc` mints is
  honoured; that is stated in the block's own comment and in Z10.
- A descendant zsh can see a load **before** the terminal that owns the session announces it. The
  notice at the terminal's next prompt is still printed and still true.
- `~/.zshenv` is created on machines that never had one (this one). Later tools that append to it
  (rustup's `. "$HOME/.cargo/env"` is the common case) coexist: the writer replaces in place and
  preserves outside text.
- The `session` procedure now describes two readers of the same file — the interactive `precmd`
  and the `.zshenv` block — and must keep them straight (S3's paragraph is scoped to "every zsh
  spawned from that terminal"; C4 keeps describing the terminal itself).
- `env-status` over MCP is unchanged and still stale; S4 step 10 makes the contrast visible rather
  than pretending it went away.

**Follow-ups.** Option (B)'s `PreToolUse` rewrite as a plugin hook, only if a non-zsh `$SHELL` user
appears. Per-pty session minting (PM-3). **A session-directory reaper or age gate** —
`[DO] env: reap ~/.cache/infra-kit/<id>/ directories no live shell owns` — 1528 directories and 1183
day-old `env-load.sh` files of single-quoted secrets sit on this box with nothing removing them;
adopted as a follow-up rather than a ticket here because the block is not what makes them stale, and
an age gate inside the block would cost the `zmodload` P2 forbids. The prior plan's Q2 (`env-status`
over MCP).
