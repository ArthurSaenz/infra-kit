> Archived 2026-09-15 — the infra-kit MCP server is being retired; see .omc/plans/mcp-to-cli-skills-migration.md.

# MCP proxy generalization — plan (RALPLAN-DR, deliberate)

> Status: **pending approval** — planning artifact only, nothing implemented.
> Date: 2026-09-12 · Revision 5 — **consensus reached.** Critic: APPROVE (rev 2 ITERATE → rev 4
> APPROVE-with-four-text-corrections → applied here). Architect r2: sound with conditions, all
> applied. Awaiting the human go/no-go.
> Predecessors: `docs/grafana-mcp-port-plan.md` (rev 4, executed: phases 0–3 of the Grafana shim),
> `docs/grafana-mcp-plan.md` (design + measured facts + probe results).

The Grafana shim in the working tree is ~90% credential-agnostic already. This plan turns the
remaining 10% — three constants — into a record in `infra-kit.json`, so one dist entry serves any
stdio MCP server whose credentials arrive through `ik env-load`.

**Revision 2 changes the architecture.** Rev 1 asked "how does the shim read `infra-kit.json`
without `zx`" and spent its effort on a pure/IO split of the config loader. The Architect asked
the prior question — *should the shim read config at all* — and the answer is no: every other
artifact the shim consumes (`env-load.sh`) is **written by `ik`**, and the CLI already ships a
merge-safe `.mcp.json` writer wired into `ik setup`. The shim consumes **argv only**.

---

## Principles

1. **The shim may never fail a handshake.** Carried over unchanged. New degraded state: malformed
   argv (no `--`, no `--env`). It answers `initialize`, serves zero tools, and says exactly what is
   wrong on stderr and in every `-32000`.
2. **One parser for `infra-kit.json`, and it lives in `ik`.** The shim never opens that file. The
   `mcp` block is parsed by `infraKitConfigObject` through the ordinary three-layer
   `getInfraKitConfig()`; what reaches the shim is a *derived* argv that `ik` wrote and `ik audit`
   guards for drift — the same relationship `ik` has with `env-load.sh` and the CLAUDE.md blocks.
3. **The shim's bundle stays flat.** Node builtins only — not even `zod`. Enforced by the
   chunk-isolation guard, extended to grep the `"zx"` import **specifier** transitively across the
   entry and every chunk it imports (see the corrected mechanism under driver 1).
4. **Generalize by deletion.** The finished diff removes the word "grafana" from `src/lib` and
   adds no feature that no consumer needs today.
5. **Every defect the previous plan fixed stays fixed.** D1–D10, M1–M5, N1, N2 and the review-round
   fixes are guarded by tests that must all still pass, re-parameterised but not weakened — counted
   by name before and after.

## Decision drivers

1. **`zx` must not load in the shim process — and the mechanism is subtler than rev 1 said.**
   Measured with a probe entry built with the real `buildOptions`: esbuild *does* tree-shake the
   unused loader code, but **retains bare `import "zx"` statements**, because `zx` is externalized
   and its package.json carries no `sideEffects: false`, so the bundler must preserve the import
   for its side effects. A dynamic `await import()` moves the loader into a separate chunk that
   still imports `zx` — the guard passes and `zx` loads at runtime anyway. So neither
   `sideEffects` nor lazy import rescues "reuse the loader", and a guard that greps for git
   command strings would be blind; it must grep the `"zx"` specifier, transitively.
2. **The `.strict()` schema plus a self-updating CLI is a rollout hazard for `ik`, not for the
   shim.** `getInfraKitConfig` throws on unknown keys and runs as a guard on every command. A
   consumer that writes `mcp:` before its global CLI accepts it breaks *all* of `ik` on that
   machine. The shim never calls the loader, so it is unaffected — but the feature still ships
   the key, so the release order is still a correctness property.
3. **Zero migration cost today, real cost after a release.** Nothing is published; `ik-grafana` is
   in no consumer `.mcp.json`; phase 4 has not baked "grafana" into doctor.

---

## Viable options

