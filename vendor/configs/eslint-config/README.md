# @wl/eslint-config

Shared flat ESLint config (wraps `@antfu/eslint-config` + `eslint-plugin-sonarjs`).

## Usage

```js
// eslint.config.js
import config from '@wl/eslint-config'

export default config() // or config({ mode: 'svelte' })
```

## Architecture import rules (public-API boundaries)

Features and services must be consumed through their **public API barrel** (`index.ts`).
Reaching into their internals is an error:

```ts
import { Thing } from '#root/features/billing'              // ✅ barrel (public API)
import { helper } from '#root/features/billing/lib/helper'  // ❌ deep import — blocked
import { client } from '#root/services/email/client'        // ❌ deep import — blocked
import { Email } from '#root/services/email'                 // ✅ barrel (public API)
import { local } from './local'                              // ✅ relative intra-element import
```

This is enforced by `no-restricted-imports` with the globs `**/features/*/**` and
`**/services/*/**`. The pattern is anchored on the `features/`/`services/` segment, so it
matches every prefix (`#root/`, `@/`, `src/`, relative `../`) and every internal depth, while
the trailing `/**` requires at least one segment inside the element so the barrel stays allowed.

`no-restricted-imports` matches the **import specifier string only** — it bans deep/non-barrel
imports but is blind to the *importing file's* location, so it cannot reason about *which*
element an import comes from. Relationship-aware enforcement is the next layer.

## Relationship-aware boundaries (`eslint-plugin-boundaries`)

Where the string rule above bans deep imports by path shape, this layer resolves each import
to a file, classifies both ends as an architectural **element** — `feature` (`**/features/*`),
`service` (`**/services/*` or feature-nested `**/features/*/services/*`), or `shared`
(`**/shared`) — and enforces the relationships between them:

- **Sibling cross-imports are type-only** — a `feature`/`service` may reference another
  `feature`/`service` only via `import type` (no runtime coupling). Value/runtime cross-imports
  between siblings are flagged, **including through the barrel**. Imports *within* the same
  element are exempt (`checkInternals` is off), so local relative imports are fine.
- **Shared is the runtime exception** — `feature`/`service` may import the `shared` layer at
  value/runtime, through its `index.*` barrel only (deep value imports into shared are flagged).
- **Shared may not depend outward** — `shared → feature|service` is disallowed for both value
  and type; `shared` is the bottom layer.

```ts
import { Thing } from '../alpha'                     // ❌ runtime cross-feature (even barrel)
import type { Thing } from '../alpha/internal/thing' // ✅ type-only cross-feature
import { util } from './local/util'                  // ✅ same feature
import { cfg } from '../../shared'                    // ✅ feature → shared barrel (runtime)
import { cfg } from '../../shared/internal/cfg'       // ❌ deep into shared (barrel only)
```

The type-only escape hatch is granted by the `dependency: { kind: 'type' }` allow rules in
`index.js`; the shared runtime exception is the `to: { type: 'shared', internalPath: 'index.*' }`
allow rule. Adjust those rules to change the policy.

These rules run at **`warn`** (promote to `error` in `index.js` after a clean baseline). They
are **dormant** on any package without a `features/`/`services/` tree — its files are classified
`unknown` and never flagged — so the current flat-layout consumers are unaffected. As real
feature/service trees land, the rules begin enforcing automatically.

**Alias resolution:** boundaries must resolve an import to classify its target. The config
resolves relative TS imports via the bundled node resolver (extended with TS extensions). A
consumer that imports via a path alias (e.g. `#root` ⇒ `src`) must add a matching resolver
(e.g. `eslint-import-resolver-typescript` in its `settings['import/resolver']`); otherwise
aliased targets resolve as `unknown` and are silently not enforced.

## Tests

```bash
pnpm --filter @wl/eslint-config test
```

Tests run the exported config programmatically (the `ESLint` class) against fixtures:
- `__tests__/fixtures/src` — Phase 1 string rule (deep imports flagged, barrels/relative pass).
- `__tests__/fixtures-p2/src` — Phase 2 boundaries (cross-element internals flagged; barrels,
  same-element, and type-only imports pass) for both features and services.
