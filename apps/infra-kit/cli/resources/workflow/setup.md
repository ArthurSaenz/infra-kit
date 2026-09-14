# setup — bringing a machine to a working infra-kit

The tool is `mcp__plugin_infra-kit_infra-kit__setup`. Everything below is about calling that tool.

The same code runs behind `infra-kit setup` in a terminal, so this body describes both spellings: the
CLI flag first, the tool field it sets second. They are one implementation, not two.

Do not shell out. A `Bash` call running `brew install`, `curl … | bash` or the writers in section 1
reproduces none of the refusals in section 3 and bypasses the confirm gate in section 4 — which is the
only place a human approves an install.

**If all you want is to know what this machine looks like, call `doctor` instead.** It reports the same
five tools plus the rest of the setup, mutates nothing, and raises no confirmation prompt. `infra-kit setup` is
the write path; `doctor` is the read path, and they are separate tools precisely so that asking a
question does not cost an approval.

## 1. What one call does, in order

Two halves, and **both always run**. Neither short-circuits the other: an init-half failure is recorded
and the dependency half still runs.

### Step 1 — the init half: local, offline, additive, near-instant

In this order:

1. the managed block in `~/.zshrc` — the shell integration
2. the managed block in `~/.zshenv` — the session-env inheritance
3. the four config migrations, in their recorded order
4. the user-global config seed
5. the repo's agent-instruction files (`CLAUDE.md` guidance blocks) — **non-fatal**; a repo it cannot
   resolve is warned about, not failed on
6. the git-root resolution for writes, warning when the two root gates disagree
7. the Claude Code plugin pointer — `.claude/settings.json`, the plugin install or update (the plugin serves the MCP server), and a read-only report of the repo's `.mcp.json`
8. the per-project config reseed
9. a warning when `$SHELL` is not zsh

Every writer here is additive and never overwrites. Nothing in this half installs software and nothing
reaches the network.

**It runs first deliberately.** Step 1.6 is what makes the MCP surface usable at all, so it must not sit
behind a network converge that can be slow or fail.

### Step 2 — the dependency converge

Five tools, serially, in registry order: **brew, aws, gh, doppler, portless**. Serial and ordered
because the recipes have prerequisites — `gh` and `doppler` both need `brew`, and doppler's own two
steps (gnupg, then the tap) must not interleave with another tool's.

Per tool: install it when it is absent, update it when it is present, skip it when its manager is not
one infra-kit manages. A recipe the risk predicate refuses is **printed, not run** — section 3.

### Step 3 — one combined summary

One line per tool, then the exact argv for every refused recipe, then the `source ~/.zshrc` reminder
last of all.

### How to read the result

- `init` — one entry per step above, each with an `outcome` of `written`, `unchanged`, `skipped` or
  `warned`, and the same message a human would have read.
- `tools` — one entry per requested dependency: `action` (`installed`, `updated`, `skipped`, `refused`
  or `failed`), the `before` state, the `commands` that were run or would have been, and a one-line
  `detail`.
- `converged` — whether the dependency step could act at all. `false` under `skipTools`.
- `changed` — whether anything was installed or updated.
- `allSucceeded` — whether no tool **failed**. **A refusal is not a failure**, so this stays `true` when
  a recipe was printed instead of run.

The process exits non-zero when either half hard-failed. **Do not read a success as "everything is
installed"** — read `tools[].action`, and tell the human about every `refused` entry.

## 2. The flags, and what each one narrows

The default — no flag, no field — converges all five tools.

- `--tools <ids...>` → `tools: ["gh", "doppler"]`. Converge **only those ids**. Same behaviour per
  tool, smaller set. The ids are `brew`, `aws`, `gh`, `doppler` and `portless`.
- `--update [ids...]` → `mode: "update"`. **Never installs.** A tool that is present is updated; a tool
  that is absent is reported `skipped` with the reason, and its install recipe is not run. Given ids, it
  also narrows the set, so `--update gh` is "update gh, and nothing else, and only if it is there".
- `--skip-tools` → `skipTools: true`. A **read-only probe**. The init half still runs — it is local and
  additive — and then each tool is reported with what it needs and the exact argv that would fix it.
  Nothing is installed and nothing is updated.