### Q1 — how the shim learns its spec

**A. Reuse `getInfraKitConfig()` in the shim.** Rejected: loads `zx` (driver 1) and two
`git rev-parse` spawns into a long-lived MCP server.

**B. Inject root resolution / lazy-import the loader.** Rejected on the measured mechanism above:
the `import "zx"` survives into a chunk; the process still loads it.

**C. Split `infra-kit-config` into pure `schema.ts` + IO loader; shim reads layer 1 by a cwd
walk.** *Rev 1's choice, withdrawn.* Two defects the Architect showed: (i) the cwd walk is **not**
the loader — `getInfraKitConfigPaths` resolves `<git rev-parse --show-toplevel>/infra-kit.json`
with no walk, so the two disagree in a worktree that lacks the file, or outside git; (ii)
"layer 1 only" is a two-readers problem in disguise — `infraKitOverrideConfigSchema` is
`.partial()`, so `mcp` is *accepted* in layers 2 and 3, `ik config-get` would show it, and the shim
would silently ignore it. Also puts `zod` in the shim. Still the right fallback if F2 is ever
blocked.

**D. Shim-local schema.** Rejected: a second parser for one file.

**E. Remove `zx` from `git-utils`.** Raised by the user mid-plan and measured: **25** `$` call
sites, **35** non-test `zx` importers repo-wide, **47** test files mocking `zx` of which **29**
touch `git-utils`. A rewrite of the git backbone plus up to 29 re-seamed tests, to reach a result
F2 reaches with zero of that. Rejected on cost; recorded so it is not re-proposed.

**F1. Argv only, no config.** The consumer writes the full argv into `.mcp.json` by hand. No
schema, no S1. Rejected: no canonical source for doctor, spec duplicated per host file, and it
throws away the user's stated want — declare the servers in `infra-kit.json`.

**F2. Config is the source; `ik` derives the argv; the shim consumes argv** *(chosen)*.
- `mcp` lives in `infra-kit.json`, parsed by the existing loader — the only reader — and refused
  outside layer 1 (Q2), because it is the one key that feeds a committed artifact.
- `ik setup` (already calls `ensureMcpRegistration(root)` at `init.ts:694`) and `ik audit --fix`
  write one `.mcp.json` entry per configured server with the **resolved** argv, through
  `src/lib/plugin-pointer/mcp-registration.ts` — shipped, merge-safe, tested against read-only and
  tab-indented files.
- `ik audit` reports drift between config and `.mcp.json`, exactly as it does for CLAUDE.md marker
  blocks.
- The shim parses argv with a ~30-line hand parser. Node builtins only.
- **Cons, stated:** a spec change needs `ik setup` (or `audit --fix`) plus a client restart —
  identical to how the existing `infra-kit` MCP key already behaves; the "unknown name recovers
  mid-session" behaviour of rev 1's Q4 is gone, and it is not missed, because argv is frozen at
  spawn and the dynamic half that matters — credentials — is unchanged. `.mcp.json` grows one
  verbose machine-written line per server.

### Q2 — configuration layers

Rev 2 said "dissolved — `mcp` behaves like every other key". **That was wrong, and the Critic
showed why with the source:** the layer merge at `infra-kit-config.ts:522` is
`merged = { ...merged, ...data }` — **shallow**. Layer 3 is per-machine and auto-seeded. So a
developer who adds `mcp.mydb` to `~/.infra-kit/projects/<repo>/infra-kit.json` gets a merged `mcp`
of `{ mydb }` **only** — layer 1's `grafana` is gone on that machine — and `ik setup` would derive
that into a **committed, shared** `.mcp.json`. Every other key *is* meant to be per-machine
overridable; `mcp` is the one key that feeds a committed artifact, so it cannot be.

**Decision: `mcp` is layer-1-only, enforced loudly, by the one parser.** `loadLayer` rejects `mcp`
in any layer with `required === false` — the exact pattern already used for `envTokens` at
`infra-kit-config.ts:664` — with a message naming the file and saying where the key belongs. This
is *not* rev 1's sin returning: rev 1 was faulted for a **second reader** that *silently ignored*
layers 2/3. One reader that *refuses* them has no two-readers problem and no silence.

