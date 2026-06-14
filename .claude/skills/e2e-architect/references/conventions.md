# Per-feature e2e conventions (Hulyo Playwright suites)

Detailed rationale behind the `tests/<feature>/…` structure. Load this when deciding how to
split specs, where selectors belong, or how to make a suite reliable on a shared environment.

## Folder layout

This is the **target grown state**. The scaffold starter ships only `page.ts`, `fixture.ts`,
`smoke.spec.ts`, and `crud.spec.ts`; split `crud.spec.ts` into the specs below and add
`<feature>.data.ts` as the suite matures.

```
src/tests/<feature>/
├── <feature>.page.ts        # Page Object — locators + action methods (only place selectors live)
├── <feature>.fixture.ts     # test.extend → ready POM + GUARANTEED teardown/cleanup
├── <feature>.data.ts        # OPTIONAL — builders/factories for valid+invalid payloads
├── smoke.spec.ts            # page renders, key controls present, empty-submit blocked
├── create-and-validation.spec.ts
├── edit.spec.ts
├── lifecycle.spec.ts        # state transitions (archive/restore/activate/deactivate)
└── list-filter.spec.ts      # search, filters, columns, pagination, tab switching
```

Shared harness stays at `src/` root, never duplicated per feature:
`constants.ts`, `global-setup.ts` (real-login → `storageState`), `lib/auth.ts`, `lib/browser/`.
Cross-feature Page Objects live in `src/pages/`.

## The five rules

### 1. One Page Object per feature — selectors live nowhere else
`<feature>.page.ts` exports a class with all `readonly Locator` fields assigned in the
constructor, plus action methods grouped by concern: navigation/tabs → list & filters → form
fillers → lifecycle. Specs call `featurePage.fillApprover(...)`, never `page.getByRole(...)`
directly. A UI change then touches one file, not every spec.

### 2. One fixture per feature, and it owns cleanup
`<feature>.fixture.ts` does `base.extend` to hand each test a ready POM, and **guarantees
teardown even on mid-test failure** — the single most important reliability pattern. Cleanup
runs after `use()`, against the same-origin authed API (cookie inherited from `storageState`),
keyed on a **unique per-test marker**. It must be best-effort: never throw, so a teardown
failure cannot mask the real test result. Archive is usually soft-delete (no hard delete), so
cleaned entities land in the Archive tab.

Each spec imports `{ test, expect }` from its own `<feature>.fixture.ts` — **not** from
`@playwright/test` directly. That import is what wires in the cleanup.

### 3. Split specs by behavioral axis, not one big file
smoke / create+validation / edit / lifecycle / list-filter. One `test.describe` per file with a
`beforeEach` that navigates fresh. Keeps any single file scannable (the POM absorbs the bulk)
and lets a single axis run in isolation (`-g "validation"`). One assertion-per-rule in
validation specs so a failure names exactly which rule broke.

### 4. Unique markers are both lookup key and cleanup key
A `nextMarker()` helper on the POM combines a static counter with the feature name to produce a
unique, human-readable marker. The test fills it into a field, finds the row by it, and the
fixture archives by it. Never hardcode a marker that could collide across parallel runs or
overlap windows.

### 5. Naming & import conventions
- Files kebab-case: `<feature>.page.ts`, `<feature>.fixture.ts`.
- Action methods prefixed `fill` / `select` / `apply` / `add` / `handle`; locator getters `get…`.
- Import shared constants via the `#root` alias; keep `playwright.config.ts` and
  `global-setup.ts` on **relative** paths — they run before alias resolution.
- Auth is shared across the whole project via `global-setup.ts` → `storageState`, not per-test login.

## When to add `<feature>.data.ts`
Only when the feature has many valid/invalid input permutations (e.g. profit tiers, deal types,
scan modes). A `buildValid<Feature>(overrides)` factory removes repetition across validation
specs. For a simple CRUD feature, inline the data and delete the file.

## Reference implementation
`apps/backoffice/tests/src/tests/self-service-import-rules/` is the canonical example: an
865-line POM, a fixture with API-based marker cleanup, and five specs split by axis (~39 tests).
