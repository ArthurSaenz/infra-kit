# @wl/eslint-config

Shared flat ESLint config (wraps `@antfu/eslint-config` + `eslint-plugin-sonarjs`).

## Usage

```js
// eslint.config.js
import config from '@wl/eslint-config'

export default config() // or config({ mode: 'svelte' })
```

The package is authored in TypeScript under `src/` and built to `dist/` with `tsc` (`pnpm --filter @wl/eslint-config build`). `config` is the default export of `src/factory.ts` (`createConfig`); the named export and the `ConfigOptions` type are also exported.

## Options

All options are optional. The defaults reproduce the historical config, except for `fileNaming`, which is
on by default and flags every non-kebab-case source file and folder.

| Option             | Type                            | Default   | Effect                                                                                                     |
| ------------------ | ------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `mode`             | `'react' \| 'svelte' \| string` | `'react'` | Framework preset. Unknown values fall back to `react` with a dev-time `console.warn`.                      |
| `ignores`          | `string[]`                      | `[]`      | Extra ignore globs appended to the built-in ignores.                                                       |
| `boundaries`       | `boolean \| 'warn' \| 'error'`  | `'error'` | Phase-2 relationship-aware import boundaries. `false` drops the layer; `'warn'` downgrades.                |
| `jsdoc`            | `boolean`                       | `true`    | JSDoc hygiene layer (see below).                                                                           |
| `markdown`         | `boolean`                       | `true`    | Markdown sonarjs-off layer.                                                                                |
| `components`       | `boolean`                       | `true`    | White-label component conventions (`@wl`).                                                                 |
| `shadcn`           | `boolean`                       | `true`    | Tailwind design-system rules from [`@shadcn/lint`](https://github.com/shadcn-ui/lint).                     |
| `fileNaming`       | `boolean`                       | `true`    | Kebab-case file and folder names (see [File naming](#file-naming)).                                        |
| `architecture`     | `boolean`                       | `true`    | React-only layer: rules of hooks, platform access, dumb-component imports (`src/configs/architecture.ts`). |
| `restrictedSyntax` | `RestrictedSyntax[]`            | `[]`      | Extra `no-restricted-syntax` entries for frontend code, appended to the shared ones.                       |
| `rules`            | `ConfigRules`                   | `{}`      | Consumer rule overrides, merged **last** (highest precedence). Omitted from the call when empty.           |
| `userConfigs`      | `FlatConfig[]`                  | `[]`      | Arbitrary consumer flat-configs appended **last**.                                                         |

```js
// Opt a package out of a layer, downgrade boundaries to warn, and add a local rule:
export default config({
  boundaries: 'warn',
  jsdoc: false,
  rules: { 'no-console': 'error' },
})
```

> Note: the `boundaries` toggle gates **Phase 2** (relationship-aware) only. **Phase 1** — the
> string-based public-API barrel guard (`no-restricted-imports`, see below) — is always on.

## Extend in a consumer

Prefer the options object over forking. Append your own flat-configs with `userConfigs` (they win,
being last), and override individual rules with `rules`:

```js
import config from '@wl/eslint-config'

export default config({
  ignores: ['src/generated/**'],
  rules: { 'ts/no-explicit-any': 'off' },
  userConfigs: [{ files: ['scripts/**'], rules: { 'no-console': 'off' } }],
})
```

## Add a framework preset

The package structure makes a new framework a **one-file + one-line** change:

1. Add `src/configs/frameworks/<name>.ts` exporting the framework's flat-config block(s).
2. Add one entry to the registry in `src/configs/frameworks/index.ts`:

```ts
export const frameworks: Record<string, FrameworkPreset> = {
  react: { antfuFlags: { react: true }, extraConfigs: [], architecture: true },
  svelte: { antfuFlags: { svelte: true }, extraConfigs: [svelteConfig] },
  vue: { antfuFlags: { vue: true }, extraConfigs: [vueConfig] }, // <-- new
}
```

The factory looks the preset up by `mode`, merges `antfuFlags` onto the base antfu options, and
splices `extraConfigs` in at the framework position. `architecture: true` opts the preset into the
React-only architecture layer. Unknown modes fall back to `react`.

## Package structure

```
src/
  index.ts          # default + named export (createConfig), ConfigOptions type
  factory.ts        # the single antfu(...) assembly + group gating
  options.ts        # resolveOptions — the defaults invariant
  types.ts          # ConfigOptions / ResolvedOptions
  globs.ts          # shared glob constants
  configs/
    base.ts         # antfu base options + sonarjs + the project rule overrides (incl. Phase-1)
    architecture.ts # React-only: rules of hooks, platform access, dumb-component imports
    boundaries.ts   # Phase-2 relationship-aware boundaries (severity-parameterized)
    e2e-boundaries.ts # import direction inside Playwright packages (same toggle)
    e2e-playwright.ts # eslint-plugin-playwright trust rules, Playwright packages only
    components.ts   # @wl component conventions
    shadcn.ts       # @shadcn/lint Tailwind design-system rules
    file-naming.ts  # kebab-case file and folder names
    docs.ts         # JSDoc + markdown layers
    ignores.ts      # built-in + user ignores
    temp-disabled.ts # central mute list, appended after every rule layer
    frameworks/     # framework registry (index.ts) + per-framework blocks (svelte.ts)
```

## File naming

Source files (`js`/`ts` family and `.svelte`) and every folder above them, up to the directory ESLint
runs in, must be kebab-case: `user-card.tsx`, `data-source/`. Only the part before the first dot is a
name; `user-card.test.ts` and `home.page.ts` pass. Files go through `unicorn/filename-case`; folders go
through `wl-config/folder-case`, a small rule in `src/configs/file-naming.ts`.

Exempt, because a tool or framework fixes the name:

- `index.*`, a leading `_` (`__root.tsx`, `_layout.tsx`) or `$` (`$.tsx`, `$postId.tsx`)
- TanStack Router: `-` prefixed files and folders, `posts_.$id.tsx`, `(group)/`, `_pathless/`; Vike:
  `+Page.tsx`, `+config.ts`; bracket params such as `[id]/`
- dotfolders (`.storybook/`), tooling folders (`__tests__/`, `__mocks__/`, `__fixtures__/`, …) and
  scoped-package mocks (`__mocks__/@aws-sdk/`)
- files the layer never reads: Markdown (`README.md`, `CLAUDE.md`) and the built-in ignores
  (`routeTree.gen.ts`)

A package with names still to rename turns the layer off until it is done:

```js
export default config({ fileNaming: false })
```

To keep the folder rule while files are renamed, override one rule instead:
`rules: { 'unicorn/filename-case': 'off' }`.

## Architecture import rules (public-API boundaries)

Features and services must be consumed through their **public API barrel** (`index.ts`).
Reaching into their internals is an error:

- ✅ `import { Thing } from '#root/features/billing'` — barrel (public API)
- ❌ `import { helper } from '#root/features/billing/lib/helper'` — deep import, blocked
- ❌ `import { client } from '#root/services/email/client'` — deep import, blocked
- ✅ `import { Email } from '#root/services/email'` — barrel (public API)
- ✅ `import { local } from './local'` — relative intra-element import
- ❌ `import { toRouterTarget } from '#root/lib/navigation/results-url'` — deep lib import, blocked
- ✅ `import { toRouterTarget } from '#root/lib/navigation'` — lib module barrel

The React architecture rules (hooks, platform access, dumb-component imports), the component rules and
the JSDoc layer share one exemption list (`GLOB_TS_DOC_EXCLUDE`): tests, stories, `__stories__/` helpers
and declaration files are not checked by any of them.

`src/lib/<module>` follows the same rule via `#root/lib/*/**`. The glob is anchored on `#root/`, so
package subpaths like `highlight.js/lib/languages/xml` stay allowed. Inside a lib module, import
siblings relatively (`./types`), never through `#root/lib/<same-module>/…`.

This is enforced by `no-restricted-imports` with the globs `**/features/*/**` and
`**/services/*/**`. The pattern is anchored on the `features/`/`services/` segment, so it
matches every prefix (`#root/`, `@/`, `src/`, relative `../`) and every internal depth, while
the trailing `/**` requires at least one segment inside the element so the barrel stays allowed.

`no-restricted-imports` matches the **import specifier string only** — it bans deep/non-barrel
imports but is blind to the _importing file's_ location, so it cannot reason about _which_
element an import comes from. Relationship-aware enforcement is the next layer.

## Relationship-aware boundaries (`eslint-plugin-boundaries`)

Where the string rule above bans deep imports by path shape, this layer resolves each import
to a file, classifies both ends as an architectural **element** — `feature` (`**/features/*`),
`service` (`**/services/*` or feature-nested `**/features/*/services/*`), or `shared`
(`**/shared`) — and enforces the relationships between them:

- **Sibling cross-imports are type-only** — a `feature`/`service` may reference another
  `feature`/`service` only via `import type` (no runtime coupling). Value/runtime cross-imports
  between siblings are flagged, **including through the barrel**. Imports _within_ the same
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
`src/configs/boundaries.ts`; the shared runtime exception is the
`to: { type: 'shared', internalPath: 'index.*' }` allow rule. Adjust those rules to change the policy.

These rules run at **`error`** by default (pass `config({ boundaries: 'warn' })` to downgrade them, or
`config({ boundaries: false })` to drop the layer). They are **dormant** on any package without a
`features/`/`services/` tree — its files are classified `unknown` and never flagged — so the current
flat-layout consumers are unaffected. As real feature/service trees land, the rules begin enforcing
automatically.

**Alias resolution:** boundaries must resolve an import to classify its target; an unresolved
target is `unknown` and silently not enforced. `#root/*` (⇒ `<package>/src/*`) is resolved by the
bundled `resolvers/root-alias.cjs`, including NodeNext-style `#root/x.js` ⇒ `x.ts`. The same
resolver maps a relative NodeNext specifier (`./x.js`, `../y/index.mjs`) to its TS source, so those
imports are checked exactly like extensionless ones. Everything else goes to the node resolver
(extended with TS extensions).

## E2E import direction (Playwright packages)

A package whose `package.json` declares `@playwright/test` (the same signal `@wl/package-structure`
uses) gets its own element set in place of `feature`/`service`/`shared`, so `pages`, `lib` and
`config` there never collide with the app-code meaning of those folder names. A `package.json` that is
not valid JSON stops the lint run with an error naming it, instead of being guessed as either kind.

```
tests/<domain> | visual/<domain> | setup → fixtures → pages → components → mocks → lib → config
```

- A shared layer imports its own layer or any layer below it.
- A domain folder under `src/tests` / `src/visual` is private: it imports every shared layer and
  its own files, never a sibling domain. Anything two domains share moves down into a shared layer.
- `boundaries/no-unknown-files` flags a file outside every layer and domain, including a loose
  `src/*.ts` — env and constants live in `src/config/`.

```ts
// src/lib/wait.ts
import { HomePage } from '#root/pages/home.page'            // ❌ lib → pages (upward)
// src/tests/checkout/pay.spec.ts
import { test } from './fixtures/checkout.fixture'           // ✅ own domain
import { HomePage } from '#root/pages/home.page'             // ✅ domain → shared layer
import { cart } from '../cart/fixtures/cart.fixture'         // ❌ sibling domain
```

It covers every JS/TS source in the package — `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`,
`.cjs` — and follows the `boundaries` toggle and severity. Source: `src/configs/e2e-boundaries.ts`.

## E2E trust rules (Playwright packages)

Same package scope as above, always on (override per rule through `rules`): `eslint-plugin-playwright`
at `error` for `missing-playwright-await`, `no-focused-test`, `no-wait-for-timeout`, `no-force-option`,
`no-conditional-expect`, `no-networkidle` and `expect-expect`. `expect-expect` also accepts calls named
`expect*` / `assert*` / `verify*` (bare or as a method), so page-object assertion helpers count.
Source: `src/configs/e2e-playwright.ts`.

## JSDoc layer

Scope: `**/*.{ts,tsx}` minus tests, stories (including `__stories__/` helpers) and declarations. Enforced (`src/configs/docs.ts`, where
each rule's reason lives): `tag-lines`, `no-blank-blocks`, `no-multi-asterisks`, `no-types`,
`check-line-alignment` and `check-param-names` at `error`, `informative-docs` at `warn`, plus
`@wl/max-jsdoc-lines` at `error` (wired in `src/configs/components.ts`, where the `@wl` plugin loads).

Requiring a doc block is **not** enforced today: `jsdoc/require-jsdoc` / `require-description` /
`require-example` are off because `@wl/require-jsdoc-example` covers the same ground, and that rule is
muted in `src/configs/temp-disabled.ts` until adoption completes.

## Component conventions (`@wl/eslint-plugin`)

On JSX/TSX files the config enables two white-label component rules (consumed from the plugin's
`configs.recommended` preset, the single source of truth for their scope and rationale):

- **`@wl/component-file-order`** — enforces top-level order: imports → `*Props` interface/type →
  component declaration. Report-only; activates only on files that contain a React component.
- **`@wl/props-destructuring-newline`** (error, auto-fixable) — a component must accept a single
  `props` parameter and destructure it on its own line in the body, never inline in the parameter
  list. A function counts as a component when its name is PascalCase or it returns JSX.

```tsx
// ❌ inline destructuring in the parameter list
const UserCard = ({ user, className }: UserCardProps) => {
  return <div className={className}>{user.name}</div>
}

// ✅ destructure props on its own line in the body
const UserCard = (props: UserCardProps) => {
  const { user, className } = props

  return <div className={className}>{user.name}</div>
}
```

## Tests

```bash
pnpm --filter @wl/eslint-config test
```

Tests run the **real exported config** (`config()`) programmatically via ESLint. Fixtures are
constructed by the suite, not committed as on-disk trees:

- `_lint-case.ts` — a declarative harness that lints inline `code` strings under a virtual
  `fileName`, so the wired file-glob behavior is exercised. Drives the string-rule suites:
  `no-restricted-imports.test.ts` (Phase 1: deep imports flagged, barrels/relative pass),
  `component-file-order-stories.test.ts`, `props-destructuring.test.ts`.
- `_boundaries-tree.ts` — Phase 2 (`boundaries/dependencies`) resolves each import on disk, so it
  materializes a scaffold tree into a temp dir (`mkdtempSync`, cleaned up after the suite) and
  writes the importer file inline per case. Drives `boundaries.test.ts` (cross-element internals
  flagged; barrels, same-element, and type-only imports pass) for features and services.
- `options-*.test.ts` — the factory's option resolution: defaults, toggles, and passthrough.
