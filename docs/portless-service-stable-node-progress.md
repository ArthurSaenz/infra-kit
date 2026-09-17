# Progress: a stable Node for the portless system service

Companion to `docs/portless-service-stable-node-plan.md`. Records the verifier pass (§9) and the e2e steps
(§7) as they happen. Machine: Arthur's MacBook, Darwin 27.0.0, pnpm 12.4.1, Node v24.21.0.

## §9 verifier pass — 2026-09-17, from the checkout

1. `cd apps/infra-kit/cli && pnpm run qa` — see the "qa" entry below (raw exit code recorded there).
2. `pnpm exec vitest run doctor report setup dev-server portless` → 36 files, 593 tests, all passed.
   `pnpm exec vitest run portless-node portless-link` → 3 files, 81 tests, all passed. The integration test's
   step 2 spawns `<tempHome>/.infra-kit/node -p process.execPath` and asserts it prints that path; the tmpdir
   shares the node volume here, so the hardlink branch ran (not the copy fallback). `tsc --noEmit` clean.
3. From the checkout, `ls ~/.infra-kit/node` → "No such file or directory" after every test run (AC6 on the
   real machine). The global is 0.10.0, older than the release carrying this change, so the assertion is
   live: nothing but a global of the new version may create the file.
4. §9.4 greps over `portless-node.ts` and the two test files:
   - write-pattern grep matches only the `PortlessNodeFs` seam declaration, the sidecar tmp write
     (`nodeFs.writeFileSync(tmp, …)`) and the integration test's package staging `cpSync` (not the node path);
     `copyFileSync(…, node)` — no match.
   - `COPYFILE_FICLONE_FORCE`, `unlinkSync(node`, `chmodSync(node`, `from './portless-driver'`,
     `copyFileSync(process.execPath, …node)` in tests — none.
   - `chmodSync` appears once, inside the `linkSync` catch, on the copy tmp.
   - the `linkSync` catch is a bare `catch {` — any throw → copy.
5. `git status` under `entry/`: only `mcp-proxy.ts` (the `'failed'` message switching on `result.kind`).

## e2e (§7) — the user-run steps

**Step 0 — doctor before (global 0.10.0, `cd ~ && infra-kit doctor`), 2026-09-17 13:10:**

```
  Dev proxy (portless)                                            5/6 · 1 failed
    ✓ portless installed                    portless is resolvable from node_modules
    ✗ portless service target               The service runs
      `/Users/arthur/Library/pnpm/global/v11/60d8-18d60e2c72d3bda0-0/node_modules/.pnpm/node@runtime+24.21.0/node_modules/node/bin/node`,
      which no longer exists (Node was upgraded). Re-run: `sudo
      /Users/arthur/Library/pnpm/global/v11/5f64-18d6102c7ca15868-0/node_modules/.pnpm/node@runtime+24.21.0/node_modules/node/bin/node
      /Users/arthur/.infra-kit/portless/dist/cli.js service install`
    ✓ portless serving TLS on :443          (the daemon started this morning is still up; it dies at the next boot)
```

Evidence for the plan's driver 1, stronger than the plan states: the plist was re-installed at 11:26 today
pointing at `60d8-…`; by 13:10 pnpm had re-minted the Node project dir again (`5f64-…`) — **two re-mints in
one day, no Node bump**. Every re-mint is one more `sudo` under the old scheme.

**Steps 1–7 — pending.** They need the release carrying this change to be published and the global to
auto-update (from the checkout every surface is `skipped-local`, by design). Then, with the user present:

1. `infra-kit setup` from the global → `created portless node — linked Node v24.21.0` and exactly one
   printed line: `sudo /Users/arthur/.infra-kit/node /Users/arthur/.infra-kit/portless/dist/cli.js service install`.
2. The user runs that line once. `sudo launchctl print system/sh.portless.proxy | grep program` shows both
   stable words.
3. `infra-kit doctor` → `portless node` pass, `portless service target` pass (T8), `:443` pass.
4. Re-mint without a Node bump (`pnpm add -g <anything>` that re-creates `global/v11/{pid}-{ts}`), reboot with
   no infra-kit command in between → `:443` still served (AC1). Record `stat -f %i ~/.infra-kit/node` before
   and after — the inode is the same one the daemon mapped.
5. Node bump (`pnpm env use` / `pnpm add -g node@…`), one infra-kit command → `refreshed … linked Node <new>`,
   `doctor` shows T7 "predates Node <new> … kickstart"; after `sudo launchctl kickstart -k system/sh.portless.proxy`
   → T8 (AC2). No `service install`.
6. PM-4 watch: none expected on this machine (hardlink path; the pnpm node has no Cellar dylibs).
7. `rm -rf ~/Library/pnpm/global/5` — the dead pnpm ≤ 11 layout; unrelated to the daemon, noted per the
   predecessor's follow-up (2).

## Verifier findings folded back (2026-09-17)

- Architect implementation review: one must-fix — the copy branch could truncate a stale tmp that aliases
  the live inode under a reused pid (plan §5.9). Fixed with `COPYFILE_EXCL`; unit case + `expectRenameOnly`
  assertion added; re-verified APPROVE.
- Full `qa` #1: `dist-shebang` red — `portless-node.ts` pulled `zod` into the `ik-mcp` bundle. Replaced with a
  hand validator. `orca-dev` (3 tests) red under full-suite load, green alone (20/20), untouched by this
  change — a load flake, same family as the ones already recorded in memory.
- Deslop pass: setup's duplicate health derivation removed (doctor's `portlessServiceTargetState` is the one
  owner); shared `hardlinkNodeFs`/`sidecarFor` fixture builders; `PortlessNodeStat.isSymbolicLink` and the
  fake's unread `mode` field deleted. Regression: 37 files / 606 tests green, tsc 0, eslint 0.
