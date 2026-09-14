# Progress — portless stable path

## PM-1 experiment (2026-09-14)

**Question:** after a portless daemon has started, does it read anything from its own package
directory? If yes, deleting the package dir on an infra-kit update would break a running daemon.

**Setup.** `PORTLESS_STATE_DIR` was set to a temp dir under the session scratchpad
(`.../scratchpad/pm1/state`) for every portless invocation below; the real `~/.portless` state
dir was not used deliberately (see "Incident" at the end — one command briefly touched it by
accident and is documented there).

Portless package resolved from `apps/infra-kit/cli/node_modules/portless`
(realpath, pnpm content-addressed store):

```
ORIG=/Users/arthur/Library/pnpm/store/v11/links/@/portless/0.15.6/3a8de753e...66eb5/node_modules/portless
```

version: `0.15.6`.

### Commands and output

1. Copy the package to a scratch dir and verify it runs standalone (including its sibling chunk
   file, which `dist/cli.js` imports):

   ```
   $ cp -R "$ORIG" "$SCRATCH/copy/portless"
   $ find "$SCRATCH/copy/portless/dist" -maxdepth 1
   .../dist/cli.d.ts .../dist/index.js .../dist/cli.js .../dist/chunk-SLEZT6EJ.js .../dist/index.d.ts
   $ node "$SCRATCH/copy/portless/dist/cli.js" --version
   0.15.6
   ```

2. Start a tiny HTTP target on an unprivileged port:

   ```
   $ node -e 'require("http").createServer((q,s)=>s.end("target-ok")).listen(18081)' &
   TARGET_PID=78753
   $ curl -sS http://127.0.0.1:18081/
   target-ok
   ```

3. Start the daemon **from the scratch copy**, unprivileged port, no TLS, isolated state dir:

   ```
   $ PORTLESS_STATE_DIR="$SCRATCH/state" node "$SCRATCH/copy/portless/dist/cli.js" proxy start --port 18443 --no-tls
   HTTP proxy started on port 18443
   ```

   Daemon PID (from `$SCRATCH/state/proxy.pid`): `79201`, running
   `.../pm1/copy/portless/dist/cli.js proxy start --foreground --port 18443 --no-tls --skip-trust`
   (portless re-execs itself with `--foreground` to detach — this is the daemon, not a hung
   foreground call).

   ```
   $ curl -sS -o /dev/null -w 'http_code=%{http_code}\n' http://127.0.0.1:18443/
   http_code=404   # expected: no routes registered yet
   ```

4. Register a route via the **original** node_modules copy against the same state dir, then
   route through the proxy (note: `list` shows the route as `http://pm1.localhost:18443`, so the
   `Host` header must include the port):

   ```
   $ PORTLESS_STATE_DIR="$SCRATCH/state" node "$ORIG/dist/cli.js" alias pm1 18081
   Alias registered: pm1.localhost -> 127.0.0.1:18081
   $ curl -sS -H 'Host: pm1.localhost:18443' http://127.0.0.1:18443/
   target-ok
   ```

   Confirmed working **before** deletion.

5. Delete the daemon's own package directory while it runs:

   ```
   $ rm -r "$SCRATCH/copy"
   $ ls "$SCRATCH/copy"
   ls: .../pm1/copy: No such file or directory
   $ ps -p 79201
     PID TTY  TIME CMD
   79201 ??   0:00.06 node .../pm1/copy/portless/dist/cli.js proxy start --foreground ...
   ```

   Daemon process is still alive (ps still shows it — the OS keeps the process image after
   `unlink`, this is expected and not evidence of anything).

   ```
   $ curl -sS -w '\nhttp_code=%{http_code}\n' -H 'Host: pm1.localhost:18443' http://127.0.0.1:18443/
   target-ok
   http_code=200
   ```

   **The daemon kept serving the existing route after its own package directory was deleted.**

