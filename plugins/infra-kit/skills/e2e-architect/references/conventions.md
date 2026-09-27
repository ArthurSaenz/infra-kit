# Per-domain e2e conventions (Playwright suites)

Detailed rationale behind the `tests/<domain>/…` structure. Load this when deciding how to
split specs, where selectors belong, or how to make a suite reliable on a shared environment.

## Folder layout

This is the **target grown state**. The scaffold starter ships only the Page Object, the fixture,
`page-loads.spec.ts`, and `create-and-validation.spec.ts`; add `edit` / `lifecycle` /
`list-filter` specs and `data/<domain>.data.ts` as the suite matures.

A domain folder's **root holds only specs**. Every other file always sits in a subfolder, even
when it is the only one of its kind — the `@wl/e2e-file-layout` lint rule reports anything else:

```
src/tests/<domain>/
├── page-loads.spec.ts               # @smoke @readonly: page renders, key controls present
├── create-and-validation.spec.ts
├── edit.spec.ts
├── lifecycle.spec.ts                # state transitions (archive/restore/activate/deactivate)
├── list-filter.spec.ts              # search, filters, columns, pagination, tab switching
├── <flow>.api.spec.ts               # only when an `api` Playwright project runs it
├── pages/
│   ├── <domain>.page.ts             # Page Object — locators + action methods (only place selectors live)
│   └── <part>.component.ts          # component objects for reusable widgets
├── fixtures/
│   └── <domain>.fixture.ts          # test.extend → ready POM + GUARANTEED teardown/cleanup
├── mocks/
│   └── <domain>.mock.ts             # route mocks for `@mocked` specs
├── data/
│   └── <domain>.data.ts             # OPTIONAL — builders/factories for valid+invalid payloads
└── lib/                             # helpers private to this domain
```

Specs are never nested below the domain folder: when one domain holds too many specs to scan,
split it into two sibling domains (`luggage/`, `luggage-pricing/`).

Shared harness stays at `src/` root, never duplicated per feature: `constants.ts`,
`setup/auth.setup.ts` (real login → `storageState` in the gitignored `.auth/`, run as a Playwright
setup project that the browser projects depend on), `lib/`, and cross-feature Page Objects in
`src/pages/`.

## Tags

Run categories are tags on the `describe` or `test` details object, never file names. Only four
exist — `@smoke`, `@readonly`, `@mocked`, `@slow` — and `@wl/e2e-test-tags` rejects any other.
Browsers, devices and environments are Playwright projects, not tags.

## The five rules

### 1. One Page Object per feature — selectors live nowhere else

`<domain>.page.ts` exports a class with all `readonly Locator` fields assigned in the
constructor, plus action methods grouped by concern: navigation/tabs → list & filters → form
fillers → lifecycle. Specs call `featurePage.fillApprover(...)`, never `page.getByRole(...)`
directly. A UI change then touches one file, not every spec.

### 2. One fixture per feature, and it owns cleanup

`<domain>.fixture.ts` does `base.extend` to hand each test a ready POM, and **guarantees
teardown even on mid-test failure** — the single most important reliability pattern. Cleanup
runs after `use()`, against the same-origin authed API (cookie inherited from `storageState`),
keyed on a **unique per-test marker**. It must be best-effort: never throw, so a teardown
failure cannot mask the real test result. Archive is usually soft-delete (no hard delete), so
cleaned entities land in the Archive tab.

Each spec imports `{ test, expect }` from its own `<domain>.fixture.ts` — **not** from
`@playwright/test` directly. That import is what wires in the cleanup.

### 3. Split specs by behavioral axis, not one big file

page-loads / create-and-validation / edit / lifecycle / list-filter. One `test.describe` per file with a
`beforeEach` that navigates fresh. Keeps any single file scannable (the POM absorbs the bulk)
and lets a single axis run in isolation (`-g "validation"`). One assertion-per-rule in
validation specs so a failure names exactly which rule broke.

### 4. Unique markers are both lookup key and cleanup key

A `nextMarker()` helper on the POM combines a static counter with the feature name to produce a
unique, human-readable marker. The test fills it into a field, finds the row by it, and the
fixture archives by it. Never hardcode a marker that could collide across parallel runs or
overlap windows.

### 5. Naming & import conventions

- Files kebab-case: `pages/<domain>.page.ts`, `fixtures/<domain>.fixture.ts`; specs are
  `*.spec.ts`, never `.test.ts`.
- `describe` is the domain in Title Case; `test` is a lowercase behaviour phrase with its outcome,
  no leading `should` (`@wl/e2e-test-title` reports it).
- Action methods prefixed `fill` / `select` / `apply` / `add` / `handle`; locator getters `get…`.
- Import shared constants via the `#root` alias; keep `playwright.config.ts` on **relative**
  paths — it runs before alias resolution.
- Auth is shared across the whole project via the `setup` project → `storageState`, not per-test
  login and not `globalSetup`.

## When to add `data/<domain>.data.ts`

Only when the feature has many valid/invalid input permutations (e.g. profit tiers, deal types,
scan modes). A `buildValid<Feature>(overrides)` factory removes repetition across validation
specs. For a simple CRUD feature, inline the data and delete the file.

## Reference implementation

`apps/backoffice/tests/src/tests/self-service-import-rules/` is the canonical example: an
865-line POM, a fixture with API-based marker cleanup, and five specs split by axis (~39 tests).
