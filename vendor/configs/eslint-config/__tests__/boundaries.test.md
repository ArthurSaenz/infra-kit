# Understanding `boundaries.test.ts`

## What this test file is actually checking

`boundaries.test.ts` verifies an **ESLint architectural rule** (`boundaries/dependencies`).
It doesn't test app code — it lints a tiny fake project and checks that the rule _flags_ the
bad imports and _allows_ the good ones.

## How the fake project is built (inline, in a temp dir)

There is **no committed fixture tree** any more. `boundaries/dependencies` resolves each import's
target on disk to classify it, so the targets must be real files — but the _importer_ under test is
written inline so the code lives next to its expectation:

- `_boundaries-tree.ts` materializes a fixed **scaffold** (the import _targets_: the
  `alpha`/`email`/`shared` barrels + internals) into a fresh `mkdtemp` directory in `beforeAll`,
  and removes it in `afterAll`.
- Each test calls `lintAt(relPath, code)`: it writes the inline importer `code` to `relPath` inside
  that temp tree, lints the real path against the exported `config()`, and keeps only `boundaries/*`
  messages. The importer's location (`relPath`) is what classifies it as a feature/service/shared.

This mirrors the other suites' declarative inline style (`_lint-case.ts`), while keeping the on-disk
resolution the rule genuinely needs.

The "project" has three kinds of folders:

- `features/alpha`, `features/beta` — sibling **features**
- `services/email`, `services/sms` — sibling **services**
- `shared/` — a common layer everyone is allowed to use

The policy being enforced (stated in the comment at the top of the test file):

> Sibling → sibling imports (feature↔feature, service↔service) must be **type-only**.
> The `shared` layer is the one runtime exception, and only **through its barrel**.

## The vocabulary in the test titles

Every title is `flags …` (= must be rejected) or `allows …` (= must be permitted).
The other words are jargon:

| Word in title                   | What it means                                                        | Concrete example                                       |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| **runtime** import              | A _value_ import — pulls real code that exists when the program runs | `import { thing } from '../alpha'`                     |
| **type-only** import            | `import type …` — erased by the compiler, no runtime dependency      | `import type { Thing } from '../alpha/internal/thing'` |
| **cross-feature**               | beta importing from alpha (sibling → sibling)                        | `features/beta` → `features/alpha`                     |
| **cross-service**               | sms importing from email                                             | `services/sms` → `services/email`                      |
| **barrel**                      | the folder's `index.ts` (its public entry point)                     | `from '../alpha'` resolves to `alpha/index.ts`         |
| **internals** / **deep import** | reaching _past_ the barrel into a private file                       | `from '../alpha/internal/thing'`                       |
| **shared layer**                | the `shared/` folder                                                 | `from '../../shared'`                                  |

## Reading three titles end-to-end

- **"flags a runtime cross-feature import through the barrel"** → an importer at
  `src/features/beta/x.ts` does `import { thing } from '../alpha'`. A real (runtime) value import
  from a sibling feature, even via the barrel → **must be rejected**. `expectFlagged` asserts the
  rule fired (it also doubles as the resolver positive control: a misbuilt scaffold would classify
  `../alpha` as `unknown` and go clean, failing here loudly).

- **"allows a type-only cross-feature import"** → `import type { Thing } from '../alpha/internal/thing'`.
  Sibling, but type-only → erased at runtime → **allowed**. `expectClean` asserts no warning.

- **"flags a runtime deep import into shared (barrel only)"** →
  `import { sharedUtil } from '../../shared/util'`. Shared is allowed, but only through
  `shared/index.ts`; reaching into `shared/util` directly → **rejected**.

So a title reads as:
**[flags/allows] a [runtime/type-only] [cross-feature/cross-service/shared] import [via barrel / into internals]**
— and each one maps 1:1 to an inline importer whose import line is the thing under test.
