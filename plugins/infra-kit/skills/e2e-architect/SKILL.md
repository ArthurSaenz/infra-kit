---
name: e2e-architect
description: Scaffold, restructure, and review per-domain Playwright e2e suites (Page Object, fixture, split specs)
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(python3 "${CLAUDE_PLUGIN_ROOT}"/skills/e2e-architect/scripts/scaffold_feature.py *)
---

# E2E feature structure

## Overview

Codifies the per-domain Playwright e2e convention proven in this monorepo family's
backoffice/client test suites. Each business domain gets a folder under `src/tests/<domain>/` whose root
holds only `*.spec.ts` files split by behavioral axis; its Page Object (the only place selectors
live) sits in `pages/`, and its fixture, which guarantees cleanup even on mid-test failure, in
`fixtures/`. The canonical reference is
`apps/backoffice/tests/src/tests/self-service-import-rules/`.

## When to use

- Creating a new e2e suite for a backoffice or client feature.
- Restructuring a flat/monolithic spec file into the feature layout.
- Reviewing an e2e folder for convention compliance (selectors leaking into specs, missing
  cleanup, one giant spec file, hardcoded markers).

## Workflow

### 1. Scaffold the folder

Run the bundled script. It copies the **minimal starter** in `assets/feature-template/` into
`<dest>/<domain>/`, substituting the feature name into kebab / camelCase / PascalCase /
Title Case forms and renaming the `<domain>.*` files:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}"/skills/e2e-architect/scripts/scaffold_feature.py <feature-kebab> --dest <path/to/tests>/src/tests
# e.g.
python3 "${CLAUDE_PLUGIN_ROOT}"/skills/e2e-architect/scripts/scaffold_feature.py coupon-batch --dest apps/backoffice/tests/src/tests
```

The starter is intentionally small — `pages/<domain>.page.ts`, `fixtures/<domain>.fixture.ts`,
a `page-loads.spec.ts` tagged `@smoke @readonly`, and a `create-and-validation.spec.ts` —
so it fits any feature shape without forcing deletions. The script refuses to overwrite
an existing folder.

### 2. Adapt to the real UI, then grow

The starter ships with generic locators and action methods. Edit `pages/<domain>.page.ts` to match
the actual roles/labels, rename action methods to the feature's domain (`fillApprover`,
`selectDealType`, …), and adjust the fixture's API path / removal call (`/archive` vs delete).
For a read-only page that creates nothing, delete the fixture and import `test` from
`@playwright/test` directly.

As the suite grows, add the remaining behavioral axes — edit / lifecycle / list-filter — as
sibling specs rather than letting one file sprawl. Mocks, data builders and domain helpers go in
`mocks/`, `data/` and `lib/`; nothing but specs sits in the domain root.
`references/conventions.md` describes that target layout; the live
`apps/backoffice/tests/src/tests/self-service-import-rules/` folder is the full worked example.

### 3. Verify

Run the suite filtered to the new folder and confirm it passes and leaves no state behind:

```bash
cd <app>/tests && pnpm exec playwright test src/tests/<domain> --reporter=line
```

## The conventions (summary)

1. **One Page Object per feature** — all `readonly Locator` fields in the constructor; action
   methods grouped navigation → filters → form fillers → lifecycle. Specs never call
   `page.getByRole(...)` directly.
2. **One fixture per feature, owning cleanup** — `base.extend` hands each test a ready POM and,
   after `use()`, archives every created entity by its unique marker via the same-origin authed
   API. Best-effort: never throws. Specs import `{ test, expect }` from this fixture, not from
   `@playwright/test`.
3. **Split specs by behavioral axis** — page-loads / create-and-validation / edit / lifecycle /
   list-filter; one `describe` + fresh-navigating `beforeEach` each. Run categories are the tags
   `@smoke` / `@readonly` / `@mocked` / `@slow`, never file names.
4. **Unique markers** are both the row-lookup key and the cleanup key (`page.nextMarker()`).
   Never hardcode a colliding marker.
5. **Naming/imports** — kebab-case `*.spec.ts` (never `.test.ts`); support files in the domain's
   `pages/` / `fixtures/` / `mocks/` / `data/` / `lib/`; `fill`/`select`/`apply`/`add` method
   prefixes; `#root` alias for shared constants; relative paths in `playwright.config.ts`; shared
   harness (`constants.ts`, `setup/auth.setup.ts`, `lib/`) stays at `src/` root, never
   duplicated per feature. `@wl/e2e-file-layout`, `@wl/e2e-file-order`,
   `@wl/e2e-page-object-member-order`, `@wl/e2e-top-level-describe`, `@wl/e2e-describe-order`,
   `@wl/e2e-test-tags` and `@wl/e2e-test-title` lint the layout; the in-file order (imports, then
   the class / `extend` / `test.*` calls / mock function / `lib/` exports, constants below); class
   members (fields → constructor → getters → public → private methods); one top-level describe with
   setup → hooks → tests inside it; tags and titles.

For full rationale and the reference implementation, read `references/conventions.md`.

## Resources

- `scripts/scaffold_feature.py` — copies and renames the minimal starter into `<dest>/<domain>/`.
- `assets/feature-template/` — the minimal starter (Page Object, cleanup fixture, page-loads
  spec, create-and-validation spec) with `__feature-kebab__` / `__featureCamel__` / `__FeaturePascal__` /
  `__Feature Title__` placeholder tokens.
- `references/conventions.md` — full rationale for the five rules, the target behavioral-axis
  layout, and the canonical worked example (self-service-import-rules).
