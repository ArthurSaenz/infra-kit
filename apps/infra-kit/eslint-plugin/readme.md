# @wl/eslint-plugin

Custom ESLint rules that enforce the white-label frontend architecture conventions.

## Installation

```bash
pnpm add -D @wl/eslint-plugin
```

## Usage (flat config)

Enable everything via the recommended preset. It is an array of config blocks
(rules scoped to `*.tsx`, with `component-file-order` turned off for
`*.stories.{ts,tsx}`), so spread it:

```js
// eslint.config.js
import wl from '@wl/eslint-plugin'

export default [...wl.configs.recommended]
```

Or register the plugin and pick rules manually:

```js
import wl from '@wl/eslint-plugin'

export default [
  {
    plugins: { '@wl': wl },
    rules: {
      '@wl/props-destructuring-newline': 'error',
    },
  },
]
```

## Rules

### `props-destructuring-newline`

🔧 Automatically fixable.

React components must accept a single `props` parameter and destructure it on
its own line inside the body, instead of destructuring inline in the parameter
list.

```tsx
// ❌ Incorrect
const UserCard = ({ user, className }: UserCardProps) => {
  return <div className={className}>{user.name}</div>
}

// ✅ Correct
const UserCard = (props: UserCardProps) => {
  const { user, className } = props

  return <div className={className}>{user.name}</div>
}
```

A function is treated as a component when its name is PascalCase (looking
through `memo`/`forwardRef`/`observer` wrappers) or when it returns JSX. Hooks,
plain helpers, and any function whose first parameter is not an object pattern
are ignored.

### `props-destructuring-blank-line`

🔧 Automatically fixable.

Require a blank line after the `const { ... } = props` destructuring statement
at the top of a component body.

```tsx
// ❌ Incorrect
const UserCard = (props: UserCardProps) => {
  const { user, className } = props
  return <div className={className}>{user.name}</div>
}

// ✅ Correct
const UserCard = (props: UserCardProps) => {
  const { user, className } = props

  return <div className={className}>{user.name}</div>
}
```

The rule only triggers inside components (same detection as above) and only for
a statement that destructures the `props` identifier. It is a no-op when the
destructuring is the last statement in the body.

### `props-type-reference`

A React component's props parameter must use a **named type** (e.g.
`ButtonProps`) rather than an inline object type literal. This keeps props types
discoverable, reusable, and consistent with the `ComponentNameProps` naming
convention. Report-only (it does not auto-extract the type).

```tsx
// ❌ Incorrect — inline object type on the props parameter
const Button = (props: { label: string }) => <button>{props.label}</button>
function Card({ title }: { title: string }) {
  return <div>{title}</div>
}

// ✅ Correct — a named type reference
const Button = (props: ButtonProps) => <button>{props.label}</button>
function Card({ title }: CardProps) {
  return <div>{title}</div>
}
```

A function is treated as a component with the same detection as the rules above
(PascalCase name through `memo`/`forwardRef`/`observer` wrappers, or a JSX
return). The message suggests `<ComponentName>Props` when the component name is
resolvable, and a generic phrasing for anonymous components.

Limitations (v1): only a bare inline object type (`{ ... }`) on the first
parameter is flagged. An intersection or union that merely _contains_ a literal
(e.g. `Base & { x: number }`) is left alone. A default parameter value
(`(props: { x } = {})`) is still flagged.

#### Option: `paths` / `ignore` (optional)

Same glob semantics as `component-file-order`: `paths` restricts the rule to
matching files, `ignore` skips matching files (and takes precedence over
`paths`).

```js
{
  rules: {
    '@wl/props-type-reference': ['error', { ignore: ['**/*.stories.tsx'] }],
  },
}
```

### `component-file-order`

Enforce a strict top-level order in files that contain a React component:
**imports → component props interface/type → component declaration**. Constants
and helpers between the interface and the component are allowed. Report-only (it
does not auto-reorder code).

```tsx
// ❌ Incorrect — interface before imports, or component before its interface
interface CardProps { title: string }
import { cn } from '#root/lib/utils'

// ✅ Correct
import { cn } from '#root/lib/utils'

interface CardProps {
  title: string
}

const Card = (props: CardProps) => {
  const { title } = props

  return <div className={cn('card')}>{title}</div>
}
```

The rule activates only when the file actually contains a component. The "props
interface" is any top-level `interface`/`type` whose name ends in `Props`.

When the first component's props type is **imported** (e.g.
`import type { CardProps } from './types'`) instead of declared in the file,
there is no in-file interface to anchor against — so the component itself must
sit immediately after the imports, with no stray top-level definitions wedged in
between. Only the first component is anchored this way; the props binding must be
the conventional `<ComponentName>Props` name for the check to apply.

```tsx
// ❌ Incorrect — props imported, but a stray const sits before the component
import { cn } from '#root/lib/utils'
import type { CardProps } from './types'

const SOMETHING = 1

const Card = (props: CardProps) => <div className={cn('card')}>{props.title}</div>

// ✅ Correct — component immediately after the imports
import { cn } from '#root/lib/utils'
import type { CardProps } from './types'

const Card = (props: CardProps) => <div className={cn('card')}>{props.title}</div>
```