6. Repeat: remove the alias, confirm 404, re-add it, confirm 200 again — both via the original
   (still-present) node_modules copy, against the same state dir, with the daemon's package dir
   still deleted:

   ```
   $ PORTLESS_STATE_DIR="$SCRATCH/state" node "$ORIG/dist/cli.js" alias --remove pm1
   Removed alias: pm1.localhost
   $ cat "$SCRATCH/state/routes.json"
   []
   $ curl ... (polled 5x, 0.3s apart)
   attempt 1..5: http_code=404
   ```

   (Note: the very first removal check, run without a poll delay, still returned 200 once —
   portless's daemon appears to pick up `routes.json` changes via a debounced file watch rather
   than synchronously; polling a few hundred ms later showed the expected 404 consistently. Not
   relevant to the PM-1 question, recorded for the doctor implementation's awareness.)

   ```
   $ PORTLESS_STATE_DIR="$SCRATCH/state" node "$ORIG/dist/cli.js" alias pm1 18081
   Alias registered: pm1.localhost -> 127.0.0.1:18081
   $ curl -sS -H 'Host: pm1.localhost:18443' http://127.0.0.1:18443/   # after the same short debounce
   target-ok
   $ PORTLESS_STATE_DIR="$SCRATCH/state" node "$ORIG/dist/cli.js" list
   Active routes:
     http://pm1.localhost:18443  ->  localhost:18081  (alias)
   ```

   `alias`/`alias --remove`/`list`, run from the still-present **original** copy against the
   same state dir, all worked normally while the daemon's own package dir stayed deleted.

7. Check for any open file handle into the deleted directory:

   ```
   $ lsof -p 79201 | awk 'NR==1 || /copy/ || /pm1/'
   COMMAND   PID   USER   FD   TYPE  ... NAME
   node    79201 arthur    1w   REG  ... .../pm1/state/proxy.log
   node    79201 arthur    2w   REG  ... .../pm1/state/proxy.log
   node    79201 arthur   12r   REG  ... .../pm1/state/routes.json
   ```

   No file descriptor referencing anything under the deleted `copy/` directory — only the state
   dir's `proxy.log` and `routes.json`. This matches the Architect's prediction: `cli.js:22`
   statically imports its one chunk at boot (already loaded into the V8 module cache before
   deletion), and its `readFile` sites resolve from cwd/state dir, not the package dir.

### Cleanup

```
$ kill 79201 78753
$ ps -p 79201; ps -p 78753        # both: no such process
$ ps aux | grep -i portless       # empty
$ lsof -iTCP:18443 -sTCP:LISTEN; lsof -iTCP:18081 -sTCP:LISTEN   # both empty, ports free
```

No sudo, no privileged ports, no leftover processes.

### Verdict

**Keeps running.** The daemon continued serving its already-registered route, and continued to
accept `alias`/`alias --remove`/`list` operations from a separate (still-present) portless copy
against the same state dir, after its own package directory was deleted out from under it. No
open file handle into the deleted directory was found. This matches the plan's stated
expectation ("no self-dir reads after boot").

**Resulting §5.5 status:** the "daemon predates the installed portless" row stays **`warn`**
(not promoted to `fail`). Its wording in §5.5 ("The running daemon predates portless
`<version>` that `dev` will talk to. Restart it: …") is correct as written — the daemon is not
broken, only running stale code, which is exactly what `warn` communicates.

### Incident — accidental real-state-dir daemon (recorded for transparency)

While probing `portless`'s CLI surface, `node "$ORIG/dist/cli.js" proxy start --help` was run to
discover `proxy start`'s flags. **`proxy start` does not recognize `--help` as a flag** — it
silently ignores it and starts a real proxy. Because no `PORTLESS_STATE_DIR` override was set for
that one probe call, it used the default `~/.portless` and briefly ran a real daemon (attempted
port 443, sudo was not available non-interactively so it fell back to port 1355 without
elevating — no privileged port was actually bound). It was killed within the same turn once
noticed (`kill 70797`). Verified afterward: no privileged port was ever listened on, no launchd
system daemon exists in a running state that this could have collided with (`lsof -iTCP:443`
empty both before investigation continued and after), `~/.portless/routes.json` was untouched
(`[]`, unchanged), and the only files touched (`proxy.pid`, `proxy.port`, `proxy.tls`,
`proxy.log`) ended up empty/reset — the same state they'd be in with no daemon running, which
was also true immediately before the mistake. No corrective action beyond the kill was needed.
**Lesson for anyone else probing this CLI:** never call `<subcommand> start --help`; use the
top-level `portless --help` (which documents `proxy start`'s flags in the "Options" section) or
`portless proxy --help` (safe — documents the subcommand without executing it) instead, and
always pass `PORTLESS_STATE_DIR` on every single invocation, not just the ones you believe are
side-effecting.

## PM-3 — user-run verification (needs sudo + a reboot; the implementation never runs these)

Run from any shell **after** the CLI that ships this change is the global install (`pnpm add -g infra-kit@<next>`):

```sh
# 1. Converge the link and see the single portless sudo line
infra-kit setup

# 2. Re-install the service THROUGH the link (this is the line setup/doctor print; node path is this machine's runtime)
sudo /Users/arthur/Library/pnpm/global/v11/fc94-18d4f95f4fcc83b0-0/node_modules/.pnpm/node@runtime+24.21.0/node_modules/node/bin/node ~/.infra-kit/portless/dist/cli.js service install

# 3. Prove the plist carries the link, not a version-specific path
sudo launchctl print system/sh.portless.proxy | grep -A3 'program'
grep -A4 ProgramArguments /Library/LaunchDaemons/sh.portless.proxy.plist

# 4. doctor must now show:  ✔ portless service target
infra-kit doctor

# 5. The actual PM-3 scenario: update infra-kit, reboot WITHOUT running any infra-kit command first,
#    then run one — the daemon must come back on :443 without a second sudo.
pnpm add -g infra-kit@<next+1>      # or wait for the silent auto-update
sudo reboot
infra-kit doctor                     # first infra-kit command after boot re-points the link; KeepAlive retries within ~10 s
curl -sk -o /dev/null -w '%{http_code}\n' https://anything.localhost/   # expect a portless answer, not "connection refused"
```

Expected: step 4 is green; after step 5 the `:443` row is green again with **no** `service install` re-run. Record the outputs here when done.

## Gate + on-machine doctor comparison (2026-09-14, implementation complete, uncommitted)

- `cd apps/infra-kit/cli && pnpm run qa` → exit 0 (prettier, eslint, tsc, vitest 294 files / 3494 tests). Cold `eslint --no-cache ./src` → 0 errors, 73 pre-existing warnings, none inside a changed hunk.
- Every `package.json` + `pnpm-lock.yaml` sha256 identical before/after qa (no manifest rewrite).
- `pnpm run build` → exit 0.

**Global infra-kit 0.5.6** (`cd ~ && infra-kit doctor`), portless section — 5 rows, `:443` red, fix line carries the version-specific `global/v11/8a83-…/.pnpm/infra-kit@0.5.6/…/portless/dist/cli.js` path:

```
  Dev proxy (portless)                                            4/5 · 1 failed
    ✓ portless installed
    ✗ portless serving TLS on :443   … `sudo …/node@runtime+24.21.0/…/bin/node …/global/v11/8a83-…/.pnpm/infra-kit@0.5.6/node_modules/portless/dist/cli.js service install`
```

**Working-tree build** (`cd ~ && node <repo>/apps/infra-kit/cli/dist/cli.js doctor`), portless section — 6 rows; the new row names the actual root cause on this machine:

```
  Dev proxy (portless)                                            4/6 · 2 failed
    ✓ portless installed
    ✗ portless service target        The service runs `/Users/arthur/Library/pnpm/nodejs/24.18.0/bin/node`,
                                     which no longer exists (Node was upgraded). Re-run: `sudo <node 24.21.0> <portless cli.js> service install`
    ✗ portless serving TLS on :443   …
```

Why the fix line here is NOT the link: this build runs from a git checkout, so `isGlobalInstall` answers false (`.git` ancestor), `bootPortlessLink` is `skipped-local`, `~/.infra-kit/portless` is not created, and the command falls back to the real path — exactly the PM-2 guard. The link-through path is proven by `portless-link-integration.test.ts` (staged pnpm-12 global layout, `version --json` from `$HOME`, link created → follows a moved dir → untouched from a checkout). On this machine the row will read `✗ … Node was upgraded` until the user runs the PM-3 step 2 command once; after that, `warn`/`pass` per §5.5.

**Finding:** the `:443` failure in the original screenshot was never the pnpm layout — the plist points at Node **24.18.0**, removed by the 2026-09-13 toolchain bump. The plan's "one sudo per Node bump" residual is what this machine is currently hitting.
