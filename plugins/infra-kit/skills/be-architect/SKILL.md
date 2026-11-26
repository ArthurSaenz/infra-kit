---
name: be-architect
description: Build, review and migrate backend api packages — services/<domain>/ folders, public API via index.ts, type-only cross-domain imports, controllers compose
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/be-architect/scripts/rekey-suppressions.mjs *)
---

# Backend Service Architecture Skill

## Core Principles

- A service folder is a **domain**: `services/<domain>/` groups every service of one business area
- A domain is entered only through its `index.ts`
- Domains never import runtime code from each other (`import type` is fine)
- **Controllers compose**: they construct services and inject one domain into another
- `src/lib/` is domain-free; anything with a domain rule stays in its domain

Lint messages from `@wl/package-structure`, `@wl/service-files`, `@wl/service-public-api` and
`@wl/no-public-api-export-all` point here.
`@wl/layer-imports` is on in every backend through the shared preset.

## Workflow

### CREATE or MODIFY a service

1. Find the target package (`apps/<app>/api`) and read 1-2 existing domains to match local style.
2. Pick the domain: an existing folder if the business area matches, else a new kebab-case folder.
3. Put the code in an allowed file ([allowlist](#domain-allowlist)); export what callers need from `index.ts`.
4. Need another domain at runtime? Do not import it. Take it as a constructor/function argument typed with
   `import type`, and wire it in the controller (or in `src/lambda_controllers/composition/` when several
   controllers share the wiring).
5. Run the package's `eslint-check` and its unit tests (`pnpm --filter <api-package> run test`).

### REVIEW

Check, in order: no file directly in `services/`; every domain has `index.ts`; every domain-root file is on
the allowlist; nothing outside a domain imports past its `index`; every cross-domain import is `import type`;
nothing in `src/lib/` fails the [lib test](#what-may-live-in-srclib). Ask the config what is live for a file
(`pnpm exec eslint --print-config <file>`) before trusting that lint covers it.

### MIGRATE a package

Follow [Migration recipe](#migration-recipe) — four commits per app. Details, census and checks are in
[migration.md](./references/migration.md).

## `src/` Tree

```
src/
├── lambda_controllers/   # One file per Lambda/route handler; composes services (`controllers/` is accepted too)
│   └── composition/      # Shared factories that wire several domains together
├── services/
│   └── <domain>/         # kebab-case, one business area
├── lib/                  # Domain-free helpers and base classes (see the lib test)
├── config/
└── __tests__/
    └── integration/      # Tests that wire several domains together
```

The `src/` root holds only entry/glue files. No flat files in `services/`, and no `services/__tests__/`:
a test belongs to a domain or to `src/__tests__/`.

## Domain Allowlist

`services/<domain>/` may contain exactly these entries:

| Entry          | Rule                                                                               |
| -------------- | ---------------------------------------------------------------------------------- |
| `index.ts`     | **Mandatory.** The domain's public API — the only path other code imports          |
| `*.service.ts` | One or more; kebab-case stem (`order-type.service.ts`, not `orderType.service.ts`) |
| `types.ts`     | Domain types (not `orders.types.ts`)                                               |
| `constants.ts` | Domain constants                                                                   |
| `lib/`         | Private helpers; any kebab-case names, any depth                                   |
| `__tests__/`   | This domain's unit tests; name checks do not apply inside                          |

`index.ts` names what it exports — `export { OrderService } from './order.service.js'` — or publishes a
module under one name with `export * as`. A bare `export * from` is reported (`export type * from` is fine).

Anything else (`client.ts`, `x.repository.ts`, `helpers.ts`) is either a `*.service.ts`, or moves into
`lib/`. `.js`/`.mts`/`.cts` variants of the names are accepted.

## Import Rules

1. **Public API only.** Outside `<domain>`, import `services/<domain>` or `services/<domain>/index.js` — never a
   file under it, by alias or relative path, value or type.
2. **Type-only across domains.** From `services/a/**` into `services/b`, only `import type { … }`,
   `export type { … } from`, all-inline `import { type A, type B }` and `typeof import('…')` pass. Mixed
   `import { type A, B }`, side-effect `import '…'`, `import('…')`, `export * from`, `export { a } from` and
   `import x = require('…')` are runtime imports. Mark type imports explicitly: lint judges the syntax, even
   where tsc would elide an unmarked one.
3. **Tests are not exempt.** `services/a/__tests__/` follows the same rules as `services/a/`. A test that
   needs two real domains is an integration test: `src/__tests__/integration/`, importing each via `index`.
4. **Within one domain**, files import each other relatively and freely — but never through the domain's
   own `index.ts` at runtime: the index re-exports the importing file, so that closes a cycle. The domain's
   `__tests__/` may use the index.
5. **`src/lib/` does not import `services/**` at runtime** (allowlisted composition roots aside, see
   `libRuntimeAllow` below).
6. **Nothing imports `lambda_controllers/` at runtime.** `lib/`, `config/` and `services/` never reach up into a
   controller; `import type` is fine.

## Controllers

Controllers are the composition layer. They construct services, pass one domain's function or instance into
another (typed via `import type` on the receiving side), and adapt the result to the transport. A factory that
several controllers share (`new OrderService(new CouponService(), …)`) lives in
`src/lambda_controllers/composition/<name>.ts` and imports each domain through its `index`. Composition never lives
in `src/lib/` or in a domain.

## What may live in `src/lib/`

A file belongs in `src/lib/` only if **all three** hold:

1. **No runtime import from `services/**`** (lint: `libRuntimeImport`).
2. **No domain rule** — it would read the same in any domain (date formatting, a base service class, a
   comma-list parser). A freeze rule for deal edits or a booking tracking plan fails this.
3. **No I/O at module load** — no client created, file read or env lookup at import time.

Fails any test → it stays in its domain (`services/<domain>/lib/` if private) and is injected where others
need it.

## Enforcement

| Violation                                                                                     | Rule → messageId                                | Also reported by                                             |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Directory under `services/<d>/` other than `lib`, `__tests__`                                 | `@wl/package-structure`                         | —                                                            |
| File directly in `services/` (incl. `services/index.ts`)                                      | `@wl/service-files` → `flatFile`                | —                                                            |
| `services/__tests__/`                                                                         | `@wl/service-files` → `testsOutsideDomain`      | —                                                            |
| Domain-root file off the allowlist                                                            | `@wl/service-files` → `unknownFile`             | `unicorn/filename-case` when not kebab                       |
| Domain without `index.ts`                                                                     | `@wl/service-files` → `missingIndex`            | —                                                            |
| Deep import from a controller (`#root/services/x/y.service.js`, `../services/x/y.service.js`) | `@wl/service-public-api` → `deepImport`         | `no-restricted-imports` (matches the specifier text)         |
| Deep import from a sibling domain (`../orders/order.service.js`)                              | `deepImport` (+ `crossDomainRuntime` if value)  | none — `no-restricted-imports` misses relative sibling paths |
| Value import between two domain folders                                                       | `@wl/service-public-api` → `crossDomainRuntime` | `boundaries/dependencies`                                    |
| `src/lib/**` value-imports a domain                                                           | `@wl/service-public-api` → `libRuntimeImport`   | —                                                            |
| `export * from` in a domain's `index.ts`                                                      | `@wl/no-public-api-export-all`                  | —                                                            |
| Domain file value-imports its own `index.ts`                                                  | `@wl/service-public-api` → `selfImport`         | —                                                            |
| `lib/`, `config/` or `services/` value-imports `lambda_controllers/`                          | `@wl/layer-imports` → `upward`                  | —                                                            |

One fix clears every report on a line. Suppressing any of them — bulk suppression, `eslint-disable`, or an
`'off'` line — is banned for all of these rule ids.

### Enabling the rules in an app

From plugin 0.49 the shared preset turns both rules on for every backend package, so a repo can take
0.49 only when all its api packages conform. Migrate on 0.48, where each migrated app turns them on in
its `eslint.config.js` with a **scoped** user config block:

```js
export default config({
  userConfigs: [
    {
      name: '<app>/service-structure',
      files: ['src/**/*.{ts,mts,cts,js}'],
      rules: { '@wl/service-files': 'error', '@wl/service-public-api': 'error' },
    },
  ],
})
```

Never use the factory's top-level `rules` option for this: it lands unscoped, also matches the JSON/YAML files
the config lints, and crashes with "rules do not support the language". Enable only where the app already
conforms — never add an `'off'` line.

On 0.49 drop the block, unless the app's `src/lib/` holds a composition root: that app keeps a scoped block
passing `['error', { libRuntimeAllow: ['**/src/lib/container/**'] }]` to `@wl/service-public-api`.

## Migration Recipe

One app per PR, four commits. After **every** commit `pnpm run qa` and the app's api unit tests
(`pnpm --filter <api-package> run test`) pass. Write the rename map (`old<TAB>new`, paths relative to the
package) from the approved grouping first; it drives both `git mv` and the suppression re-key.

1. **Rename in place.** `git mv` each flat service to its kebab `*.service.ts` name, still inside
   `services/` — no folders yet. Update import specifiers **and `vi.mock('…')` strings** (a stale mock path
   passes ts-check and silently mocks nothing). Re-key suppressions. Run the edge census
   ([migration.md](./references/migration.md#edge-census)) and get the grouping approved.
2. **Fix edges while files are flat.** Remove every cross-domain runtime edge: inject instead of import, move
   shared factories to `src/lambda_controllers/composition/`, move what passes the lib test to `src/lib/`. Behaviour
   changes only; no moves.
3. **Pure moves + barrels.** `git mv` into `services/<domain>/` and `services/<domain>/__tests__/` per the
   map, add each `index.ts`, switch importers and `vi.mock` strings to `services/<domain>/index.js`. No logic
   changes. Re-key suppressions.
4. **Enable.** Add the [scoped block](#enabling-the-rules-in-an-app) (plugin 0.48; on 0.49 the preset
   already enables the rules); the app's `eslint-check` is green with
   zero new suppressions.

Re-key after every rename commit, dry run first:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/skills/be-architect/scripts/rekey-suppressions.mjs <package-dir> <rename-map.tsv> --dry-run
node "${CLAUDE_PLUGIN_ROOT}"/skills/be-architect/scripts/rekey-suppressions.mjs <package-dir> <rename-map.tsv>
```

It rewrites `eslint-suppressions.json` keys per the map, prunes `unicorn/filename-case` and
`wl-config/folder-case` entries on renamed paths (`--prune-rules <id,…>` to change the list), never adds an
entry, and prints per-rule before/after counts — paste them into the commit body. **Non-zero exit = STOP**: a
key matched neither the map nor an existing file, so the map is incomplete. Then
`pnpm exec eslint --prune-suppressions ./src` must change nothing. **Never** run `eslint --suppress-all`.

The script is covered by `pnpm run test:claude`, run from the infra-kit repo root. If you change it, run that
suite — nothing else will.

## Reference Index

| Reference                                 | Content                                                                                  | When to Read        | Search Hints                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| [migration.md](./references/migration.md) | Rename map format, edge census, per-commit checklist, handler/dist checks, layer renames | Migrating a package | `## Rename map`, `## Edge census`, `## Per-commit checklist`, `## Handler and dist checks`, `## Layer renames` |