**The legitimate per-machine case has a home — it is just not `ik`.** A developer testing a local
fork of an MCP server wants a machine-only override of `command`. Claude Code already owns that
layer: `claude mcp add --scope local grafana -- ik-mcp --name grafana --env … -- ~/go/bin/mcp-grafana-dev -t stdio`
writes to `~/.claude.json` under the project path and **shadows the project `.mcp.json` entry by
name** — verified against Claude Code's scope-precedence documentation: the highest-precedence
source's *whole* entry wins, fields are not merged, local outranks project. (Caveat for the
message: a same-name definition in two scopes shows a persistent conflict warning in
`claude mcp list` / `/mcp`. Harmless, but the developer will see it.) No derive, no committed file, no `ik` code, and the shim is unchanged because it only ever
sees argv. Deriving into `~/.claude.json` ourselves would mean writing Claude's private state file,
whose shape is not ours to own. So the refusal message **names that recipe**, so the developer who
reached for layer 3 lands on the right tool. Like `envTokens`, the refusal throws from `loadLayer`
and every `ik` command on that machine is red until the key is removed — self-inflicted, local,
targeted, and it says exactly what to do.

Three adjacent surfaces this touches, decided here: `ik config-get` calls `getInfraKitConfig()` and
will throw the loader error — consistent, keep; but its tool description (`config-get.ts:59`) says
"use `config edit` to modify the override file", and `config edit` (`config.ts:100-102`) opens
exactly the file where `mcp` is now refused — **both strings are updated**. `ik config`
(`config.ts:42`, `readOverrideSummary`) reads layer 3 directly and lists `mcp` among the override
keys **without** throwing — that is how the user sees the offending key, so it is **deliberately
left as is** and recorded here so nobody later "fixes" it to throw.

### Q3 — bin name

`ik-mcp`. No `ik-grafana` alias: never published, never referenced.

### Q4 — degraded states

Malformed argv (missing `--`, missing `--env`, missing or invalid `--name` — the shim re-checks
the `^[a-z][a-z0-9-]*$` rule itself, with builtins, because the name becomes a cache subdir) is
**the same state as "no credentials yet"**: answer `initialize` with `serverInfo: { name: 'ik-mcp', version }` and the pinned fallback
capabilities, `tools/list` → `[]`, every other request → `-32000` quoting the argv problem and
saying `run ik setup`. Nothing exits, nothing throws at startup. **The watcher polls env only** —
there is no config to poll, so there is no mid-edit "invalid config" window and no path by which a
watcher could tear down a live upstream (principle 1 preserved by having less machinery, not more).

### Q5 — version probe

`--version` only, **not configurable in v1** — principle 4: `mcp-grafana` answers `--version`,
and no consumer has a server that does not. On non-zero exit / timeout / empty output the cache key
falls back to `stat`-derived `<size>-<mtimeMs>` of the resolved binary, which is what a binary
without `--version` gets. Dropping `versionArgs` also removes the one argv field whose values could
themselves contain commas or `--`, which is what made the rev 2 encoding unsound. Lazy, as today.

### Q6 — how doctor consumes this (phase 5, not this plan)

`report.ts` keeps a static inventory. Phase 5 adds **one** static check, `mcp proxies`, whose
detail lines list each configured name with binary-present / env-resolvable / `.mcp.json`-in-sync
status. Recorded here; not implemented here.

### Q7 — migration of the existing code

A **rename plus parameterisation**, not a rewrite:

