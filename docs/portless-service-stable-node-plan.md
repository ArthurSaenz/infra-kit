# Plan: a stable Node for the portless system service

**Status: approved by the user and implemented 2026-09-17** (the commit that adds §5.9) · RALPLAN-DR, deliberate mode · successor to
`docs/portless-service-stable-path-plan.md` (Option A, shipped in `16a954d`). Ticket prefix `[DO]`.
Iteration 2 — Architect ITERATE (mechanism re-measured: `copyFile(FICLONE)` is a full copy on this Mac,
`linkSync` is the 0-byte primitive; health-resolved command seam; `PortlessLinkLog` discriminant; ctime/
`refreshedAt` not mtime), Critic ITERATE (option E "just edit the plist" invalidated in full; dev-server
test mapping; node-row fixture coverage; e2e ordering from the global install; plain-language answers block).
Iteration 3 — Architect ITERATE, three blockers verified on this machine: the integration test's "replace the
file" step would have truncated the developer's real node through the shared inode (macOS enforces no
`ETXTBSY`); every `process.execPath` site cited for "the daemon re-spawns" is a client command handler, the
daemon itself spawns nothing; `link(2)` on macOS fails with more than `EXDEV/EPERM/EMLINK`. All three are
folded in below; the shared-inode write hazard is now a named tension (§5.7).
Iteration 4 — Architect APPROVE; Critic ITERATE, three narrow fixes: "healthy" now means "N8 reached" so a
copy-path file can be the stable node; the "daemon predates" clock is `versionChangedAt`, not the relink
clock, so a same-version relink never nags for a restart; the §9 grep set and T-1's honesty about what
doctor cannot detect through a shared inode.
Iteration 5 (final) — Architect ITERATE, one blocker: the hardlink fast path never repaired a sidecar that
lied about the version (crash between the two renames after a Node bump → N8 wrong forever, T7's clock
too old → fewer advisories, not more); the fast path now also requires the sidecar's version triple to
match the process, and PM-4/PM-6/ADR are aligned with §5.1's corrected detection limits.
**Consensus: Architect APPROVE (iteration 5), Critic APPROVE (iteration 5)** — three doc-polish notes from
the final Critic pass folded in (§5.4 clause (a) names the sidecar triple; integration step 4 asserts
`versionChangedAt` unchanged; PM-6 says the two-version flip is perpetual).

This plan inherits every decision of its predecessor and re-litigates none of them: silent auto-update
stays; `~/.infra-kit/portless` stays and is still re-pointed on every global-install boot; no infra-kit
code runs as root; `setup` and `doctor` PRINT the sudo line and never spawn `sudo` (a sudo re-exec needs a
TTY the CLI does not have); the `.git`-ancestor `isGlobalInstall` gate is the only thing between a checkout
and the root daemon.

## 1. Problem

The predecessor made `argv[1]` of the daemon stable. `argv[0]` — the Node binary — is not, and it is the
half that broke this machine twice in four days:

```
ProgramArguments = [ /Users/arthur/Library/pnpm/global/v11/60d8-…/node_modules/.pnpm/node@runtime+24.21.0/node_modules/node/bin/node,
                     /Users/arthur/.infra-kit/portless/dist/cli.js, proxy, start, --foreground, --port, 443 ]
```

- `service install` bakes `process.execPath` into the plist (portless `dist/cli.js:3804`), and Node
  **realpaths** `execPath`, so no symlink in front of the binary survives into the plist.
- Under pnpm 12, Node itself is a global package (`node@runtime`) inside a `global/v11/{pid}-{timestamp}/`
  project dir. That dir is re-minted by global installs — it was re-created today at 11:24 with **no** Node
  version change — and 19 such entries exist under `global/v11`. The plist dangled without a Node bump.
- The other candidates are no better: `~/Library/pnpm/bin/node` is pnpm's Mach-O launcher (re-execs the
  real node; `execPath` still resolves deep), and `~/Library/pnpm/nodejs/<ver>/bin/node` changes per Node
  bump (the 24.18.0 breakage in the progress doc).
- The printed fix line is therefore still ~200 characters of path that is wrong within days.

### Answers, in plain words

- **Where the daemon is defined.** `/Library/LaunchDaemons/sh.portless.proxy.plist` — a root-owned file that
  `portless service install` writes (`portless-driver.ts:184`; on Linux it is
  `/etc/systemd/system/portless.service`). Its first two argv words today are the deep pnpm node path above
  and `/Users/arthur/.infra-kit/portless/dist/cli.js`. `~/.infra-kit/portless` is the symlink the
  predecessor added; `~/.infra-kit/node` is the file this plan adds beside it.
- **How the stable half works today.** Every CLI or `ik-mcp` start from a *global* infra-kit re-points
  `~/.infra-kit/portless` at the portless it ships (`bootPortlessLink`); `doctor` reads the plist back and
  says whether the daemon's two words are the stable ones. This plan makes the node word stable the same
  way: converged at boot, verified by doctor, written into the plist by one sudo.
- **`global/v11` vs pnpm 12.** `v11` is pnpm 12's global *layout* version directory; `global/5` is the dead
  pnpm ≤ 11 layout. It is not a pnpm-version mismatch and nothing here depends on it.
- **The command, after this ships.** Run once per machine, from the global install:
  `sudo /Users/arthur/.infra-kit/node /Users/arthur/.infra-kit/portless/dist/cli.js service install`.
  Neither an infra-kit release nor a Node bump makes you run it again.

### Measured facts this design rests on (this machine, 2026-09-17)

