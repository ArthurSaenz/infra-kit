---
name: setup
description: Set a machine up for infra-kit through the CLI — the ordered local writes, the dependency converge, the recipes printed instead of run, and the approval.
---

# setup — bringing a machine to a working infra-kit

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

The command is `infra-kit setup`. Everything below is about running that command through `Bash`,
with `--json --agent` on every call.

**Version floor.** Read the block above first. On `{"error": …}`, or a `version` below `0.8.0`, tell
the human to update — `pnpm add -g infra-kit@latest`, or `infra-kit setup` from their own terminal —
and stop. An older CLI answers none of the shapes below.

**cwd.** Every call runs from the directory Claude Code was launched in — the repo root. If the shell
was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`).

The same code runs when a human types `infra-kit setup` in a terminal, so this body describes one
implementation, not two.

Do not reproduce it by hand. A `Bash` call running `brew install`, `curl … | bash` or the writers in
section 1 reproduces none of the refusals in section 3 and skips the approval in section 4 — which is
the only place a human approves an install.

**If all you want is to know what this machine looks like, run `doctor` instead** — the
`/infra-kit:doctor` skill. It reports the same six tools plus the rest of the setup, mutates
nothing, and raises no approval. `infra-kit setup` is the write path; `doctor` is the read path, and
they are separate commands precisely so that asking a question does not cost an approval.

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
7. the Claude Code plugin pointer — `.claude/settings.json`, the plugin install or update (the plugin
   is skills only; the CLI on `PATH` is what they drive), and a read-only report of any `infra-kit`
   key left in the repo's `.mcp.json`
8. the per-project config reseed
9. a warning when `$SHELL` is not zsh

Every writer here is additive and never overwrites. Nothing in this half installs software and nothing
reaches the network.

**It runs first deliberately.** Steps 1.1, 1.2 and 1.7 are what make the skills usable at all, so
they must not sit behind a network converge that can be slow or fail.

### Step 2 — the dependency converge

Six tools, serially, in registry order: **brew, git, aws, gh, doppler, portless**. Serial and ordered
because the recipes have prerequisites — `git`, `gh` and `doppler` all need `brew`, and doppler's own two
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
- `converged` — whether the dependency step could act at all. `false` under `--skip-tools`.
- `changed` — whether anything was installed or updated.
- `allSucceeded` — whether no tool **failed**. **A refusal is not a failure**, so this stays `true` when
  a recipe was printed instead of run.

The process exits non-zero when either half hard-failed. **Do not read a success as "everything is
installed"** — read `tools[].action`, and tell the human about every `refused` entry.

## 2. The flags, and what each one narrows

The default — no flag — converges all six tools.

- `--tools <ids...>` → converge **only those ids**. Same behaviour per tool, smaller set. The ids are
  `brew`, `aws`, `gh`, `doppler` and `portless`.
- `--update [ids...]` → update mode. **Never installs.** A tool that is present is updated; a tool
  that is absent is reported `skipped` with the reason, and its install recipe is not run. Given ids, it
  also narrows the set, so `--update gh` is "update gh, and nothing else, and only if it is there".
- `--skip-tools` → a **read-only probe** of the tools. The init half still runs — it is local and
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

Under agent mode every such recipe is refused with `refusedBecause: ["agent-mode"]` — the human
approved `infra-kit setup` at the host prompt, not brew's own install script, and that reasoning does
not change with the transport.

Once Homebrew exists, `gh` and `doppler` install through it and run unattended; once the AWS CLI exists,
`aws update` is a plain no-sudo recipe and runs. The refusals are a first-install cost, not permanent.

What to do with one: the entry's `commands` array is the exact argv, one string per step. **Show it to
the human and let them run it themselves.** Do not reconstruct it as a `Bash` call — that is the same
unattended `sudo` and the same piped script, with the control removed.

## 4. The approval

`infra-kit setup` is a mutating command with **no confirm step in the CLI**, and the approval fires on
every call — `--skip-tools` included — because the init half writes either way. What stands between
the human and the writes is the host's permission prompt on the argv: `infra-kit setup` is
deliberately absent from this skill's grants, so `infra-kit setup <flags> --json --agent` always
prompts, and the human sees the exact flags before anything runs.

So: say what the call will write and converge (sections 1 and 2), run it **once** with the flags the
human asked for, and read the result. Never add `--yes` — the CLI does not take it, and there is no
preview round to skip. One install therefore costs one prompt plus the computed refusals in section
3, which are the only control that ships inside the CLI itself; neither substitutes for the other.

If the human wants different flags, that is a new call and a new prompt. Do not widen the flags on
your own.

**The exits.** Exit 0 with the result of section 1 — read it as described there.
`{"status": "refused"}` (exit 2) — a usage error or a state only the human can clear; relay and
stop. Non-JSON stdout, or exit 1 with no JSON, is a crash: stop and show stderr.

## 5. There is no `init` command

It was removed outright. The binary rejects the name — an instruction that still says to run it fails
at the parser rather than quietly doing something else.

Repos can still say it. A consumer's committed CLAUDE.md block is rewritten only from inside that repo,
so a repo upgrades the global CLI without its own text changing and can sit arbitrarily far behind. So
when a human asks for "init", or a repo's instructions still name it:

- Run **`infra-kit setup`** if they want the tools installed or updated too.
- Run **`infra-kit setup --skip-tools`** for the additive local writes with nothing installed. That is
  the whole reason the flag exists: without it, removing `init` would have deleted a capability rather
  than renamed one.

Say which one you chose. Running `infra-kit audit --fix` inside that repo rewrites the stale block.

## 6. What not to do

- Do not work around a refusal in section 3 with `Bash`. The refusal is the control.
- Never pass `--yes`; `infra-kit setup` does not take it, and the host's prompt is the approval. See
  section 4.
- Do not report success from the exit status alone. Read every `tools[].action` and name the refusals.
- Do not run this command to answer a question. Run `doctor` — it changes nothing and prompts no one.