| today | after |
| --- | --- |
| `src/lib/grafana/` | `src/lib/mcp-proxy/` |
| `credentials.ts` — `readGrafanaCredentials()` → `{url, token}` | `env-vars.ts` — `readListedVars(names)` → `Record<string,string> \| null`, built **in `names` order**; `readUnlistedNames(names)` |
| `upstream.ts` — `GrafanaCredentials`, hardcoded child env | `upstream.ts` — `ProxySpec { name, command, args, env, unset }` + `ProxyVars`; respawn key = JSON of the ordered vars record |
| `cache.ts` — subdir `grafana` | subdir `<name>`; `--version` + stat fallback |
| `upstream.ts` — `goBinDir()` prepends `$GOBIN`/`~/go/bin` to the child PATH | **kept, unconditionally, and named here as a semantic carry-over**: it is Go-specific in origin but harmless for every other server (one extra PATH dir), and removing it would break the only server that exists today when Claude is GUI-launched |
| `dist-shebang.test.ts` asserts `bin['ik-grafana'] === 'dist/grafana-stdio.js'` | asserts `bin['ik-mcp'] === 'dist/mcp-proxy.js'` — the **bin** assertion renames too, not only the hashbang case |
| `line-stream.ts` | unchanged |
| `src/entry/grafana-stdio.ts` | `src/entry/mcp-proxy.ts` — hand argv parser; degraded state on bad argv |
| `MCP_GRAFANA_BIN`, `MCP_GRAFANA_POLL_MS`, `MCP_GRAFANA_ENV_FILE` (test/override env vars) | `IK_MCP_POLL_MS`, `IK_MCP_ENV_FILE`; `MCP_GRAFANA_BIN` **deleted** — the command is argv now |
| pinned fallback capabilities `{ resources: {}, tools: { listChanged: true } }` | `{ tools: { listChanged: true } }` — **a semantic change with its own test row**, not a no-op: claiming `resources` for a resource-less server makes a client issue `resources/list` and get "method not found" |
| bin `ik-grafana` | bin `ik-mcp` |

Everything else — id namespace, deadlines, redaction-last, `NEVER_STRIP`, deferred initialize,
profile cache, env watcher, framing — moves without semantic change.

---

## The `mcp` schema and the derived argv

