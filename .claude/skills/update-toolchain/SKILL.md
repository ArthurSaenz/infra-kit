---
name: update-toolchain
description: >-
  Update pnpm, Node.js, Turbo, and infra-kit to their latest stable versions across the monorepo.
  This skill should be used when the user explicitly asks to bump the repository's package manager,
  Node runtime, Turbo build tool, or the infra-kit devDependency. Run all version-bump phases in
  order; each phase self-skips when already current. Require explicit user confirmation before
  committing or pushing.
---

# Update toolchain: pnpm, Node.js, Turbo, and infra-kit

Run every phase in order. Skip a phase when its component is already up-to-date. Do not commit or
push until the Finalize phase, and only after explicit user confirmation.

## Phase 1: Update pnpm

> `pnpm/action-setup@v5` reads the version from the `packageManager` field in `package.json`
> automatically, so GitHub workflows do not need separate version updates.

1. Read the current pnpm version from `packageManager` in `package.json` (this is the OLD version).
2. Run `pnpm run upgrade-pnpm` — this updates the `packageManager` field in root `package.json`
   automatically.
3. Read the new version from `packageManager` in `package.json`. If it matches the OLD version, pnpm
   is already up-to-date — skip to Phase 2.
4. Run `pnpm install` to regenerate the lockfile.
5. Verify: grep the entire repo for the OLD pnpm version (excluding `pnpm-lock.yaml` and
   `node_modules/`) — expect zero hits.

## Phase 2: Update Node.js

> `actions/setup-node@v6` reads the version from the `.node-version` file automatically, so GitHub
> workflows do not need separate version updates.

1. Read the current Node.js version from the `.node-version` file (this is the OLD version).
2. Run `pnpm run print-env-node` to list available Node.js versions. Pick the highest version number
   from the list.
3. If the latest version matches the OLD version, Node.js is already up-to-date — skip to Phase 3.
4. Update the `.node-version` file with the new version.
5. Update the `env-use` script in `package.json` to reference the new version.
6. Run the updated `pnpm run env-use` to switch the local Node.js version.
7. Run `pnpm install` to recompile any native addons for the new Node.js version.
8. Verify: grep the entire repo for the OLD Node.js version (excluding `pnpm-lock.yaml` and
   `node_modules/`) — expect zero hits.

## Phase 3: Update Turbo

1. Read the current Turbo version from `devDependencies.turbo` in `package.json` (this is the OLD
   version).
2. Run `pnpm view turbo version` to find the latest stable version. (Use `pnpm view`, not
   `npm view`, so the version lookup uses the same resolver that `pnpm install` uses.)
3. If the latest version matches the OLD version, Turbo is already up-to-date — skip to Phase 4.
4. Update `devDependencies.turbo` in `package.json` to `<new version>` (pin exactly — no `^` prefix).
5. Update the `turbo@<old>` references in `devops/scripts/lib/deploy-utils.sh` to `turbo@<new>`.

   > Robustness note: Turbo's version is NOT single-location, and the two locations can hold
   > different values (for example, `package.json` may pin `turbo@2.10.0` while `deploy-utils.sh`
   > pins `turbo@2.9.18`). Treat the `deploy-utils.sh` Turbo pin as an INDEPENDENT version source:
   > grep the literal `turbo@<version>` token in that file and rewrite it to `turbo@<new>`
   > regardless of the `package.json` OLD value, so a desync does not cause a silent miss.

6. Run `pnpm install` to update the lockfile.
7. Verify: grep the entire repo for the OLD Turbo version (excluding `pnpm-lock.yaml` and
   `node_modules/`) — expect zero hits.

## Phase 4: Update infra-kit

infra-kit is not a passive build tool like Turbo. It is registered as an MCP server (`.mcp.json` →
`node_modules/infra-kit/dist/mcp.js`), it is a doppler-backed CLI, and it provides the `defineConfig`
contract consumed by the `infra-kit.config.ts` files under `vendor/configs/*` and
`vendor/packages/*` (the exact set varies by repo — discover them at runtime, see below).
infra-kit is pre-1.0 (0.x), so a minor/patch bump may carry breaking changes.
Those config files are OUTSIDE the tsconfig / vite build graph, so `pnpm build` and `ts-check` never
compile them — a green build proves nothing about the config contract. Verify infra-kit with its own
`audit` command, which actually loads the config files.

