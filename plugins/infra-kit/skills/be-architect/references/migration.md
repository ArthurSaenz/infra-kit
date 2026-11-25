# Migrating a backend package to domain folders

The four-commit recipe is in [SKILL.md](../SKILL.md#migration-recipe). This file holds the detail each step
needs.

## Rename map

One TSV per app, `old<TAB>new`, paths relative to the package directory (where `eslint-suppressions.json`
lives). Blank lines and `#` comments are ignored. A line ending in `/` on both sides renames a directory, and
every key under it moves with it.

```
# commit 1: rename in place
src/services/orderType.ts	src/services/order-type.service.ts
# commit 3: move into the domain
src/services/order-type.service.ts	src/services/orders/order-type.service.ts
```

Use one map per rename commit. Generate it from the approved grouping and drive `git mv` from the same file,
so the moves and the re-key cannot disagree:

```bash
git mv src/services/orderType.ts src/services/order-type.service.ts
```

Do not derive the map from `git diff -M`: its similarity guess can pair the wrong files.

## Edge census

After commit 1, list every cross-domain runtime edge the planned grouping would create:

1. In a scratch worktree, `git mv` the files into the proposed folders (not committed).
2. Add a throwaway, uncommitted config block enabling `@wl/service-public-api` and `boundaries/dependencies` at
   `error`, scoped to `src/**/*.{ts,mts,cts,js}`.
3. `pnpm exec eslint -f json ./src > edges.json` and list every `crossDomainRuntime` and
   `boundaries/dependencies` hit.

Iterate the grouping until every remaining edge has a planned fix (inject, compose in
`src/controllers/composition/`, or move a lib-test-passing helper to `src/lib/`), then show the grouping and
the census to the human. Commit 2 starts only after approval.

## Per-commit checklist

- `pnpm run qa` green.
- The app's api unit tests green (`pnpm --filter <api-package> run test`) — the only check that catches a stale
  `vi.mock('../orders.js')` after a move.
- Renames: suppressions re-keyed (dry run first), per-rule before/after counts in the commit body,
  `pnpm exec eslint --prune-suppressions ./src` changes nothing.
- No `eslint --suppress-all`, no `eslint-disable`, no `'off'` line for any rule in the enforcement table.
- Commits 1 and 3 contain no logic change; commit 2 contains no move.

## Handler and dist checks

Serverless handlers point into `dist/controllers/*`, so moving services does not change them — but a layer
rename does. After any commit that touches `controllers/`, do a clean build (delete `dist/` **and**
`tsconfig.tsbuildinfo`, which otherwise keeps stale outputs alive) and confirm every `handler:` in
`serverless.yml` resolves to a built `.js` file. Check Dockerfile `CMD` paths the same way.

## Layer renames

A package whose layers do not match the [tree](../SKILL.md#src-tree) (`lambda_controllers/`,
`fastify_controllers/`, `libs/`) gets a commit 0 before commit 1: rename the layer directories only, update
every reference (`serverless.yml` handlers, imports, docs, specs), re-key suppressions with a directory map
entry (the `wl-config/folder-case` entries drop), and remove any `'@wl/package-structure': 'off'` line once
lint is green.
