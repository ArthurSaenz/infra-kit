---
name: e2e-architect
description: Scaffold and enforce the per-feature Playwright e2e test structure used in the Hulyo monorepo (apps/*/tests/src/tests/feature-name/). This skill should be used when creating a new e2e test suite for a feature, restructuring an existing flat test file into the feature layout, or reviewing whether an e2e folder follows the conventions - a single Page Object that owns all selectors, a fixture that guarantees marker-based cleanup in teardown, and specs split by behavioral axis (smoke, create+validation, edit, lifecycle, list-filter).
---

# E2E feature structure

## Overview

Codifies the per-feature Playwright e2e convention proven in the Hulyo backoffice/client test
suites. Each feature gets a folder under `src/tests/<feature>/` containing one Page Object (the
only place selectors live), one fixture that guarantees cleanup even on mid-test failure, and a
set of specs split by behavioral axis. The canonical reference is
`apps/backoffice/tests/src/tests/self-service-import-rules/`.

## When to use

- Creating a new e2e suite for a backoffice or client feature.
- Restructuring a flat/monolithic spec file into the feature layout.
- Reviewing an e2e folder for convention compliance (selectors leaking into specs, missing
  cleanup, one giant spec file, hardcoded markers).

## Workflow

### 1. Scaffold the folder

Run the bundled script. It copies the **minimal starter** in `assets/feature-template/` into
`<dest>/<feature>/`, substituting the feature name into kebab / camelCase / PascalCase /
Title Case forms and renaming the `<feature>.*` files:

```bash
python3 scripts/scaffold_feature.py <feature-kebab> --dest <path/to/tests>/src/tests
# e.g.
python3 scripts/scaffold_feature.py coupon-batch --dest apps/backoffice/tests/src/tests
```

The starter is intentionally small — a Page Object, a cleanup fixture, a smoke spec, and a crud
spec — so it fits any feature shape without forcing deletions. The script refuses to overwrite
an existing folder.

### 2. Adapt to the real UI, then grow

The starter ships with generic locators and action methods. Edit `<feature>.page.ts` to match
the actual roles/labels, rename action methods to the feature's domain (`fillApprover`,
`selectDealType`, …), and adjust the fixture's API path / removal call (`/archive` vs delete).
For a read-only page that creates nothing, delete the fixture and import `test` from
`@playwright/test` directly.

As the suite grows, split `crud.spec.ts` into the behavioral axes —
create-and-validation / edit / lifecycle / list-filter — rather than letting one file sprawl.
`references/conventions.md` describes that target layout; the live
`apps/backoffice/tests/src/tests/self-service-import-rules/` folder is the full worked example.

### 3. Verify

Run the suite filtered to the new folder and confirm it passes and leaves no state behind:

```bash
cd <app>/tests && pnpm exec playwright test src/tests/<feature> --reporter=line
```

## The conventions (summary)

1. **One Page Object per feature** — all `readonly Locator` fields in the constructor; action
   methods grouped navigation → filters → form fillers → lifecycle. Specs never call
   `page.getByRole(...)` directly.
2. **One fixture per feature, owning cleanup** — `base.extend` hands each test a ready POM and,
   after `use()`, archives every created entity by its unique marker via the same-origin authed
   API. Best-effort: never throws. Specs import `{ test, expect }` from this fixture, not from
   `@playwright/test`.
3. **Split specs by behavioral axis** — smoke / create+validation / edit / lifecycle /
   list-filter; one `describe` + fresh-navigating `beforeEach` each.
4. **Unique markers** are both the row-lookup key and the cleanup key (`page.nextMarker()`).
   Never hardcode a colliding marker.
5. **Naming/imports** — kebab-case files; `fill`/`select`/`apply`/`add` method prefixes;
   `#root` alias for shared constants; relative paths in `playwright.config.ts` /
   `global-setup.ts`; shared harness (`constants.ts`, `global-setup.ts`, `lib/`) stays at
   `src/` root, never duplicated per feature.

For full rationale and the reference implementation, read `references/conventions.md`.

## Resources

- `scripts/scaffold_feature.py` — copies and renames the minimal starter into `<dest>/<feature>/`.
- `assets/feature-template/` — the minimal starter (Page Object, cleanup fixture, smoke spec,
  crud spec) with `__feature-kebab__` / `__featureCamel__` / `__FeaturePascal__` /
  `__Feature Title__` placeholder tokens.
- `references/conventions.md` — full rationale for the five rules, the target behavioral-axis
  layout, and the canonical worked example (self-service-import-rules).