| # | Fact | Evidence |
|---|---|---|
| 1 | `fs.linkSync(execPath, X)`: 0.3 ms, 0 bytes, in-process; `X -p process.execPath` prints `X` (a hardlink is a regular file; Node realpaths nothing); `codesign -v X` passes; the source is `nlink=1 mode=0755 uid=501` — a plain extracted file, not a pnpm-store hardlink | Architect scratch run; `stat -f` |
| 2 | `fs.copyFileSync(src, dst, COPYFILE_FICLONE)` on this Mac is a **full copy** — 134 MB allocated (`st_blocks` 262272 vs the source's 238536), 47–100 ms, mtime = now; `COPYFILE_FICLONE_FORCE` throws `ENOSYS`. `cp -c` (3 ms, 0 bytes) is the only clone path, and it is a subprocess that also keeps the source mtime | Architect scratch run |
| 3 | pnpm, Homebrew, volta, fnm all replace a Node binary by unlink + rename; none writes in place. **macOS enforces no `ETXTBSY`**: `openSync(process.execPath, 'r+')` succeeds on a running binary, and a write through a hardlink of it lands in the shared inode (on Apple Silicon it also kills the mapped process by signature invalidation). So a hardlink to the current node observes its bytes changing only if *someone* writes in place — the managers do not, and this plan's own discipline is rename-only (§5.7 T-1) | manager sources; Architect scratch run |
| 4 | `~/.infra-kit`, `~/Library/pnpm`, `/opt/homebrew` are one volume (`/dev/disk3s5`) → `linkSync` succeeds. Where it does not: Linux root-owned `/usr/bin/node` under `fs.protected_hardlinks=1` → `EPERM`; macOS cross-volume `link(2)` → **`EPERM`, not `EXDEV`** (measured); exFAT/SMB/some NFS → `ENOTSUP`; dataless iCloud files → `EDEADLK`; plus `EACCES`, `EMLINK` | `df`; kernel docs; Architect scratch run |
| 5 | portless 0.15.6 `service install` accepts no node/entry option (`Unknown service install option`, `:3519`) | source |
| 6 | Every `process.execPath` use in portless is **client-side**, under the user's node, never under the plist's: `:3804` (plist), `:3961`/`:3981`/`:4005` (uninstall / elevated re-exec / `proxy stop` during install), `:4464` (`sudoStop` ← `sudoStopOrHint`), `:4481` (`runCleanWithSudo` ← `handleClean`), `:5028` (`ensureProxyRunning` ← `runApp`), `:5746` (`handleTrust`), `:6096`/`:6149` (`handleHosts` ← dispatcher `:7751`), `:6782`/`:6959` (`handleProxy` ← `:7755`). The daemon is `handleProxy --foreground` → `startProxyServer` (`:4553-4789`): **no `execPath`, no spawn, no sudo**; `/etc/hosts` is written in-process (`syncHostsFile`, `:4609`/`:4641`) | source, traced by the Architect |
| 7 | `augmentedPath()` (`:2476`) puts `dirname(process.execPath)` on PATH for three consumers — `spawnCommand` (`:2484`), `spawnProxiedApp` (`:7099`), `spawnTaskApp` (`:7151`) — none reached from `proxy start --foreground`. **The daemon never needs an `npm`/`npx` sibling** | source |
| 8 | Node keeps `argv[1]` verbatim; only `execPath` is realpath'd | predecessor facts 1/2 |
| 9 | `shellQuote` single-quotes anything outside `/^[\w@%+=:,./-]+$/` — `~` and `$` are outside it, so a printed `~/.infra-kit/node` would be `'~/.infra-kit/node'` and no shell expands a quoted tilde | `src/lib/shell-quote/shell-quote.ts:21` |
| 10 | `serviceInstallCommand(bin, seams)` is the ONE renderer: doctor `:443` row (`doctor.ts:1584`), CA-chain row (`:1654`), `service target` verdict (`:1887`), `setup.ts:130`, `dev-server.ts:1854` | source |
| 11 | `pnpm ls -g` lists `node@24.21.0` **and** `node@24.20.0` — old runtimes linger, so "old node still exists" is a real state | shell |
| 12 | `~/.infra-kit` is `0700`; root traverses it already for the link and the script | `ls -ld`; pre-existing |

## 2. Principles

1. **Root runs only paths infra-kit owns.** After this plan both words of the daemon's argv are names under
   `~/.infra-kit/` whose *lifetime* unprivileged infra-kit code controls. A hardlink shares an inode with the
   package manager's extracted node — immutable bytes the user already owns (fact 1, 3); what infra-kit owns
   is the name and the fact that the inode outlives the manager's directory.
2. **sudo is once per machine, never per release, never per Node bump.** The remaining sudo is the one that
   writes the plist; nothing else needs it.
3. **The hot path pays a stat, a ~250-byte read and the already-paid `isGlobal`.** Every CLI/`ik-mcp` boot
   may check; only a real change writes, and the write is 0.3 ms.
4. **Never a half file where root will look.** Publish by `rename(2)` only; a daemon boot mid-refresh sees
   either the old inode or the new one.
5. **Same trust model as the link, stated once.** Root already executes a user-writable script through
   `~/.infra-kit/portless`; a user-writable node beside it widens nothing (§5.7).

## 3. Decision drivers

1. pnpm 12 re-mints the Node path **without** a Node bump (today's breakage) → the fix must not depend on
   the package manager's layout at all, only on the running process.
2. portless cannot be told which node to write (fact 5) → the only lever is what `process.execPath` IS
   when `service install` runs: a regular file we own (facts 1, 8). The daemon itself never consults
   `execPath` again (fact 6), so the plist's first word is the whole problem.
3. `serviceInstallCommand` is already the single renderer (fact 10) → one seam change reaches doctor, setup
   and `dev` at once; G2 costs no new surface.

## 4. Options

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. `~/.infra-kit/node` = `linkSync(execPath, …)` (hardlink); on ANY `linkSync` throw, `copyFile`; publish by tmp + rename** | 0.3 ms, 0 bytes, in-process on every macOS/Linux layout where node lives on the home volume (fact 4); the inode outlives the manager's dir (fact 3) so the name can never dangle; a regular file → `execPath` stays put; staleness is one `stat` inode compare; the copy fallback is the same degrade every option needs across devices | shares an inode with the manager's file, and macOS has no write guard on it (fact 3) — safe only under rename-only discipline (§5.7 T-1); Linux `/usr/bin/node` under `protected_hardlinks` → the 134 MB copy path once per Node bump | **chosen** |
| B. `copyFile(execPath, …, COPYFILE_FICLONE)` only | one call; independent inode | on this Mac it is a full 134 MB copy at 47–100 ms per refresh (fact 2), not a clone; re-mint churn would then be a real cost, forcing version-keyed staleness and a sidecar-only health model; no gain over A's fallback | A's fallback path, not the primary |
| C. upstream portless `--node <path>` + a plain symlink | no copy at all; the "right" fix | not shippable now: 0.15.6 has no such option (fact 5); would need a release, then a pin; doctor would still need A's row for the interim | follow-up (ADR) |
| D. status quo + doc note ("re-run sudo after pnpm churn") | zero code | the daemon breaks without any user action (today), and the fix line stays a ~200-char path that is wrong within days — fails principles 1 and 2 | invalidated |
| E. install as today, then one sudo `plutil -replace ProgramArguments.0`/`sed` of the plist to a symlink `~/.infra-kit/node` re-pointed at boot like the link | no copy, no hardlink, "just edit the plist" | **(i)** a symlink is only as fresh as the last hook run. The scenario this plan exists for — a re-mint deletes the target, then the machine reboots with **no** infra-kit boot in between (AC1) — leaves launchd with a dangling symlink and a dead daemon until a human runs something; the predecessor accepted that window for the *script* because KeepAlive retries and the first CLI run heals it, but the node half is what stops the daemon from *ever* starting. A hardlink cannot dangle: the inode lives as long as the name does. **(ii)** every later `service install` — doctor's CA-chain row prints one (`doctor.ts:1650-1654`), CA regeneration needs one — rewrites the plist with the deep path again, so the sed is a recurring second sudo command to teach. **(iii)** infra-kit would be editing a root-owned file whose grammar it does not own | invalidated |
| F. `cp -c` subprocess on darwin (true APFS clone) | 0 bytes | a subprocess in the boot refresh path (the `ik-mcp` contract is "spawn nothing"), keeps the source mtime (breaks nothing but proves nothing), darwin-only, and buys nothing over `linkSync`'s 0.3 ms/0 bytes | invalidated |

**Why A:** it is the only option where a re-mint costs 0.3 ms and 0 bytes, a Node bump costs the same, and
the plist's first word is a name the manager cannot make dangle. B is A without the fast path. E is the
option the user will ask about, and (i) is the reason it cannot work: a symlink at `argv[0]` is one
unlucky reboot away from a daemon that never starts, and the reboot-without-a-CLI-run is exactly AC1.

**C is deferred, not rejected:** an upstream `--node` would let the plist name a path portless never
realpaths — but that path still has to be one that cannot dangle across a re-mint + reboot, so even
upstream a hardlink (not a symlink) stays the right target. Filed as follow-up 1.

## 5. Design

### 5.1 The file

`~/.infra-kit/node` — a regular file: a **hardlink** to the Node binary the global infra-kit runs, or on
filesystems/uids where a hardlink is refused, a user-owned `0755` **copy** of it. Beside it, the sidecar
`~/.infra-kit/node.source.json`:

```json
{ "method": "hardlink", "version": "v24.21.0", "arch": "arm64", "platform": "darwin",
  "source": "/Users/arthur/Library/pnpm/global/v11/60d8-…/node_modules/node/bin/node",
  "refreshedAt": "2026-09-17T09:24:11.000Z", "versionChangedAt": "2026-09-13T18:02:40.000Z" }
```

`"method": "copy"` adds `"sourceSize": 122129232`. Two clocks, deliberately:
- `refreshedAt` — when the *file* was last published (every relink, including a same-version re-mint).
  Read by the integration test ("did a refresh happen?"), never by doctor.
- `versionChangedAt` — when the *Node* behind the file last changed: bumped only when `version`, `arch`
  or `platform` (plus `sourceSize` on the copy path) differ from the previously parsed sidecar, or when
  there was no parsable sidecar. Carried over unchanged on a same-version relink. This is the only clock
  T7 ("daemon predates Node …") reads: after a `pnpm add -g <x>` re-mint the daemon still maps the old
  inode with identical bytes and needs no restart — keying T7 on `refreshedAt` would nag until the next
  kickstart after every global install, and make PM-6 (two globals, same Node, different inodes) a
  permanent false advisory.
Neither clock is an fs timestamp: a hardlink shares mtime **and** inode with the source (so mtime is the
manager's install time, older than any daemon), and ctime is what `rename` bumps but is not portable to
reason about across the copy path. The sidecar is written *after* the node file lands, so neither clock
is earlier than the file it describes.

The plist's node argument becomes `/Users/arthur/.infra-kit/node`: a regular file is never realpath'd
away (fact 1), so portless writes exactly that string (`:3804`); the daemon never looks at `execPath`
again (fact 6), so that one word is the whole contract.

**Origin of `process.execPath`.** pnpm `node@runtime`, volta, fnm, nvm ship a self-contained binary; a
hardlink or copy of it runs anywhere. **Homebrew's node is dylib-linked into the Cellar** (`icu4c`,
`libuv`, …), and that is a limit of what doctor can see, not a case it detects: on the hardlink path the
file IS this doctor process's own inode, so a dylib break that stops the daemon stops `infra-kit doctor`
too (the user sees a dead CLI before any row), and a rebuilt bottle is a new inode → N6 relinks. On the
copy path — the only path where the file can differ from the running binary — N7's spawn is the
detector (PM-4). The boot fast path detects neither and does not claim to.

### 5.2 `ensurePortlessNode()` — `apps/infra-kit/cli/src/dev/proxy/portless-node.ts` (new)

A sibling of `ensurePortlessLink`, same shape, same gate. **No value import from `portless-driver`**: the
module needs `USER_CONFIG_DIR_NAME`, `node:fs`, `node:path` and the zod sidecar schema only, so
`report-inventory.test.ts:154-190`'s fixed-export `vi.mock('src/dev/proxy/portless-driver')` keeps working
(memory: a partial mock of a barrel drops exports).

```ts
export type PortlessNodeOutcome =
  'created' | 'refreshed' | 'unchanged' | 'skipped-local' | 'skipped-platform' | 'failed'

export interface PortlessNodeResult {
  kind: 'node'; outcome: PortlessNodeOutcome
  node: string; source: string; version: string; method: 'hardlink' | 'copy' | null
}

export interface PortlessNodeFs {           // object seam — vi.spyOn cannot intercept named fs imports
  mkdirSync; lstatSync (throwIfNoEntry: false) → { ino, dev, size, isFile(), isSymbolicLink() } | undefined
  statSync (same shape, follows links); readFileSync; writeFileSync; readdirSync
  linkSync; copyFileSync (mode); chmodSync; renameSync; unlinkSync
}

export interface EnsurePortlessNodeDeps {
  isGlobal: () => boolean                    // the SAME memoised closure the link uses (§5.3)
  home: string
  execPath: string; version: string; arch: string; platform: NodeJS.Platform
  fs?: PortlessNodeFs
}

export const portlessNodePath    = (home) => join(home, USER_CONFIG_DIR_NAME, 'node')
export const portlessNodeSidecar = (home) => `${portlessNodePath(home)}.source.json`
export const ensurePortlessNode  = (deps): PortlessNodeResult   // never throws
```

Decision procedure, in order:

1. `platform` not `darwin`/`linux` → `'skipped-platform'`. portless does install a Windows scheduled task
   (`schtasks`, `cli.js:4094`), but infra-kit's doctor has never parsed it and the daemon story on Windows
   is out of scope; a file named `node` (no `.exe`) would not even run there. Stated assumption, not a code
   path.
2. `!isGlobal()` → `'skipped-local'`. **A checkout never writes `~/.infra-kit/node`** — same gate, same
   closure, as the link.
3. `mkdirSync(~/.infra-kit, { recursive: true })`.
4. **What is there.** `lstatSync(node)`. A **symlink or directory** at the path → `'failed'`, left exactly as
   found — mirror of `portless-link.ts:197`'s `NOT_A_SYMLINK` refusal: this code owns a regular file, and
   removing whatever someone else put there is the one destructive act a boot hook must never take.
5. **Staleness = one stat, never a byte compare.** `statSync(execPath)` (the running binary — always
   present) and the sidecar:
   - **Fast path:** `node` is a regular file **and** `node.ino === exec.ino && node.dev === exec.dev`
     **and** the sidecar parses **and** `sidecar.version/arch/platform === deps.version/arch/platform`
     → `'unchanged'`. Inode equality is the strongest signal for the *file*: it says "the daemon's node
     IS the bytes this process is running", regardless of path churn. The version clause is for the
     *sidecar*: a crash between the node rename and the sidecar rename after a Node bump leaves a
     v24.22 inode described as v24.21 with a pre-bump `versionChangedAt`; without the clause the next boot
     would say `'unchanged'` forever, N8 would print the wrong version for good and T7 would compare the
     daemon against a clock that is too *old* — fewer advisories, never more. A sidecar that does not
     parse or does not match the process forces a refresh (relink at 0.3 ms — one code path, no
     sidecar-only branch) so it is rewritten with `versionChangedAt = now`; that `now` is after any
     pre-bump daemon start, so T7 fires correctly on the healing boot.
   - **Copy path** (`sidecar.method === 'copy'`): `'unchanged'` iff `sidecar.version/arch/platform` equal
     `deps.*` **and** `exec.size === sidecar.sourceSize`. Version alone would miss a same-version
     different-build source; size is the cheapest second witness.
   - Anything else — file absent, inode differs (re-mint, Node bump, manager reinstall), copy with a
     different source, sidecar corrupt — refreshes.
   - Why inode, not version: after a re-mint the source is a new inode with the same bytes; relinking is
     0.3 ms and makes the daemon's *next* boot independent of the deleted dir. Version was the right key
     when a refresh cost a 134 MB copy; it is not now.
6. Refresh, atomically:
   - sweep `readdirSync(~/.infra-kit)` for `node.tmp-*` **and** `node.source.json.tmp-*` and unlink them —
     a SIGKILL mid-copy leaves a 134 MB orphan under a pid that may never recur (the sidecar orphan is
     ~250 B and harmless, but one glob covers both). Best-effort: a throwing `readdir` is ignored. The
     sweep runs only on the refresh path.
   - `linkSync(execPath, node.tmp-<pid>)`. **On ANY throw** → `copyFileSync(execPath, tmp, COPYFILE_FICLONE)`
     then `chmodSync(tmp, 0o755)`. The failure set of `link(2)` is not enumerable in practice — `EPERM`
     (Linux `protected_hardlinks`, **and** macOS cross-volume), `EXDEV`, `ENOTSUP` (exFAT/SMB/NFS),
     `EDEADLK` (dataless iCloud), `EACCES`, `EMLINK` (fact 4) — and every one of them means "this
     filesystem will not give you a hardlink here", to which the answer is always the copy. The copy
     throwing too → `'failed'`. **`chmod` runs ONLY on the copy path**: on a hardlink it would mutate the
     shared inode — the manager's file. (The source is executable by this user — this very process
     executed it — so the hardlink needs no mode change.)
   - `renameSync(tmp, node)` — replaces atomically; a daemon holding the old inode keeps running
     (executables are mapped by inode; PM-1 in the progress doc proved the daemon reads nothing from disk
     after boot). Never `unlink` first; **never open `node` for writing** — macOS would let us (fact 3), and
     through the hardlink the write would land in the manager's node and kill the mapped daemon (§5.7 T-1).
   - Only now write the sidecar (tmp + rename too) with `method`, `refreshedAt = now`, `sourceSize` on
     the copy path, and `versionChangedAt` = the previous sidecar's value when `version/arch/platform`
     (and `sourceSize` on the copy path) are unchanged, else `now` (also `now` when there was no parsable
     sidecar). Ordering invariant: **a sidecar that parses describes the file that is there or an older
     one, and a stale sidecar costs exactly one extra refresh at the next boot** — on both paths, the
     version clause in step 5 turns "older" into a refresh, which rewrites the sidecar against the file
     that is actually there. The refresh's `versionChangedAt = now` errs towards one restart advisory too
     many (a daemon started after the bump but before the healing boot is told to restart once), never
     too few.
   - On any throw: unlink the tmp, return `'failed'`. The old node file is untouched.
7. Return `'created'` (no prior file) or `'refreshed'`.

Cost per CLI start on a converged machine: `lstatSync(node)` + `statSync(execPath)` + a ~250-byte
`readFileSync` + `JSON.parse`, on top of the `isGlobal` the link already paid. No subprocess, no stdout,
no throw — the `ik-mcp` transport contract of `bootPortlessLink` holds unchanged.

### 5.3 Call sites — extend `bootPortlessLink`, do not add a third boot hook

`bootPortlessLink(log, deps?)` in `portless-link.ts` gains the node step: it calls `ensurePortlessLink`
then `ensurePortlessNode` and logs each result once. `PortlessLinkResult` gains `kind: 'link'` and
`PortlessLinkLog` becomes `(result: PortlessLinkResult | PortlessNodeResult, message) => void`, a
discriminated union on `kind`. Consequences at the two entries:

- `entry/cli.ts:105` — `logger.debug(result, message)`: unchanged; pino serialises either shape.
- `entry/mcp-proxy.ts:41` — reads `result.link`/`result.target`, which the node result does not have.
  **One edit**: `if (result.outcome === 'failed') log(result.kind === 'link' ? `${message} failed: ${result.link} -> ${result.target}` : `${message} failed: ${result.node} <- ${result.source}`)`.
  Still stderr-only, still nothing spawned before the handshake.

`realPortlessLinkDeps()` becomes `realPortlessStableDeps()` returning `{ link, node }` with **one memoised
`isGlobal` closure** shared by both (`portless-link.ts:219` pays a `realpathSync` plus the `.git` walk —
once per boot, not twice), and adds no new export to `portless-driver`. `setup.ts:71`
(`realPortlessServiceDeps`) consumes the same object, so `PortlessServiceDeps` gains
`node: EnsurePortlessNodeDeps`. The node step runs even when the link is `'skipped-unresolved'`: the two
are independent state.

The updater's `version --json` from `$HOME` is still the first process the new binary runs; it now
converges both. The integration test proves it (§7).

### 5.4 The printed command — G2 — resolved once, health included

`ServiceInstallSeams` (`portless-link.ts:64`) gains `stableNode?: string | null`, with three meanings:

| `stableNode` | Meaning | Who passes it |
|---|---|---|
| `string` | resolved and **healthy** — render through it | doctor and setup, after `checkPortlessNode` (§5.5) |
| `null` | resolved and **unhealthy** (or absent) — render through `execPath`, the node that provably runs | doctor and setup |
| `undefined` | not resolved — `serviceInstallCommand` resolves it cheaply itself: `stableNodeCandidate(home, execPath, fs)` | `dev` (`dev-server.ts:1854`, seam `options.portlessLink`) |

`stableNodeCandidate` is **hardlink-only**: a regular file whose `ino/dev` equal `execPath`'s — no
sidecar, no spawn. Inode equality is proof of runnability, because the printing process IS that inode.
A copy-path file is not a candidate: without the spawn nothing proves it runs, so `dev` prints the deep
line there (still runnable). **`dev` accepts that level**: it is a hot startup path that already avoids
spawning, and the hardlink is the case on every layout this project runs. `dev`'s error text already
tells the user to run `doctor` when the daemon is down.

**Healthy** (doctor/setup) ≡ **"N8 reached"** (§5.5): the file is a regular file with a parsable sidecar
**and** either (a) inode+dev equal `execPath`'s and the sidecar's `version/arch/platform` match the
process — the hardlink path — or (b) it is a copy whose sidecar
matches `version/arch/platform` and `sourceSize === stat(execPath).size` (N6's consistency test) **and**
`nodeVersionOf(node) === process.version`. Not "candidate and spawn": that would make a consistent copy
never healthy, so a Linux distro-node or cross-volume machine would print the deep line forever, T5 would
never fire and `setup` would never print the short line. `nodeVersionOf` is
`spawnSync(node, ['-p', 'process.version'], { timeout: 2000 })` → `{ version, status, signal }`, healthy
iff `status === 0 && signal === null && version === process.version`. ~50 ms; no Gatekeeper dialog — the
file carries no `com.apple.quarantine`, only `com.apple.provenance` (fact 1). On the hardlink path the
spawn proves nothing the inode does not (it is this process's own binary); the implementer may skip it
there or keep it for uniformity — either way N7 is the copy-path/PM-4 row and the doc claims no more.
One spawn at most per doctor/setup run, threaded into every row through the seams
(`resolveServiceTargetSeams`, `doctor.ts:2057`, is already computed once for the whole section).

**From a checkout** (`isGlobal()` false): the node *row* is a skip (§5.5), but `stableNode` is still
resolved the same way against the checkout's own `process.execPath` — the global's node may well be the
same inode (same pnpm Node) and then the short line is correct; if it is not, the candidate check fails
and the deep `execPath` line is printed, exactly as today. The printed line is runnable in every branch
(memory: printed commands must be runnable).

`serviceInstallCommand(bin, seams)` therefore renders
`execPath: (seams.stableNode === undefined ? stableNodeCandidate(seams.home, execPath) : seams.stableNode) ?? execPath`
with `const execPath = seams.execPath ?? process.execPath` resolved first — `dev`'s seam at
`dev-server.ts:1854` is `{ home }` only, so the candidate must not be handed `undefined` to stat. Written
out so that `null` (resolved unhealthy) goes straight to `execPath` and never falls through to the
candidate (`??` alone would). `formatPortlessCommand` is unchanged. Rendered line on this machine
after convergence:

```
sudo /Users/arthur/.infra-kit/node /Users/arthur/.infra-kit/portless/dist/cli.js service install
```

**`~` vs `$HOME` vs absolute — absolute, decided by fact 9.** `shellQuote` would print
`'~/.infra-kit/node'`, and a quoted tilde is a literal to every shell. Loosening `SHELL_SAFE` for a leading
`~` would make the printed line depend on the caller's shell expanding it *before* `sudo` (interactive zsh:
yes; the agent Bash tool's non-interactive zsh: yes; a copy into a `sudo -i` prompt or a launchd-style
context: no). `$HOME` has the same problem plus `env_reset`. Absolute is right under every one of those and
is ~110 characters shorter than today. Prose in doctor rows keeps using `tildify()` for display; commands
never do.

### 5.5 doctor — G3

Two rows, one new. `SECTION_MEMBERS` (`report.ts:91-96`) inserts `portless node` between
`portless installed` and `portless service target`; `report.test.ts:90-92` count 36 → 37 and its comment
("36, up from 34 …") gains "37: `portless node`"; `report-inventory.test.ts` stubs `nodeVersionOf` (§7).

**New row — `portless node`** (`checkPortlessNode(seams) → { row, stableNode }`, `doctor.ts`). Threading:
`checkPortless` builds the one `seams` object at `:2057` and every remediation renders through it — the
`:443` row (`:1584`), the CA-chain row (`:1654`), the `service target` verdict (`:1887`), the parse-failure
advisory (`:1996`). `checkPortlessNode` therefore runs **between `:2057` and `checkPortlessServing` at
`:2059`** and assigns `seams.stableNode` before any of them. `setup`'s `portlessServiceTargetState`
(`:2010`) builds its own seams through `resolveServiceTargetSeams` → the same call is made inside it, so
the injection is one place (`resolveServiceTargetSeams` gains the node resolution, or both callers call
it first — implementation's choice, one seam either way). Seams added to `ServiceTargetDeps`:
`nodeVersionOf?`, `isGlobal?`, `nodeFs?: PortlessNodeFs` (for the lstat/stat/sidecar reads; defaults to
`node:fs`).

| # | State | Status | Message |
|---|---|---|---|
| N1 | platform not darwin/linux | `pass` | `Skipped — no portless OS service on this platform` |
| N2 | `isGlobal()` false | `pass` | `Skipped — not a global install; the global infra-kit keeps ~/.infra-kit/node current` — the **row** is a skip, but `stableNode` is resolved by the same N3–N8 code path (candidate + `nodeVersionOf` spawn) against this process's `execPath`, so the runnability claim is uniform from a checkout too; the inventory test stubs `nodeVersionOf` for exactly this reason |
| N3 | nothing at the path | `fail` | `` ~/.infra-kit/node is missing and could not be written — run `infra-kit setup` and see the debug log `` (the boot hook ran in this very process; absence means it failed) |
| N4 | a symlink or directory at the path | `fail` | `` ~/.infra-kit/node is not a regular file; infra-kit will not replace it — move it away and run `infra-kit setup` `` |
| N5 | regular file, sidecar missing or unparsable | `fail` | `` ~/.infra-kit/node has no readable node.source.json and it could not be rewritten — run `infra-kit setup` `` (never renders "is Node undefined": every message below reads the parsed sidecar) |
| N6 | stale: `sidecar.version/arch/platform ≠ process` on either path; or hardlink path with `ino/dev ≠ execPath`'s; or copy path with `sourceSize ≠ stat(execPath).size` | `fail` | `` ~/.infra-kit/node is Node <sidecar.version> (<method> of <tildify(sidecar.source)>); infra-kit runs <process.version> at <tildify(execPath)>, a different file, and could not relink it — run `infra-kit setup` `` — the "of <source> … a different file" clause is what keeps a same-version, different-inode failure (re-mint + relink failed) from reading as a typo when both versions print `v24.21.0` |
| N7 | copy path (or the implementer's uniform choice): `nodeVersionOf(node)` null or ≠ `process.version` | `fail` | `` ~/.infra-kit/node does not run as Node <process.version> (<"killed by SIGKILL" when signal !== null — an AMFI/Gatekeeper kill has status null; else "exit <status>" or "printed <x>">). Re-run through the current Node: `sudo <execPath> <link cli> service install`, then `infra-kit setup` `` — `stableNode = null`; `nodeVersionOf` returns `{ version, status, signal }` so the row can say which |
| N8 | all good — inode-equal, or a consistent copy that runs | `pass` | `~/.infra-kit/node is Node <version> (<arch>, <method> of <tildify(source)>)` — `stableNode = node`; this row IS the definition of "healthy" in §5.4 |

N3–N7 all set `stableNode = null`; the deep-`execPath` command is what every other row then prints. N7 is
reached only from a file that passed N6 — on the hardlink path that file is this process's own inode, so
the spawn there is optional (§5.4) and N7 is in practice the copy-path row.

**Changed row — `portless service target`** (`serviceTargetVerdict`, `doctor.ts:1878-1953`). `install` is
computed from the health-resolved seams (fix 2). Order stays "failures before advisories, link health
before Node". Deltas:

| # | State | Status | Message (delta from today) |
|---|---|---|---|
| T1 | `argv[0]` missing on disk | `fail` | `` The service runs `<node>`, which no longer exists (Node was upgraded, or its package dir was re-created). Re-run: `<install>` `` — wording gains the re-created case (today's actual cause) |
| T2–T4 | `argv[1]` ≠ link · link dangling · target inside repo | as today | unchanged |
| T5 (new) | `argv[0]` exists, `stableNode` is a string, and `realpath(argv[0]) ≠ realpath(stableNode)` | `warn` (`Warning —` pass via `warnRow`) | `` The service runs `<node>`, a path its package manager will remove. Re-run once to switch it to the stable node: `<install>` `` — replaces today's "≠ process.execPath" advisory whenever the stable node is healthy; `'drifted'` |
| T6 | `argv[0]` exists, `stableNode` is `null`, `realpath(argv[0]) ≠ realpath(execPath)` | `warn` | today's message, unchanged — the fallback when the node row failed; `'drifted'` |
| T7 (changed) | `argv[0]` is the stable node **and** the daemon's start time is earlier than `sidecar.versionChangedAt`, and/or earlier than the link target's `package.json` mtime | `warn` | `` The running daemon predates <"Node <sidecar.version>" / "portless <version>" / "Node <v> and portless <v>"> that `dev` will talk to. Restart it: `sudo launchctl kickstart -k system/sh.portless.proxy` (or reboot). `` — `daemonPredatesTarget` becomes `daemonPredates({ nodeVersionChangedAt, portlessInstalledAt })`; **never** `refreshedAt` (a same-version relink after a re-mint leaves the daemon on identical bytes — no restart needed, and PM-6 would nag forever) and **never** the node file's mtime (a hardlink's mtime is the source's install time); `'converged'` |
| T8 | all good | `pass` | `` service runs `<node>` (Node <version>) + stable link → portless <version> `` — `<node>` interpolated from the plist as today, never the literal `~/.infra-kit/node` (the row reports what the file says) |

`warn` vs `fail` is kept exactly as the predecessor decided: an old Node that still exists keeps the
daemon alive (fact 11), so it is an advisory; a missing one is a boot failure.

`ServiceTargetState` for `setup`: T5 is `'drifted'` — that is what makes `setup` print the sudo line (G4).
T7 stays `'converged'` (restart, not reinstall).

### 5.6 setup — G4

`convergePortlessService` (`setup.ts:118`) gains one line between the link step and the target verdict:
`ensurePortlessNode(deps.node)`, reported in the same `<outcome> portless node — <detail>` shape via a
`portlessNodeDetail(result)` switch (`created` → `linked Node <version> to ~/.infra-kit/node` /
`copied …` by `method`, `refreshed` → `re-linked …`, `unchanged` → `~/.infra-kit/node is already Node <version>`,
`skipped-local`, `skipped-platform`, `failed` → `could not write ~/.infra-kit/node — see the debug log`).
Then `portlessServiceTargetState` as today — which now runs `checkPortlessNode` first, so **setup pays
the one health spawn** and prints the sudo line through `stableNode` when healthy, through `execPath`
otherwise. Idempotent: a converged machine prints two `unchanged` step lines and no sudo line.
`setup` builds a second `realPortlessStableDeps()` after the boot hook's, so `isGlobal` is evaluated twice
per `setup` run (one `realpath` + one `.git` walk) — negligible for a converge command; the memoisation
in §5.3 is per-deps-object, which is what the boot path needs.

### 5.7 Permissions, trust, and the one tension a hardlink adds

The hardlink is the manager's `0755` inode; the copy is `0755`, user-owned; both live under a `0700`
`~/.infra-kit` root already traverses for the link (fact 12). This is the model portless chose and the
predecessor accepted for the script half: the plist already names a user-writable `cli.js`; whoever can
replace that file can run anything as root, and a node beside it adds no capability they lack. Said once.

**T-1 — a shared inode with no OS write guard.** macOS lets a running binary be opened for writing (fact
3). So any in-place write to `~/.infra-kit/node` — a bug in this module, a user `cp node-x ~/.infra-kit/node`,
a test that "replaces the file" — lands in the package manager's node as well, and on Apple Silicon kills
the mapped daemon by signature invalidation (and the user's next `node` too). Nothing in this plan can
dissolve that short of always copying, which iteration 2 rejected for cost. What bounds it:
1. **Rename-only discipline**, mechanically enforced: `portless-node.ts` never opens the node path for
   writing — every write goes to a `node.tmp-<pid>` name and is published by `rename`; §9.4 greps the
   module for `writeFileSync|createWriteStream|openSync(.*['"][wa]` on anything but `.tmp-` names and
   the sidecar, and the fake-fs call log asserts the same in every unit case.
2. **Tests never target the real inode.** The integration test's foreign-inode step (§7 step 4) creates
   its copy under a NEW name and `rename`s it over the hardlink; the hardlink is *replaced*, never
   *written through*. A `copyFileSync(execPath, <hardlink>)` would `O_TRUNC` the running vitest node
   (iteration-2 blocker, measured).
3. **Doctor is not the detector for a write-through, and the doc does not pretend it is.** An in-place
   write through the hardlink keeps the inode, so N6 (inode compare) never fires for it; and because that
   inode is `infra-kit doctor`'s own binary, N7's spawn mostly cannot run either — the CLI itself is what
   breaks. Honest statement: a write-through damages the user's own `node` first, and they notice by
   `node` (and every infra-kit command) failing, not by a doctor row. What doctor *does* catch is the
   manager replacing its file (new inode → N6) and, on the copy path, a file that stopped running (N7).
   Recovery in every case is a working Node + `infra-kit setup`, which relinks from the current
   `execPath`.

### 5.8 What is NOT changed

- portless, its state dir, the plist/unit format, the `npm -g portless` tool recipe.
- The driver (`portless-driver.ts:302`) keeps running the bundled `cli.js` with the CLI's own
  `process.execPath`; `augmentedPath` on that side is unaffected, and the daemon never reaches it (fact 7).
- No restart automation (needs sudo). doctor reports; the user kickstarts.
- No write guard on the shared inode (T-1) — no `chflags uchg`, no `0555`: both would mutate the
  manager's inode too, and the manager must stay able to unlink-and-replace its own file.
- `rm -rf ~/Library/pnpm/global/5` and the lingering `node@24.20.0` — doc note in the progress log only.

### 5.9 Implementation notes (verifier pass, 2026-09-17)

- **`COPYFILE_EXCL` on the copy branch is load-bearing.** The Architect's implementation review found a
  T-1 write-through the plan missed: a boot that hardlinks `execPath → node.tmp-<pid>` and dies before its
  `rename` leaves a tmp that IS the live inode; the sweep is best-effort (`readdir` may throw), so a reused
  pid can hand `linkSync` an `EEXIST` and the catch-all copy would `O_TRUNC` that name. The copy now runs
  with `COPYFILE_FICLONE | COPYFILE_EXCL` → `EEXIST` → `'failed'` → the next boot's sweep clears it. The
  fake fs reproduces the O_TRUNC-vs-EXCL semantics and `expectRenameOnly` rejects any copy without EXCL, so
  every unit case pins the guard. No pre-discard in `publishNode`: the sweep is cleanup, EXCL is the guard.
- **The sidecar is hand-validated, not zod.** `portless-node.ts` is reached from `entry/mcp-proxy.ts`, and
  the `ik-mcp` bundle must be built from `src/` + Node builtins only (`dist-shebang.test.ts`); the first
  full `qa` caught a `zod` chunk. Eight scalars need no schema library.
- **One health owner.** `portlessServiceTargetState` returns `{ state, stableNode }`; `setup` consumes
  doctor's N8 verdict instead of re-deriving it, so one spawn per run is structural, not memoised.
- `describesProcess` reads `version`/`arch`/`platform` from the seams (defaults `process.*`), so doctor
  fixtures pin all three symmetrically.

## 6. Pre-mortem

**PM-1 — the file is silently stale after a Node bump.** infra-kit now runs 24.22 but `~/.infra-kit/node`
is still the 24.21 inode and the refresh failed (ENOSPC on the copy path, EACCES on `~/.infra-kit`, a
read-only home). *Blast radius:* none immediately — the daemon keeps running the old Node, and `service
install` through the stale file would still work. *Detection:* N6 `fail` — the inode compare (or
version+size on the copy path) is exact, not heuristic. *Mitigation:* the hook never blocks boot; `setup`
retries the same code path and reports `failed`; the sidecar ordering invariant (§5.2 step 6) means no
half-written state is sticky.

**PM-2 — the refresh races the daemon's KeepAlive restart.** launchd re-execs the plist between our
`linkSync`/`copyFile` and `rename`. *Why it cannot half-run:* the path `~/.infra-kit/node` is never absent
and never partially written — it names the old inode until the `rename` lands, then the new one. A daemon
already running holds its mapped inode; `rename` over it is legal on both platforms and touches no byte
of that inode. The only way to hurt the running daemon is to write *through* the name (T-1), which this
module never does. *Concurrent boots* (two CLIs starting at once, both refreshing): A's sweep may unlink
B's `node.tmp-<pidB>` before B renames it → B's `rename` throws → B returns `'failed'` and A's rename
lands, or both land in turn; either way the name always holds a complete file and the next boot
converges — a `'failed'` here is a debug line, never a broken daemon. *Test:* the fake-fs call log
asserts `link(tmp) → rename(tmp, node)`
(or `copyFile(tmp) → chmod(tmp) → rename`) with no `unlink(node)`, no `chmod(node)` and no write to `node`
itself — the same contract the link test enforces (memory: assert on the call log, not the final state).

**PM-3 — the copy path: non-CoW filesystem, `protected_hardlinks`, disk pressure.** On Linux with a
root-owned `/usr/bin/node`, `linkSync` is `EPERM` and the fallback is a 134 MB copy; on a home with 100 MB
free it fails mid-way. *Mitigation:* the copy targets `node.tmp-<pid>` and a failure unlinks it; the
orphan sweep (§5.2 step 6) clears tmps from crashed pids on the next refresh; the copy path refreshes only
when version/arch/platform/size change, never on path churn, so the steady state is one file. *Residual:*
a user-owned node on Linux (volta/fnm/nvm under `$HOME`) hardlinks fine — the copy path is the
`/usr/bin/node`-from-a-distro-package case only.

**PM-4 — codesign / Gatekeeper refuses the file after a macOS update.** A hardlink IS the signed file;
a copy carries the signature byte-for-byte (fact 1: `codesign -v` passes; no `com.apple.quarantine`).
If a future macOS still refuses it, launchd's start fails and `:443` goes red with no obvious cause.
*Detection:* N7 spawns the file once — "does not run as Node …" names the cause instead of leaving a red
`:443` row. *Mitigation:* N7 prints the deep `process.execPath` command (a node that provably runs), so the
machine is never without a working fix line; `setup` re-links from the current source. This detection
is copy-path only: on the hardlink path the refused file is doctor's own binary, so a refusal stops the
CLI itself before any row (§5.1, T-1 point 3) — the user's signal there is `infra-kit` not starting, and
the fix is a working Node + `infra-kit setup`. Recorded in the progress doc as the scenario to try after
the next macOS update.

**PM-5 — `$HOME` on NFS / a different volume from Node.** `linkSync` is `EXDEV` across devices → the copy
path (§5.2 step 6); correct, just slower once. Root reading a user home over NFS with `root_squash` cannot
start the daemon — but that failure already exists for `~/.infra-kit/portless/dist/cli.js` today and is not
introduced here.

**PM-6 — two globals, one home.** A user with both a Homebrew infra-kit and a pnpm-global one: each boot
converges the node to *its* `execPath`; the file flip-flops only if their inodes differ, and each flip is
0.3 ms, and `versionChangedAt` is carried over as long as both run the same Node version, so T7 stays
silent. Only when the two globals' Node *versions* differ does each flip bump the clock and `doctor` show
T7 until a kickstart — and, since every later flip bumps it again, T7 recurs after each flip for as long
as both globals are used; perpetual by construction, and correct: the daemon really is on the other Node
half the time. Accepted; matches how the
link already behaves for two globals with different portless versions.

## 7. Test plan

**Unit — `src/dev/proxy/__tests__/portless-node.test.ts`** (new), `fakeNodeFs` in
`portless-link-fixtures.ts` next to `fakeLinkFs` — an in-memory tree with `{ kind: 'file', ino, dev, size,
content? } | { kind: 'symlink' } | { kind: 'dir' }` entries and a call log:
- no file, no sidecar → `'created'`, `method: 'hardlink'`; calls are exactly `mkdir, readdir, link(exec → tmp), rename(tmp → node), writeFile(sidecar.tmp), rename(sidecar.tmp → sidecar)`; no `chmod`, no `unlink(node)`
- file with `ino/dev` equal to `execPath`'s + parsing sidecar → `'unchanged'`; **zero** mutating calls
- file with a different inode, **same** `version/arch/platform` (re-mint) → `'refreshed'`; rename-only publish; sidecar `refreshedAt` advances, `versionChangedAt` is carried over unchanged (so T7 stays silent — asserted again in the doctor test)
- file with a different inode and a different `version` (Node bump) → `'refreshed'`; both clocks advance
- no parsable previous sidecar → `versionChangedAt = now`
- file with equal inode but sidecar missing / corrupt JSON → `'refreshed'` (sidecar rewritten; still a hardlink)
- file with equal inode but `sidecar.version` ≠ `deps.version` (the crash-after-bump state) → `'refreshed'`, still a hardlink, `versionChangedAt = now`
- `linkSync` throws `EXDEV` → `'refreshed'` with `method: 'copy'`; calls include `copyFile(exec → tmp, FICLONE), chmod(tmp, 0o755), rename`; sidecar has `sourceSize`
- `linkSync` throws `EPERM` (Linux `protected_hardlinks`, macOS cross-volume), `ENOTSUP`, `EDEADLK`, `EACCES`, and an error with no `code` at all → **every one** takes the copy path (parameterised case)
- `linkSync` throws `EACCES` **and** `copyFileSync` throws `EACCES` → `'failed'`, tmp unlinked, nothing else touched
- the call log never contains `writeFile(node)`, `open(node, 'w')` or `chmod(node)` in ANY case — asserted by a shared `expectRenameOnly(calls)` helper every case runs (T-1)
- copy path, sidecar matching version/arch/platform/size → `'unchanged'`; same but `sourceSize` differs → `'refreshed'`
- `copyFileSync` throws `ENOSPC` → `'failed'`, tmp unlinked, node file and sidecar untouched
- sidecar `renameSync` throws → `'failed'` but the node file IS the new inode (invariant: stale sidecar ⇒ at worst one extra advisory / one extra refresh, never a wrong claim)
- orphan sweep: `node.tmp-999`, `node.tmp-1`, `node.source.json.tmp-7` present → all unlinked before the link; `readdirSync` throwing → sweep skipped, link proceeds
- a **symlink** at `~/.infra-kit/node` → `'failed'`, zero mutating calls; a **directory** → same
- `isGlobal()` false → `'skipped-local'`, zero calls; `platform: 'win32'` → `'skipped-platform'`, zero calls
- `portlessNodePath('/Users/x')` → `/Users/x/.infra-kit/node`; sidecar → `…/node.source.json`
- `stableNodeCandidate`: true on inode+dev match only; false on absent / symlink / inode mismatch / a copy-path file even with a perfect sidecar; never spawns (no seam for it) and never reads the sidecar

**Unit — `portless-link.test.ts`** (extend): `bootPortlessLink` logs two results with `kind: 'link'` then
`kind: 'node'`; the node step runs when the link is `'skipped-unresolved'`; a throwing node dep never
escapes; `realPortlessStableDeps` calls `isGlobalInstall` once for both closures (spy on an injected
`isGlobalInstall`); `serviceInstallCommand` snapshots — `stableNode: '/Users/x/.infra-kit/node'` →
`sudo /Users/x/.infra-kit/node /Users/x/.infra-kit/portless/dist/cli.js service install`; `stableNode: null`
→ `sudo <execPath> …` even when the candidate would be true; `stableNode` undefined + candidate true →
short line; undefined + candidate false → `execPath`.

**Unit — `dev-server.test.ts`** (extend, AC3): `:1508` and `:1542` keep pinning
`` sudo ${process.execPath} '${FAKE_PORTLESS_BIN}' service install `` for a home without a link (the
candidate is false there — assert that explicitly by passing a `portlessLink` seam with an empty temp
home); `:1550` ("renders BOTH daemon-down lines through ~/.infra-kit/portless when the link resolves")
stays; **add** one case "home with the link AND a candidate stable node (inode-equal hardlink of
`process.execPath` staged in the temp home) → both lines are the short line, no spawn happened (spy on
`nodeVersionOf` absent from the seams)".

**Unit — `doctor-portless-node.test.ts`** (new): one fixture per N1–N8, via a `fakeNodeFs` tree and a
stubbed `nodeVersionOf`; N5 asserts the message contains no `undefined`; N7 asserts the remediation carries
`execPath` and that `stableNode === null`; N8 asserts `stableNode === node` **for both a hardlink fixture and a consistent-copy fixture whose `nodeVersionOf` matches** (the copy-path machine must reach the short line); a consistent copy whose spawn fails → N7. Plus: `checkPortlessNode` is
called before the `:443` row so that row's remediation renders through `stableNode` (spy order).

**Unit — `doctor-service-target.test.ts`** (extend): T1 wording; T5 with `stableNode` set (deep pnpm
node in the plist, link script) → warn "a path its package manager will remove", command through the
stable node; T6 with `stableNode: null` → today's message and command through `execPath`; T7 with the
plist naming the stable node and `proxy.pid` started before `sidecar.versionChangedAt` → "predates Node v…"; the same daemon started **after** `versionChangedAt` but **before** `refreshedAt` (a same-version relink) → NO advisory, T8 pass;
both clocks newer → one row naming both; neither newer → T8 pass; linux unit
`ExecStart=/home/u/.infra-kit/node /home/u/.infra-kit/portless/dist/cli.js proxy start …` → pass.

**Unit — `report.test.ts`**: 36 → 37 with the comment updated. **`report-inventory.test.ts:154-190`**: no
change to the `portless-driver` mock's export list (nothing new is imported from it); add
`nodeVersionOf: () => ({ version: process.version, status: 0, signal: null })`, `isGlobal: () => false` and `nodeFs` pinned to an **empty** `fakeNodeFs()` to the doctor deps it passes — the inventory must never `lstat` the author's real `~/.infra-kit/node` — so the
inventory (which runs from this checkout) reconciles N2 deterministically.

**Unit — `setup-portless-service.test.ts`** (extend): fresh machine → exactly one sudo line, starting
with `sudo <home>/.infra-kit/node `; installed plist with the deep node (T5) → line printed; converged →
two `unchanged` step lines, no sudo line; `ensurePortlessNode` `'failed'` → step line says so and the sudo
line falls back to `execPath`; `nodeVersionOf` → `null` → same fallback; `runRecipe` never sees
`service install` (unchanged guard).

**Integration — `portless-link-integration.test.ts`** (extend the existing staged pnpm-12 layout, same
`runVersionJson` helper, `cwd = <temp HOME>`, `env = packageManagerInstallEnv`):
1. first run → `<tempHome>/.infra-kit/node` is a regular file with `ino/dev === statSync(process.execPath)`
   (a hardlink — the temp dir and the build are on one volume here; on a CI where they are not, the
   assertion degrades to `size` equal and `sidecar.method === 'copy'`); sidecar `version === process.version`;
   stdout is the bare JSON payload
2. `spawnSync('<tempHome>/.infra-kit/node', ['-p', 'process.execPath'])` prints **that** path (fact 1 in
   CI, not only on this machine) and `-v` prints `process.version`
3. second run → sidecar `refreshedAt` unchanged and inode unchanged (no rewrite on a converged machine).
   Not mtime: a hardlink's mtime is the source's
4. stage a foreign inode **under a new name and rename it over the hardlink**:
   `copyFileSync(process.execPath, '<tempHome>/.infra-kit/node.foreign')` then
   `renameSync('…/node.foreign', '…/node')`; leave the sidecar → run → inode equals `execPath`'s again and
   `refreshedAt` advanced while `versionChangedAt` is unchanged — same Node version, so the end-to-end
   path pins the carry-over the unit case pins (the re-mint scenario, simulated). **Never
   `copyFileSync(execPath, '…/node')`**:
   after step 1 that path IS the running vitest node's inode, and `copyFileSync` opens its destination
   `O_TRUNC` — macOS would let it truncate the developer's real node while reading it (T-1; measured in
   iteration 2's review). The test file carries this as a comment above step 4.
5. run from the checkout-shaped cwd → no `.infra-kit/node` in that HOME

**e2e (manual, recorded in `docs/portless-service-stable-node-progress.md`)** — user-run, needs sudo.
**Ordering matters**: from this checkout every surface is `skipped-local` (progress doc, "Gate + on-machine
doctor comparison"), so nothing below is run from the repo:
0. record `infra-kit doctor` BEFORE (today: `service target` fail "runs …/60d8-…/node, which no longer
   exists") and `infra-kit --version` of the global
1. publish; let the global auto-update (or `pnpm add -g infra-kit@<next>`); `infra-kit --version` ≥ the
   release carrying this change
2. `infra-kit setup` from the GLOBAL infra-kit → step lines `created portless node — linked Node v24.21.0 to ~/.infra-kit/node` and the short sudo line
3. run it; `grep -A4 ProgramArguments /Library/LaunchDaemons/sh.portless.proxy.plist` shows `/Users/arthur/.infra-kit/node`
4. `infra-kit doctor` → `portless node` pass, `portless service target` pass
5. the actual scenario: `pnpm add -g infra-kit@<next+1>` (re-mints `global/v11/{pid}-{ts}`), then
   `sudo reboot` **without** running infra-kit, then `curl -sk https://anything.localhost/` → portless
   answers; `infra-kit doctor` green with **no** sudo re-run
6. the Node-bump scenario: the next toolchain bump, any infra-kit command, `doctor` → T7 "predates Node
   v…"; `sudo launchctl kickstart -k system/sh.portless.proxy`; `doctor` green. Still no `service install`
7. after the next macOS update: `~/.infra-kit/node -v` still runs (PM-4)

**Observability** — the `portless node` doctor row is the user signal; `setup` prints the step line; the
boot hook logs `'portless node'` at `debug` with `outcome/node/source/version/method` (same channel as the
link, `--debug` → `LOG_FILE_PATH`, never stdout); `ik-mcp` logs only `'failed'` to stderr; a unit test
asserts the `'failed'` line is emitted with the node shape.

## 8. Acceptance criteria

1. On a machine whose plist names `~/.infra-kit/node` + `~/.infra-kit/portless/dist/cli.js`: after a
   `pnpm add -g infra-kit@<next>` that re-creates `global/v11/{pid}-{ts}` **and** after a reboot with no
   infra-kit command in between, the daemon serves `:443` with no sudo (e2e step 5, recorded).
2. After a Node bump, `service install` is **not** re-run: the daemon comes back on the new Node after a
   kickstart or reboot, and `doctor` says which of the two it needs (e2e step 6, recorded).
3. Every printed `service install` line — doctor `:443` row, CA-chain row, `service target` row, `setup`,
   `dev`'s two daemon-down errors — reads `sudo <home>/.infra-kit/node <home>/.infra-kit/portless/dist/cli.js service install`
   when the stable node is healthy (doctor/setup) or a candidate (`dev`), and the `execPath` form
   otherwise; both forms execute (`dev-server.test.ts:1508/1542/1550` + the new case; setup and link
   snapshots; one manual paste).
4. `infra-kit doctor` shows `portless node` (N1–N8) and the updated `portless service target` (T1–T8) rows
   with the exact messages of §5.5; every row has a fixture test; `report.test.ts` counts 37.
5. A CLI start on a converged machine performs no write and no subprocess for the node step (unit: zero
   mutating calls; integration step 3: inode and `refreshedAt` unchanged).
6. A project-local or checkout invocation never creates or touches `~/.infra-kit/node` (unit + integration
   step 5).
7. `pnpm run qa` green, full (no `--cache`), gated on the raw exit code; no `catalog:` leak in manifests;
   no untracked files after the commit.

## 9. Verification steps (verifier pass)

1. `cd apps/infra-kit/cli && pnpm run qa; echo EXIT=$?` — read the echoed code, not the filtered output
   (memory: rtk swallows exit codes); then cold `pnpm exec eslint --no-cache ./src` and
   `pnpm exec prettier --check` on the changed `src/` files (memory: `--cache` and an eslint-clean run hide
   errors).
2. `pnpm exec vitest run portless-node portless-link doctor-service-target doctor-portless-node setup-portless-service dev-server report` in isolation; open the integration test and confirm step 2 spawns the temp-HOME file and asserts `process.execPath` equals that path.
3. From the checkout after `pnpm run build`: `node apps/infra-kit/cli/dist/cli.js doctor` → `portless node` reads `Skipped — not a global install`. Then `infra-kit --version` (the global): if it is **older** than the release carrying this change, `ls ~/.infra-kit/node` must fail (AC6 on the real machine — nothing but a global of this version may create it); if the global has already updated, skip this assertion and go to e2e step 2.
4. Grep `portless-node.ts` and the two test files: `writeFileSync|createWriteStream|openSync\(.*['"][wa]|node:fs/promises|fs\.promises|appendFile|truncate|cpSync|copyFileSync\([^,]+,\s*node\b` must match only sidecar/`.tmp-` targets (and the last alternative must not match at all); the module's only direct `node:fs` reference is the seam default (`fs?: PortlessNodeFs = fs`) — every call goes through the seam; `unlinkSync(node` / `chmodSync(node` absent (only tmp names are written, chmod'ed or unlinked); `copyFileSync\(process\.execPath, .*node'?\)` absent from the tests (T-1); `COPYFILE_FICLONE_FORCE` absent; `chmodSync` appears only inside the copy branch; the `linkSync` catch has no `code` allow-list (any throw → copy); `portless-node.ts` has no `from './portless-driver'` value import.
5. `git diff --stat` matches §11 — including the one-line `entry/mcp-proxy.ts` edit and nothing else under `entry/`.
6. e2e steps 0–4 with the user present (sudo); steps 5–7 recorded when they occur.

## 10. ADR

- **Decision:** the portless system service runs on `~/.infra-kit/node`, a hardlink (copy where a hardlink
  is refused) of the global infra-kit's Node, kept current by the same boot hook that keeps
  `~/.infra-kit/portless`; staleness is inode equality with `process.execPath` (version + size on the copy
  path), recorded in a sidecar with `method`, `refreshedAt` (file clock) and `versionChangedAt` (the only clock the restart advisory reads); `doctor` gains a `portless node` row that
  resolves a health-checked `stableNode` every remediation renders through; `setup` converges the file and
  prints the short sudo line.
- **Drivers:** pnpm 12 re-mints the Node path without a Node bump; portless has no `--node`, so the only
  lever is what `execPath` IS when `service install` runs (the daemon never consults it again); one
  command renderer already serves every surface.
- **Alternatives:** B `copyFile(FICLONE)` only (a full copy on this Mac — A's fallback, not its primary),
  C upstream `--node` (follow-up), D status quo (invalidated), E edit the plist to a symlink (invalidated:
  a symlink dangles across re-mint + reboot with no CLI run — AC1's exact scenario — while a hardlink
  cannot; every later `service install` rewrites the plist; root-owned grammar we do not own), F `cp -c`
  subprocess (invalidated: spawns in the boot path for nothing over `linkSync`).
- **Why:** the plist's first word becomes a name that cannot dangle — a hardlink keeps its inode alive
  through any re-mint, and a reboot with no CLI run in between still boots the daemon; `sudo` becomes
  once per machine — neither a release nor a Node bump touches the plist again; the printed command
  drops from ~200 to ~90 characters and never changes; the hot path is two stats and a 250-byte read; a
  refresh is 0.3 ms and 0 bytes on every layout this project runs; the trust model is unchanged.
- **Consequences:** the file shares an inode with the package manager's node — bytes no manager rewrites
  in place, but which macOS does not protect from an in-place write either (T-1: rename-only discipline,
  grep-verified, is the guard; the old inode survives a re-mint until our next boot relinks); 134 MB per
  Node bump on layouts where a hardlink is refused (root-owned `/usr/bin/node`, cross-device homes,
  exFAT/SMB/iCloud-dataless homes); `dev` prints the short line only for a hardlink, the deep line for a
  copy-path file; a daemon
  started before a Node bump runs the old Node until kickstart/reboot — `doctor` says so, exactly as it
  already does for a portless bump; a Homebrew node's Cellar dylibs can break the file without a version
  change — on the hardlink path that breaks doctor itself and no row detects it (§5.1), on the copy path
  N7 does; the `portless node` row and `setup` each spawn one
  short-lived process; `dev` prints on a candidate check without that spawn.
- **Follow-ups:** (1) upstream portless issue: `service install --node <path>` (or writing `argv[0]` as
  given) would let the plist name a path portless never realpaths — still a hardlink, per §4; (2) the progress doc records the
  `global/5` and `node@24.20.0` housekeeping as user-side notes; (3) re-examine after the next macOS
  update whether PM-4 ever fires; (4) if a Linux distro-node user reports the copy cost, the answer is a
  user-owned Node (volta/fnm), not a code change.

## 11. Scope by file

| File | Change |
|---|---|
| `apps/infra-kit/cli/src/dev/proxy/portless-node.ts` (new) | `ensurePortlessNode`, `stableNodeCandidate` (inode-only), `portlessNodePath`, `portlessNodeSidecar`, `PortlessNodeFs`, `PortlessNodeResult` (`kind: 'node'`), zod sidecar schema, hardlink-first with copy on ANY `linkSync` throw, orphan sweep, rename-only (T-1); **no value import from `portless-driver`**; header comment records facts 1–4, 6–8 and T-1 as the *why* |
| `apps/infra-kit/cli/src/dev/proxy/portless-link.ts` | `ServiceInstallSeams.stableNode`; `serviceInstallCommand` resolves `(stableNode === undefined ? candidate : stableNode) ?? execPath` (a `null` health verdict must not fall through to the candidate); `PortlessLinkResult.kind: 'link'`; `PortlessLinkLog` union; `bootPortlessLink` runs both steps; `realPortlessLinkDeps` → `realPortlessStableDeps` (`{ link, node }`, one memoised `isGlobal`) |
| `apps/infra-kit/cli/src/entry/mcp-proxy.ts` | one line at `:41`: the `'failed'` stderr message switches on `result.kind` |
| `apps/infra-kit/cli/src/entry/cli.ts` | no change (`logger.debug(result, message)` takes either shape) |
| `apps/infra-kit/cli/src/dev/proxy/__tests__/portless-link-fixtures.ts` | `fakeNodeFs` (call-log fake for `PortlessNodeFs` with inode/dev/size-bearing entries) |
| `apps/infra-kit/cli/src/dev/proxy/__tests__/portless-node.test.ts` (new) | §7 unit cases |
| `apps/infra-kit/cli/src/dev/proxy/__tests__/portless-link.test.ts` | boot logs two results; `isGlobal` memoised; four `serviceInstallCommand` snapshots |
| `apps/infra-kit/cli/src/dev/proxy/__tests__/portless-link-integration.test.ts` | steps 1–5 of §7 integration (hardlink present and executes; converged = inode + `refreshedAt` unchanged; foreign inode = relinked; checkout = nothing) |
| `apps/infra-kit/cli/src/dev/__tests__/dev-server.test.ts` | `:1508/:1542` gain an explicit empty-home seam; new "link + candidate stable node → short line, no spawn" case |
| `apps/infra-kit/cli/src/commands/doctor/doctor.ts` | `checkPortlessNode` (N1–N8) called first in `checkPortless` and its `stableNode` threaded into `ServiceTargetSeams`; seams `nodeVersionOf`, `isGlobal`, `nodeFs`; `serviceTargetVerdict` T1 wording, T5/T6 split, `daemonPredates({ nodeVersionChangedAt, portlessInstalledAt })` |
| `apps/infra-kit/cli/src/commands/doctor/report.ts` | `SECTION_MEMBERS`: `portless node` after `portless installed` |
| `apps/infra-kit/cli/src/commands/doctor/__tests__/doctor-portless-node.test.ts` (new) | one fixture per N1–N8; row-order spy |
| `apps/infra-kit/cli/src/commands/doctor/__tests__/doctor-service-target.test.ts` | T1, T5, T6, T7 (both clocks), T8, linux unit |
| `apps/infra-kit/cli/src/commands/doctor/__tests__/report.test.ts` | 36 → 37, comment updated |
| `apps/infra-kit/cli/src/commands/doctor/__tests__/report-inventory.test.ts` | `nodeVersionOf` + `isGlobal` stubs on the doctor deps; driver mock untouched |
| `apps/infra-kit/cli/src/commands/setup/setup.ts` | `PortlessServiceDeps.node`; `convergePortlessService` runs `ensurePortlessNode` and reports it; `portlessNodeDetail` |
| `apps/infra-kit/cli/src/commands/setup/__tests__/setup-portless-service.test.ts` | short sudo line; T5 plist → line printed; converged → none; `failed` node / null `nodeVersionOf` → fallback line |
| `apps/infra-kit/cli/src/dev/dev-server.ts` | no code change — `serviceInstallCommand` resolves the candidate when `stableNode` is undefined; the comment at `:1850-1853` gains one sentence naming the node half |
| `docs/portless-service-stable-node-plan.md` (this file) | status flips to approved/implemented with the commit hash |
| `docs/portless-service-stable-node-progress.md` (new) | e2e steps 0–7 with outputs (doctor before/after, the global's version); PM-4 watch note; the `global/5` + `node@24.20.0` housekeeping note |
