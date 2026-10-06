---
name: update-toolchain
description: Bump pnpm, Node.js, Turbo, and the @slip-stream-kit packages to their latest stable versions on dev, then commit and push
disable-model-invocation: true
---

# Update toolchain: pnpm, Node.js, Turbo, and @slip-stream-kit

Run every phase in order. Skip a phase when its component is already up-to-date. The run commits and
pushes to `dev` on its own in Finalize — do not ask for confirmation. The human typing
`/infra-kit:update-toolchain` is the approval, which is why the skill is human-invoked only.

## Phase 0: Preflight

1. `git branch --show-current` must print `dev`. On any other branch, stop and report — never switch
   branches yourself.
2. `git status --porcelain` must be empty. If it is not, stop and report the dirty paths: the
   Finalize commit must hold only this run's changes.
3. Run `git pull --ff-only` so the bump lands on top of the latest `dev`. If it fails, stop and
   report.

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
2. Run `pnpm runtime set node 24 --global`. A bare major resolves to the exact latest release in that
   line and prints it (`+ node 24.21.0`) — that resolved version is the NEW version.
3. If the resolved version matches the OLD version, Node.js is already up-to-date — skip to Phase 3.
4. Update the `.node-version` file with the new version.
5. Update the `runtime-set-node` script in `package.json` to reference the new version.
6. Run the updated `pnpm run runtime-set-node` to pin the exact version globally.
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

## Phase 4: Update @slip-stream-kit packages

> The `@slip-stream-kit/*` packages (`config`, `vite`, `eslint-plugin`, …) are released in lockstep
> with the infra-kit CLI. They are in `minimumReleaseAgeExclude`, so a version published minutes ago
> is installable.

1. Find every declaration: grep `@slip-stream-kit/` in all `package.json` files and in
   `pnpm-workspace.yaml` (`catalog:` and every named `catalogs:` entry), excluding `node_modules/`.
   Skip a `workspace:` specifier — that package lives in this repo. Skip `catalog:` specifiers in a
   `package.json` — their version lives in the catalog entry you already found.
2. Skip every hit under `vendor/` unless the root `infra-kit.json` has a `vendorSource` key. A
   consumer's `vendor/` is a mirror checksummed by `infra-kit vendor check` against
   `vendor/.sync-manifest.json`; editing it reds `qa`, and only `infra-kit vendor sync`, run by a
   human from the source repo, refreshes it. List the skipped vendor ranges in the summary instead.
3. For each distinct package name, run `pnpm view @slip-stream-kit/<name> version` to get the
   latest version. Record each declaration's current range (the OLD version).
4. If every declaration already names the latest version, skip to Finalize.
5. Rewrite each declaration's version to the latest, keeping its prefix (`^0.17.0` →
   `^0.17.3`). Edit the files directly — do NOT use `pnpm update -r`: it rewrites the guarded
   `vendor/` ranges too.
6. Run `pnpm install` to update the lockfile.
7. Verify: grep the entire repo for each OLD `@slip-stream-kit/<name>` range (excluding
   `pnpm-lock.yaml`, `node_modules/`, and the skipped `vendor/` hits) — expect zero hits.

## Finalize

1. If no phase made changes, report that everything is already up-to-date and stop.
2. Commit every changed file with the message
   `Update pnpm <old> → <new>, Node.js <old> → <new>, Turbo <old> → <new>, @slip-stream-kit <old> → <new>`
   (omit whichever components were already up-to-date). If a commit hook rejects it, stop and report
   the hook's output — never bypass it with `--no-verify`.
3. Push to `origin dev`. If the push is rejected because `dev` moved, run `git pull --rebase`, re-run
   `pnpm install`, and push once more; if that also fails, stop and report.
4. Report the components that changed (old → new), the commit hash, any skipped `vendor/` ranges
   from Phase 4, and the push result.