#### Option: `paths` (optional)

Restrict the rule to specific files via glob patterns. When omitted, it runs on
every file (you can also scope it the usual way with flat-config `files`).

```js
{
  rules: {
    '@wl/component-file-order': ['error', { paths: ['**/features/**', 'apps/*/ui/**'] }],
  },
}
```

Glob support: `*` matches within a path segment, `**` matches across segments,
`?` matches a single character. A file matches if any pattern matches its path.

### `component-arrow-function`

React components must be declared as **arrow functions**, not `function`
declarations or function expressions. This keeps component definitions consistent
across features and components. Report-only (it does not auto-convert the
function — hoisting, generics, and default-export semantics make a safe autofix
non-trivial).

```tsx
// ❌ Incorrect — function declaration
function Card(props: CardProps) {
  return <div>{props.title}</div>
}

// ❌ Incorrect — function expression
const Card = function (props: CardProps) {
  return <div>{props.title}</div>
}

// ✅ Correct — arrow function (memo/forwardRef wrappers are fine)
const Card = (props: CardProps) => <div>{props.title}</div>
const Memoized = memo((props: CardProps) => <div>{props.title}</div>)
```

A function is treated as a component with the same detection as the rules above
(PascalCase name through `memo`/`forwardRef`/`observer` wrappers, or a JSX
return) — so a PascalCase function is flagged even when it does not return JSX.
The message names the component when resolvable and uses a generic `component`
phrasing for anonymous defaults (e.g. `export default memo(function () { ... })`).
Only top-level declarations are inspected; re-exports (`export { Foo }`) and
`export default Foo` are governed at the declaration site.

The `recommended` preset enables this rule for `*.tsx` with a default
`ignore` of `['**/pages/**', '**/routes/**']`, since page and route modules
commonly use `function` declarations (and framework conventions such as
default-exported page/route functions).

#### Option: `paths` / `ignore` (optional)

Same glob semantics as `component-file-order`: `paths` restricts the rule to
matching files, `ignore` skips matching files (and takes precedence over
`paths`). Use `ignore` to exclude pages and routes (override the preset default
to add your own, e.g. an `app/` router):

```js
{
  rules: {
    '@wl/component-arrow-function': ['error', { ignore: ['**/pages/**', '**/routes/**', '**/app/**'] }],
  },
}
```

### `require-component-stories`

Require a co-located Storybook story for every dumb component. By default it enforces two layouts,
mirroring the white-label `fe-architect` convention:

| Layout                   | Component file                                       | Required story                                                               |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Feature component        | `features/<feature>/components/<name>-component.tsx` | `features/<feature>/__stories__/<name>-component.stories.tsx` (feature root) |
| Shared default component | `components/default/<name>-component.tsx`            | `components/default/__stories__/<name>-component.stories.tsx` (sibling)      |

A file is treated as a dumb component when it ends with the `-component` suffix, has a `.tsx`/`.jsx`
extension, sits directly inside a `components/` directory (feature layout) or `components/default/`
(shared layout), and — by default — actually declares a React component. Containers, nested
`components/sub/*` files, barrels (`index.*`), and type files are never required to have stories. The
story is satisfied when any candidate (`.tsx`, `.jsx`, `.ts`, `.js`) exists on disk.

```js
{
  rules: {
    '@wl/require-component-stories': 'error',
  },
}
```

#### Options (all optional)

| Option                | Default                          | Description                                                                                              |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `paths`               | `[]`                             | Restrict the rule to files matching these globs.                                                         |
| `ignore`              | `[]`                             | Skip files matching these globs (takes precedence over `paths`).                                         |
| `storiesDir`          | `'__stories__'`                  | Directory name a story must live in.                                                                     |
| `storySuffix`         | `'.stories'`                     | Suffix inserted before the extension.                                                                    |
| `storyExtensions`     | `['.tsx', '.jsx', '.ts', '.js']` | Accepted story extensions, in priority order.                                                            |
| `componentSuffix`     | `'-component'`                   | Basename suffix a component must end with (`''` disables the check).                                     |
| `requireComponentAst` | `true`                           | When true, only require a story for files that actually declare a component.                             |
| `extraTargets`        | `[]`                             | Extra structured layouts: `{ componentsDir, anchorParentDir?, storyMode: 'feature-root' \| 'sibling' }`. |

```js
{
  rules: {
    '@wl/require-component-stories': ['error', {
      extraTargets: [{ componentsDir: 'widgets', anchorParentDir: 'ui', storyMode: 'sibling' }],
    }],
  },
}
```

#### Caveats

- **Filesystem-coupled.** Unlike pure AST rules, this one checks the disk for a sibling story file,
  so results depend on the working-tree state.
- **`--cache`.** Adding or removing a story file does not change the component file, so a cached
  ESLint result can go stale. Run without `--cache` in CI (or invalidate the cache) if you rely on
  this rule as a gate.
- **Case sensitivity.** The existence check is exact-case; a casing mismatch may pass on a
  case-insensitive filesystem (macOS) and fail on a case-sensitive one (Linux CI).
- **Unanchored globs.** `paths`/`ignore` patterns match anywhere in the path, so anchor them
  (e.g. start with `**/`) when you need precision.