> `infra-kit audit` is **cwd / per-package scoped**. Its `--all` flag audits only NON-vendor
> workspace packages and its `--root` flag looks for a root `infra-kit.config.ts` (which this repo
> does not have) — so **`--all` and `--root` never reach the vendor configs**. To exercise the
> config files, run a **bare `pnpm exec infra-kit audit` from inside each config directory**.
> **Discover the directories at runtime — do not hardcode a list**, as the set varies per repo (e.g.
> some repos have `vendor/configs/serverless-config`, others do not):
>
> ```sh
> for d in vendor/configs/* vendor/packages/*; do [ -f "$d/infra-kit.config.ts" ] && echo "$d"; done
> ```
>
> With `--json`, the audit returns `{ allPassed, packages }`; each `packages[]` entry has its own
> `checks` array (flatten `packages[].checks` across entries). The config-contract signal is the
> single check named `infra-kit.config.ts` (`status: "pass"`, message `present and valid`). The other
> checks (`script:build`, `script:ts-check`, …) are RULE violations, not config-contract signals, and
> may report `fail` (making `allPassed: false`) without indicating any breakage — so gate on the
> `infra-kit.config.ts` check specifically, never on `allPassed` or the exit code.

1. Read the current infra-kit version from `devDependencies.infra-kit` in `package.json` (this is the
   OLD version).
2. Run `pnpm view infra-kit version` to find the latest published version.
3. If the latest version matches the OLD version, infra-kit is already up-to-date — skip to Finalize.
4. Establish a BASELINE at the OLD version: for each config directory discovered above, run
   `pnpm exec infra-kit audit --json` from inside that directory
   (e.g. `(cd vendor/configs/prettier-config && pnpm exec infra-kit audit --json)`). Record (a) that
   every directory's `infra-kit.config.ts` check reports `status: "pass"` ("present and valid") and
   (b) any pre-existing rule-violation findings (the `script:*` checks). This baseline lets the
   post-bump run be attributed to the bump rather than to pre-existing noise.

   > `audit` loads the `.ts` configs via infra-kit's own bundled loader — root `tsx` is not
   > installed — so a loader error at this baseline step is environmental, not a contract break.
5. Update `devDependencies.infra-kit` in `package.json` to `<new version>` (pin exactly — no `^`
   prefix).
6. Run `pnpm install` to update the lockfile and swap the installed binary.
7. Verify the pin: grep the entire repo for the OLD infra-kit version (excluding `pnpm-lock.yaml` and
   `node_modules/`) — expect zero hits.
8. Smoke-test the binary: run `pnpm exec infra-kit version` (the `version` subcommand — there is no
   global `--version` flag) and confirm it prints the NEW version.
9. HARD GATE — verify the config contract still loads under the new version. Re-audit each
   discovered config directory with `pnpm exec infra-kit audit --json` run from inside each directory (same
   invocation as the baseline). This proves the configs LOAD/RUN at runtime under the new version; it
   does not type-check them (they have no type consumer), which is the correct and only available
   guarantee. Gate on the per-directory `infra-kit.config.ts` check, never on `allPassed` or the
   exit code (the `script:*` rule checks routinely fail and would false-negative the gate).
   - Require positive proof of loading: confirm every discovered directory returns an
     `infra-kit.config.ts` check with `status: "pass"`. A directory whose audit does not return that
     check (absent/short-circuited) is NOT a pass — treat it the same as a failure and surface it.
   - Contract break (a directory whose `infra-kit.config.ts` check was `pass` at baseline now reports
     `fail` / not valid / fails to load or parse): STOP, do not Finalize, and roll back the partial
     bump — run `git checkout -- package.json pnpm-lock.yaml` and THEN re-run `pnpm install` to
     reconcile `node_modules` back to the OLD binary (a bare checkout would leave the NEW broken
     binary installed). Report the breakage.
   - Ambiguous failure (audit errors in a way not tied to the per-config check, or new unexplained
     findings not seen at baseline): do NOT auto-classify against infra-kit's error taxonomy (it
     drifts across 0.x versions). STOP and surface the full audit output to the user for a decision.
     If `audit` reports it needs env, run `pnpm run dx-env-load` and retry once before surfacing.
   - Same rule-violation findings as baseline (the `script:*` checks unchanged, every
     `infra-kit.config.ts` check still `pass`): informational, not a bump blocker — report and
     proceed.
10. Tool-health check (advisory): run `pnpm run dx-doctor` (`infra-kit doctor`). This checks gh and
    doppler CLI installation and authentication ONLY; it does NOT validate the config contract. Do
    not hard-fail the phase on its exit code (it may fail on missing doppler auth). Report its
    output.
11. Note MCP staleness: the infra-kit MCP server loaded in the current session is now stale; the new
    `dist/mcp.js` tool surface only takes effect after restarting the session or reloading MCP.
    State this rather than claiming the new MCP surface is verified in-session.

## Finalize

1. If no phase made changes, report that everything is already up-to-date and stop.
2. Summarize the diff: which components changed, and their old → new versions.
3. Propose the commit message:
   `Update pnpm <old> → <new>, Node.js <old> → <new>, Turbo <old> → <new>, infra-kit <old> → <new>`
   (omit whichever components were already up-to-date).
4. Require explicit user confirmation before committing and pushing. Do not auto-commit or auto-push:
   this procedure is destructive and may be reached via skill auto-discovery.
5. On confirmation: commit, then push to the current branch.