```ts
// src/lib/infra-kit-config/infra-kit-config.ts — alongside devPresetsSchema
// Does not exist yet (rev 2 cited it as if it did): a POSIX env-var name. Comma-free by
// construction, which is what lets the argv below be unambiguous.
const envVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)

const mcpProxySchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Names read from env-load.sh. ALL non-empty = "credentials present". The ordered value tuple is the respawn key. */
    env: z.array(envVarName).min(1),
    /** Forced empty in the child — generalises blanking GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE so a stale file cannot win. */
    unset: z.array(envVarName).default([]),
  })
  .strict()
  .superRefine(/* env ∩ NEVER_STRIP = ∅ */)

// `infra-kit` is refused as a name, and so is any name CONTAINING it: install-state.ts:205 classifies a
// server as the infra-kit one by `\`${command} ${args}\`.includes('infra-kit')`, so `infra-kit-docs`
// would read as a misfiled infra-kit server.
export const mcpProxiesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]*$/).refine((n) => !n.includes('infra-kit')),
  mcpProxySchema,
)
// infraKitConfigObject gains `mcp: mcpProxiesSchema.optional()`
```

```jsonc
// infra-kit.json (the source)
"mcp": {
  "grafana": {
    "command": "mcp-grafana", "args": ["-t", "stdio"],
    "env": ["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"],
    "unset": ["GRAFANA_API_KEY", "GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE"]
  }
}
// .mcp.json (derived by `ik setup` / `ik audit --fix`, guarded by `ik audit`)
"grafana": {
  "type": "stdio", "command": "ik-mcp",
  "args": ["--name", "grafana",
           "--env", "GRAFANA_URL", "--env", "GRAFANA_SERVICE_ACCOUNT_TOKEN",
           "--unset", "GRAFANA_API_KEY", "--unset", "GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE",
           "--", "mcp-grafana", "-t", "stdio"]
}
```

**Argv encoding rules** (rev 2 used comma lists; the Critic showed that is unsound the moment a
value can contain a comma, and unambiguous only by accident): **repeated flags, one value each**
(`--env X --env Y`), accumulated in order; the parser stops at the **first `--` in flag position**
and passes everything after it verbatim, so an upstream that is itself `--`-prefixed or takes `--`,
`--name` or commas is unaffected. This is unambiguous for *derived* argv because neither
`envVarName` nor the name regex can start with `-`. For *hand-written* argv it is unambiguous only
if the shim **validates every flag value, not just `--name`**: `--env --` would otherwise consume
the separator as a value and misparse the upstream command into a flag — worst case a wrong binary
spawned rather than a degraded state. So the shim checks `--env`/`--unset` values against
`envVarName`, refuses a duplicate `--name`, and treats a dangling flag at argv end as malformed —
all landing in the Q4 state, so principle 1 holds; `--env` is emitted for every listed name, `--unset` only for non-empty lists — that
optional-field behaviour is pinned by the goldens below, because derive and parse share it and
would otherwise agree on any wrong answer.

Semantics, stated once:

- **`env`** — read from the session env file (fallback `process.env`), injected inline. Present only
  when every listed name is non-empty. The record is built by iterating `env` in **config order**,
  so its JSON is a stable respawn key regardless of how Doppler orders the file; a change to any
  listed value replaces the child.
- **`unset`** — always empty in the child, even if the parent has it.
- **`args`** — passed through verbatim after `--`. **No `${NAME}` interpolation in v1**: a credential
  in argv is visible to *every* user via `ps aux` (env is visible only to the same user), and no
  consumer today runs a flag-only server. Principle 4 says do not add it until one exists.
- **Redaction** — child env = parent env, minus every env-file name not in `env`, minus `unset`,
  plus `env` inline, `NEVER_STRIP` honoured. Unchanged mechanism, now argv-driven. `env ∩ NEVER_STRIP`
  is a schema refinement error at `ik` time, so it never reaches the shim.
- **Ownership and the writer contract.** `ensureMcpRegistration` today is deliberately
  **add-only, never-overwrite** (`mcp-registration.ts:14-19`) — the right contract for the
  `infra-kit` key, which a consumer may have hand-tuned, and the *opposite* of what drift-rewrite
  needs. So the contract **forks by ownership**, decided here rather than discovered in code:
  - `infra-kit` key — unchanged: add when absent, never overwrite.
  - **Owned** entries — `command === 'ik-mcp'` **under a configured name** — are drift by
    definition: config is authoritative for that name, so `audit` reports and `--fix` **rewrites**
    `type`/`command`/`args` and **preserves every other field** on the entry (Claude Code accepts
    `env` there; a rewrite must not eat it — tested).
  - **An `ik-mcp` entry whose name is NOT in config is an audit *failure* — red in `qa`, non-zero
    exit, exactly like a stale CLAUDE.md marker block — never removed.** "Reported" would be
    decorative otherwise, and the residual hole (the entry keeps spawning the old command with the
    old env names until someone acts) would be real. The message names the fix:
    `claude mcp remove <name> --scope project`, or delete the line. Rev 3 had `--fix`
    remove it; the Architect showed two reasons that is wrong. First, `command === 'ik-mcp'` is
    sufficient to say "config owns this *name*", not "`ik` wrote this *entry*": a developer testing
    a fork will hand-write `"grafana-dev": { "command": "ik-mcp", … }` precisely because it is the
    easiest way to try the shim, and anyone using the shim argv-only never has a config entry at
    all — `--fix` would delete their work. Second, and worse, removal **composes with S5**: "invalid
    config → zero derived entries" makes an empty derived set indistinguishable from "every name
    left config", so a typo in an *unrelated* key would delete every `ik-mcp` entry from the
    committed file on the next `--fix`. The rule that decides it: **`--fix` writes only what it can
    regenerate**. It cannot regenerate a hand-written entry, so it must not delete one. The report
    line is a one-line manual fix with no false-positive cost. This also makes the writer a pure
    idempotent function of config, which is exactly the property the drift goldens assert.
  - A **foreign** entry under a configured name (someone hand-wrote `"grafana"` pointing at a raw
    `mcp-grafana` with an inline token) is **refused**, not clobbered — `audit` reports it as a
    conflict with the fix spelled out, and `--fix` leaves it alone.
  - Foreign entries under other names (`linear-server`, `chrome`) are never touched.
- **`ik setup` must not gain a new way to fail.** `init.ts:685-708` runs plugin-pointer sync and MCP
  registration inside one `try`, and `syncPluginPointer` deliberately does not require an
  `infra-kit.json`. Derivation therefore runs in **its own guarded step**, with its **own `step` label** in
  `initCore`'s report — the existing catch hard-codes `step: 'plugin-pointer'`, so a derive failure
  inside it would be misattributed. Absent or invalid config → the writer is a **no-op that
  reports**, never a throw, and — the S5 corollary — **never a reconcile**: it writes nothing rather
  than writing "the empty set".
- **Where `audit` runs.** In this repo, root `qa` reaches `infra-kit audit --root` through the
  `infra-kit-check` script chain (`package.json:37-38`). Two caveats the S2 guard depends on:
  `.github/workflows` runs no `qa`, so this is a **local** gate; and consumer repos' `qa` wiring is
  unverified — phase 4 checks it. The drift check is `--root`-scoped and must not throw in a repo
  without `infra-kit.json`.

Contract stated in the schema JSDoc and here: **the proxy is for stateless servers.** A respawn
discards in-memory state; a browser-automation server would lose its tabs on every `env-load`.
OAuth-flow servers and config-file-only credentials are out of scope.

---

## Pre-mortem — six ways this fails

**S1 — a consumer writes `mcp:` before its CLI accepts it, and every `ik` command dies.**
`infraKitConfigObject` is `.strict()`, `getInfraKitConfig` throws on unknown keys on every
command, and the global CLI self-updates silently. *Guard:* the schema ships in a CLI release
**before** any consumer commits an `mcp` entry; the consumer commit's description names the
minimum CLI version. Phase 4 is this ordering and nothing else. (Correctly scoped: this is an
`ik` hazard; the shim never calls the loader.)

**S2 — `.mcp.json` drifts from `infra-kit.json` and nobody notices.**
A developer edits `mcp.grafana.env` and forgets `ik setup`; the shim keeps reading the old names
until the next restart *after* a re-derive. *Guard:* `ik audit` (which runs in root `qa`) reports
the drift, and the shim's startup log prints the argv it was given, so the mismatch is readable in
Claude's MCP pane. Residual: a developer who ignores a red audit.

**S3 — someone configures a stateful server and loses state on every `env-load`.**
Not observable from outside. *Guard:* contract in the schema JSDoc and in the `-32000` text for an
in-flight request killed by a respawn ("upstream replaced after a credential change"). Accepted.

**S4 — layer 3 shallow-merges into a committed file.** The failure rev 2 did not see: a
per-machine `mcp` override replaces the project's block wholesale (`:522`), `ik setup` derives it,
and either `audit` goes red on that one machine or the developer commits their machine's
derivation and everyone else's `.mcp.json` loses `grafana`. *Guard:* Q2's refusal in `loadLayer`
— the override never parses, so nothing downstream can derive from it — plus a schema test that a
layer-3 file carrying `mcp` fails with the targeted message.

**S5 — `ik setup` starts failing on machines that never had a config problem.** Derivation added
inside the existing `try` would turn a bad `mcp` block into a skipped plugin install. *Guard:* the
separate guarded step above, a test that `ensureMcpRegistration` with no config still writes the
`infra-kit` key, and — because this scenario composes with any destructive write — **no destructive write
exists**: invalid config is a no-op, and stale entries are only ever reported.

**S6 — the rename silently drops a guarded behaviour, or adds a fake no-op.**
Twenty-odd tests encode defects from two review rounds; a rename that "cleans up" a test because it
says Grafana can delete a guard — and rev 1 itself mislabelled the capabilities change as a no-op.
*Guard:* phase 2's exit criterion is the test list by name before and after, every semantic change
has its own row, and the Grafana leak fixture stays verbatim (it tests the parser; the names are
data).

---

## Phases

**Phase 1 — schema + derivation in `ik` (no shim changes).**
Add `envVarName`, `mcpProxySchema`, `mcpProxiesSchema` to `infra-kit-config.ts` and `mcp` to
`infraKitConfigObject`; reject `mcp` in non-required layers via the `:664` pattern. Add a pure
`deriveMcpEntry(name, spec) → { command: 'ik-mcp', args }`. Extend `ensureMcpRegistration` with the
forked ownership contract above, in its own guarded step in `init.ts`. Add the `--root`-scoped
drift check to `audit` and rewrite — **never remove** — to `audit --fix`.
- *Exit:* schema tests (accept the example; reject unknown keys, empty `env`, bad names, a name
  containing `infra-kit`, `PATH` in `env`; a config without `mcp` still parses; **a layer-3 file
  with `mcp` is refused with the targeted message**); derivation goldens for: the example, empty
  `unset` (no `--unset` emitted), `args` containing `--` and `--name`; writer tests: adds N owned
  entries beside `infra-kit`; leaves foreign names alone; rewrites a drifted owned entry only under
  `--fix`, preserving its other fields; **reports and never removes** an `ik-mcp` entry whose name
  is not in config; **writes nothing when config is invalid** (a typo in an unrelated key leaves
  every `ik-mcp` entry untouched under `--fix`); **refuses** a foreign entry under a configured
  name; **still writes `infra-kit` when there is no config at all**; the derive step reports under
  its own label; `pnpm run qa` green modulo the three known pre-existing reds — named once so nobody has to
  re-derive them: `publish-lifecycle.test.ts` and `lockstep.test.ts` (both
  `@slip-stream-kit/config@0.4.0` vs `infra-kit@0.5.2` drift) and the eslint
  `regexp/no-contradiction-with-assertion` at `dependency-install.ts:150` (the dirty `setup`
  workstream's). Touches
  `init.ts`, `audit`, `mcp-registration.ts`, `infra-kit-config.ts` — **verified clean** in
  `git status`, none belong to the dirty `setup` workstream, so phase 1 is unblocked.

**Phase 2 — generalise the library (`src/lib/grafana/` → `src/lib/mcp-proxy/`).**
Per the Q7 table. Fixture gains multi-variable expectations.
- *Exit:* every pre-existing test present by name and passing; new tests for: ordered two-variable
  respawn key (either value changes → respawn; env-file key order does not); `unset` blanking;
  stat fallback when `--version` fails; `NEVER_STRIP` unchanged; fallback capabilities no longer
  claim `resources`. `pnpm run qa` green.

**Phase 3 — the entry (`src/entry/mcp-proxy.ts`) and packaging.**
Hand argv parser (repeated flags, first-`--` rule, name re-validated); Q4 degraded state; bin
`ik-mcp`, `ik-grafana` removed; `IK_MCP_*` overrides.
Guards: positive hashbang case renamed; chunk-isolation asserts `commander`, the `cli.ts` marker,
and the **`"zx"` specifier** are absent from `mcp-proxy.js` **and from every chunk it statically
imports**; a `zod` absence assertion too, since F2 needs none.
- *Exit:* e2e against the built bundle: a full argv → the four-step sequence; malformed argv →
  handshake answered, `[]`, `-32000` naming the problem; two different argv specs in two sessions
  from one bundle. Live smoke against real `mcp-grafana` via an argv derived from a `grafana`
  entry in this repo's `infra-kit.json`, expecting 72 tools.

**Phase 4 — release ordering (not code).**
CLI release carrying the schema **first**. Then a consumer commit adding `mcp.grafana` + running
`ik setup`, committing the derived `.mcp.json` line, with the minimum CLI version in the
description.

**Phase 5 (gated, unchanged) —** doctor `mcp proxies` check after the `setup` workstream lands;
Doppler provisioning.

---

## Test plan (deliberate)

**Unit** — schema: the cases above, including the layer-3 refusal. `deriveMcpEntry`: goldens for
the example, for empty `unset`, and for `args` containing `--`/`--name`; stable across runs. The
derive → parse → equal-spec round-trip **is not sufficient alone** — derive and parse share the
optional-field encoding and would agree on any wrong answer — so it is paired with an
**asymmetric** case: one hand-written argv parsed against a literal spec, and one hand-written spec
derived against a literal argv. `env-vars.ts`:
every case the Grafana credentials tests covered (multiline hijack, XDG, no session, absent /
empty / dir, precedence), over a caller-supplied name list; the leak fixture verbatim; record
built in `names` order; `readUnlistedNames` excludes exactly the listed names. Argv parser: the
example; missing `--`; missing `--env`; missing / invalid / duplicate `--name`; an invalid `--env`
value (including `--env --`); a dangling flag at argv end; repeated `--env` accumulate in order; a
second `--` after the first is passed to the upstream verbatim; an upstream command that is itself
`--`-prefixed.

**Integration** — `upstream.ts` with a `ProxySpec`: the eighteen existing lifecycle cases plus the
phase-2 additions. `ensureMcpRegistration`: writes N derived entries beside `infra-kit`; leaves
foreign entries alone; reports drift; `--fix` rewrites only the drifted `ik-mcp` entries.

**E2E** — the built `mcp-proxy.js`: malformed argv answers the handshake and stays alive; the full
Grafana sequence via derived argv; a second spec with a different variable set proving one bundle
serves two specs.

**Observability** — startup log prints the parsed spec (name, command, env names — never values)
and the env-file path; bad argv logs the exact reason once.

**Known gaps** — concurrency under load (unchanged); a stateful upstream (S3, by design).

---

## ADR

**Decision.** Generalise the Grafana shim into `ik-mcp`, a stdio MCP proxy whose spec is a record
under `infra-kit.json → mcp`, parsed by the existing three-layer loader in `ik`, **derived** into a
`.mcp.json` argv by `ik setup`/`audit --fix` through the shipped merge-safe writer, guarded for
drift by `ik audit`, and consumed by the shim as argv alone.

**Drivers.** (1) `zx` must not load in the shim, and the measured bundler behaviour (externalized
side-effect imports survive tree-shaking and lazy import) rules out every "reuse the loader"
variant. (2) The strict schema plus self-update makes release order a correctness property for
`ik`. (3) Nothing has shipped.

**Alternatives considered.** Reusing the loader (A) and lazy-importing it (B) — `zx` loads either
way. Splitting the loader (C) — rev 1's choice; withdrawn because the cwd walk is not the loader
and it made the shim a **second, silent reader** of the same file — one that would ignore a layer-3
`mcp` the CLI accepted. The layer-1-only *policy* survived into F2; what did not survive is having two
readers, one of which says nothing. A
shim-local schema (D). Removing `zx` from `git-utils` (E) — 25 sites / 29 test files. Argv with no
config (F1) — no canonical source.

**Consequences.** The shim gains **zero** runtime dependencies (rev 1 would have added `zod`).
`infra-kit-config.ts` is touched only to add a key — no split. `ensureMcpRegistration` grows from
one add-only entry to a forked contract: add-only for `infra-kit`, rewrite-preserving-other-fields for
`ik-mcp` entries under a configured name, report-only for `ik-mcp` entries under an unconfigured
name, refuse for foreign entries under a configured name. **`--fix` deletes nothing.** `ik audit` gains a `--root`-scoped drift
check. `mcp` is the one config key refused outside layer 1, because it is the one that feeds a
committed artifact. A spec change
costs `ik setup` + client restart, as the `infra-kit` key already does. Every new MCP server with
env-borne credentials is a config entry, not a code change. `${NAME}` interpolation and a configurable version
probe are deliberately absent until a consumer needs them.

**Follow-ups.** Removal of stale owned entries under `--fix`, if a real provenance signal (an
`ik`-written marker on the entry) ever makes it safe. `versionArgs` when a server without
`--version` appears. `${NAME}` in args when a flag-only server appears (with the `ps aux` caveat in its
doc). Doctor `mcp proxies`. Doppler `GRAFANA_*`. Whether `ensureMcpRegistration` should also emit
entries for other MCP hosts' config files, now that the derived argv is host-neutral.
