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

All options are optional; the defaults reproduce the historical config **byte-for-byte**, so existing
consumers calling `config()` / `config({ ignores })` are unaffected.

| Option        | Type                            | Default   | Effect                                                                                              |
| ------------- | ------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `mode`        | `'react' \| 'svelte' \| string` | `'react'` | Framework preset. Unknown values fall back to `react` with a dev-time `console.warn`.               |
| `ignores`     | `string[]`                      | `[]`      | Extra ignore globs appended to the built-in ignores.                                                |
| `boundaries`  | `boolean \| 'warn' \| 'error'`  | `'warn'`  | Phase-2 relationship-aware import boundaries. `false` drops the layer; `'error'` enforces strictly. |
| `jsdoc`       | `boolean`                       | `true`    | Size-gated JSDoc layer (PascalCase components exempt from `@example`/description — see below).      |
| `markdown`    | `boolean`                       | `true`    | Markdown sonarjs-off layer.                                                                         |
| `components`  | `boolean`                       | `true`    | White-label component conventions (`@wl`).                                                          |
| `rules`       | `ConfigRules`                   | `{}`      | Consumer rule overrides, merged **last** (highest precedence). Omitted from the call when empty.    |
| `userConfigs` | `FlatConfig[]`                  | `[]`      | Arbitrary consumer flat-configs appended **last**.                                                  |

```js
// Opt a package out of a layer, bump boundaries to error, and add a local rule:
export default config({
  boundaries: 'error',
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
  react: { antfuFlags: { react: true }, extraConfigs: [] },
  svelte: { antfuFlags: { svelte: true }, extraConfigs: [svelteConfig] },
  vue: { antfuFlags: { vue: true }, extraConfigs: [vueConfig] }, // <-- new
}
```

The factory looks the preset up by `mode`, merges `antfuFlags` onto the base antfu options, and
splices `extraConfigs` in at the framework position. Unknown modes fall back to `react`.

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
    boundaries.ts   # Phase-2 relationship-aware boundaries (severity-parameterized)
    components.ts   # @wl component conventions
    docs.ts         # JSDoc + markdown layers
    ignores.ts      # built-in + user ignores
    frameworks/     # framework registry (index.ts) + per-framework blocks (svelte.ts)
```

## Architecture import rules (public-API boundaries)

Features and services must be consumed through their **public API barrel** (`index.ts`).
Reaching into their internals is an error:

- ✅ `import { Thing } from '#root/features/billing'` — barrel (public API)
- ❌ `import { helper } from '#root/features/billing/lib/helper'` — deep import, blocked
- ❌ `import { client } from '#root/services/email/client'` — deep import, blocked
- ✅ `import { Email } from '#root/services/email'` — barrel (public API)
- ✅ `import { local } from './local'` — relative intra-element import

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

These rules run at **`warn`** by default (pass `config({ boundaries: 'error' })` to promote them, or
`config({ boundaries: false })` to drop the layer). They are **dormant** on any package without a
`features/`/`services/` tree — its files are classified `unknown` and never flagged — so the current
flat-layout consumers are unaffected. As real feature/service trees land, the rules begin enforcing
automatically.

**Alias resolution:** boundaries must resolve an import to classify its target. The config
resolves relative TS imports via the bundled node resolver (extended with TS extensions). A
consumer that imports via a path alias (e.g. `#root` ⇒ `src`) must add a matching resolver
(e.g. `eslint-import-resolver-typescript` in its `settings['import/resolver']`); otherwise
aliased targets resolve as `unknown` and are silently not enforced.

## JSDoc layer (size-gated)

Any **non-component** function longer than 15 lines must carry a JSDoc block (`jsdoc/require-jsdoc`)
that also has a body-style description (`jsdoc/require-description`) and at least one `@example`
(`jsdoc/require-example`).

**React components are fully exempt from all three rules** — a component's contract is its props +
JSX, not prose, a runnable example, or even a doc block. A component is identified by a **PascalCase
name** (the React convention), implemented via esquery `contexts` shared by all three rules in
`src/configs/docs.ts`. A component never owes a JSDoc block, regardless of length.

```tsx
// ✅ component: no JSDoc required, even over 15 lines
export const UserCard = (props: UserCardProps) => <article>{props.name}</article>

// ❌ non-component > 15 lines: needs a JSDoc block WITH a body description and an @example
export const formatAddress = (parts: string[]) => {
  /* …16+ lines… */
}
```

> Limitation: the heuristic is **named-declaration-only**. Anonymous / default-export components
> (`export default () => …`) and HOC-wrapped ones (`memo(...)`, `forwardRef(...)`) are not recognized
> and remain subject to all three rules.

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