**`--skip-tools` with `--tools` or `--update` is a usage error, not a precedence rule.** Every
precedence answer is wrong: honouring `--skip-tools` would ignore a set the caller chose, and honouring
the other would install software the caller asked not to install. The call is refused instead.

## 3. Recipes that are printed rather than run

Whether a recipe may run unattended is **computed**, not a per-recipe flag someone set. Two of the four
conjuncts are static and are applied to every recipe unconditionally:

- **`needs-sudo`** — the recipe escalates privilege.
- **`fetches-network-script`** — the recipe pipes a script fetched at run time into a shell.

Two are detection-based: **`manager-absent`** (the package manager the recipe drives is not on this
host) and **`manager-mismatch`** (a different manager owns the binary — running `brew upgrade` against
an npm install, or the vendor's self-updater against a Homebrew keg, is the split-brain infra-kit
refuses for itself).

**Two recipes fail the static conjuncts, and they are the two bootstraps:**

- **the Homebrew bootstrap** — `/bin/bash -c "$(curl -fsSL …/install.sh)"` — fails **both**: it pipes a
  network-fetched script **and** needs sudo on macOS.
- **the first AWS CLI install** — `curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash` —
  needs no sudo (it installs under `$HOME`), but it is still a network-fetched script.

Both are the tools' own documented installers, and neither is a bug to route around. They are refused
**by computation, applied before any detection runs**, which is what makes the refusal trustworthy: it
cannot be widened by a probe getting something wrong, only narrowed.

Once Homebrew exists, `gh` and `doppler` install through it and run unattended; once the AWS CLI exists,
`aws update` is a plain no-sudo recipe and runs. The refusals are a first-install cost, not permanent.

What to do with one: the entry's `commands` array is the exact argv, one string per step. **Show it to
the human and let them run it themselves.** Do not reconstruct it as a `Bash` call — that is the same
unattended `sudo` and the same piped script, with the control removed.

## 4. The confirm gate

`mcp__plugin_infra-kit_infra-kit__setup` is gated, and **both gates fire on every call — `skipTools` included**.

**Call 1** — send the real arguments, with no `confirm` and no `confirmToken`. The result is a gate
payload, `{"status": "confirmation_required", …}`, carrying `"isError": true`.

**That `isError` does not mean the call failed.** Nothing was written and nothing was installed. An
agent that reads it as a failure — and gives up, or retries, or falls back to `Bash` — has skipped the
human approval this protocol exists for. Do none of those. Show the human `resolvedArgs`; that is the
approval moment.

**Call 2** — repeat the **same arguments**, unchanged, plus `"confirm": true` and the `confirmToken`
from call 1. Change any argument between the two and round 2 comes back
`{"status": "confirmation_refused", "reason": "mismatch"}`, which is terminal, not a second gate. Every
refusal reason recovers the same way: call again **without** `confirm` for a fresh gate, then re-call
with the new token. Never retry with the old one.

The tool also carries `anthropic/requiresUserInteraction`, so the host prompts a human even where an
allow rule would otherwise skip it. One install therefore costs two prompts. That is intended: neither
gate substitutes for the other, and neither substitutes for the computed refusals in section 3, which
are the only control that ships inside the CLI itself.

## 5. There is no `init` command

It was removed outright. The binary rejects the name — an instruction that still says to run it fails
at the parser rather than quietly doing something else.

Repos can still say it. A consumer's committed CLAUDE.md block is rewritten only from inside that repo,
so a repo upgrades the global CLI without its own text changing and can sit arbitrarily far behind. So
when a human asks for "init", or a repo's instructions still name it:

- Run **`infra-kit setup`** if they want the tools installed or updated too.
- Run **`infra-kit setup --skip-tools`** (`skipTools: true`) for the additive local writes with nothing
  installed. That is the whole reason the flag exists: without it, removing `init` would have deleted a
  capability rather than renamed one.

Say which one you chose. Running `infra-kit audit --fix` inside that repo rewrites the stale block.

## 6. What not to do

- Do not work around a refusal in section 3 with `Bash`. The refusal is the control.
- Do not read `isError: true` on a `confirmation_required` payload as a failure. See section 4.
- Do not report success from the exit status alone. Read every `tools[].action` and name the refusals.
- Do not call this tool to answer a question. Call `doctor` — it changes nothing and prompts no one.
