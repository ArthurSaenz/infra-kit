---
name: update-toolchain
description: >-
  Update pnpm, Node.js, and Turbo to their latest stable versions across the monorepo. This skill
  should be used when the user explicitly asks to bump the repository's package manager, Node
  runtime, or Turbo build tool. Run all version-bump phases in order; each phase self-skips when
  already current. Require explicit user confirmation before committing or pushing.
---

# Update toolchain: pnpm, Node.js, and Turbo

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
3. If the latest version matches the OLD version, Turbo is already up-to-date — skip to Finalize.
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

## Finalize

1. If no phase made changes, report that everything is already up-to-date and stop.
2. Summarize the diff: which components changed, and their old → new versions.
3. Propose the commit message:
   `Update pnpm <old> → <new>, Node.js <old> → <new>, Turbo <old> → <new>`
   (omit whichever components were already up-to-date).
4. Require explicit user confirmation before committing and pushing. Do not auto-commit or auto-push:
   this procedure is destructive and may be reached via skill auto-discovery.
5. On confirmation: commit, then push to the current branch.
