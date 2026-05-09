Update pnpm, Node.js, and Turbo to latest stable versions. Run all phases in order.

## Phase 1: Update pnpm

> `pnpm/action-setup@v5` reads the version from the `packageManager` field in `package.json` automatically, so GitHub workflows do not need separate version updates.

1. Read the current pnpm version from `packageManager` in `package.json` (this is the OLD version).
2. Run `pnpm run upgrade-pnpm` — this updates the `packageManager` field in root `package.json` automatically.
3. Read the new version from `packageManager` in `package.json`. If it matches the OLD version, pnpm is already up-to-date — skip to Phase 2.
4. Run `pnpm install` to regenerate the lockfile.
5. Verify: grep the entire repo for the OLD pnpm version (excluding `pnpm-lock.yaml` and `node_modules/`) — expect zero hits.

## Phase 2: Update Node.js

> `actions/setup-node@v6` reads the version from `.node-version` file automatically, so GitHub workflows do not need separate version updates.

1. Read the current Node.js version from `.node-version` file (this is the OLD version).
2. Run `pnpm run print-env-node` to list available Node.js versions. Pick the highest version number from the list.
3. If the latest version matches the OLD version, Node.js is already up-to-date — skip to Phase 3.
4. Update `.node-version` file with the new version.
5. Update the `env-use` script in `package.json` to reference the new version.
6. Run the updated `pnpm run env-use` to switch the local Node.js version.
7. Run `pnpm install` to recompile any native addons for the new Node.js version.
8. Verify: grep the entire repo for the OLD Node.js version (excluding `pnpm-lock.yaml` and `node_modules/`) — expect zero hits.

## Phase 3: Update Turbo

1. Read the current Turbo version from `devDependencies.turbo` in `package.json` (this is the OLD version).
2. Run `npm view turbo version` to find the latest stable version.
3. If the latest version matches the OLD version, Turbo is already up-to-date — skip to Finalize.
4. Update `devDependencies.turbo` in `package.json` to `<new version>` (pin exactly — no `^` prefix).
5. Update both `turbo@<old>` references in `devops/scripts/lib/deploy-utils.sh` to `turbo@<new>`.
6. Run `pnpm install` to update the lockfile.
7. Verify: grep the entire repo for the OLD Turbo version (excluding `pnpm-lock.yaml` and `node_modules/`) — expect zero hits.

## Finalize

- If no phase made changes, report that everything is already up-to-date and stop.
- Commit all changes with message: `Update pnpm <old> → <new>, Node.js <old> → <new>, Turbo <old> → <new>` (omit whichever components were already up-to-date)
- Push to the current branch.
