# @wl/eslint-plugin

Custom ESLint rules that enforce the white-label frontend architecture conventions.

## Installation

```bash
pnpm add -D @wl/eslint-plugin
```

## Usage (flat config)

Enable everything via the recommended preset. It is an array of config blocks
(rules scoped to `*.tsx`, with `component-file-order` and `props-type-name`
turned off for `*.stories.{ts,tsx}`), so spread it:

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

### `props-type-name`

A React component's props type must be named **`<ComponentName>Props`** (e.g.
`ButtonProps` for `Button`). This complements `props-type-reference`: that rule
requires a _named_ type (not an inline literal); this rule requires that name to
follow the convention. Report-only.

```tsx
// ❌ Incorrect — props type does not match the component name
const Button = (props: Props) => <button>{props.label}</button>
function Card({ title }: CardConfig) {
  return <div>{title}</div>
}

// ✅ Correct — `<ComponentName>Props`
const Button = (props: ButtonProps) => <button>{props.label}</button>
function Card({ title }: CardProps) {
  return <div>{title}</div>
}
```

The component is detected the same way as the other rules (PascalCase name
through `memo`/`forwardRef`/`observer` wrappers, or a JSX return). Only a simple
named type reference on the first parameter is checked: inline object types are
the `props-type-reference` rule's concern, and anonymous components, untyped
props, and qualified/generic annotations (`NS.Props`, `FC<Props>`) are left
alone. An imported props type with a non-conventional name is still flagged —
use `paths`/`ignore` to exempt it.

The recommended preset turns this rule **off for `*.stories.{ts,tsx}`**: story
templates legitimately reference the component's own props type (e.g.
`const Template = (args: ButtonProps) => ...`) rather than `<TemplateName>Props`.

#### Option: `paths` / `ignore` (optional)

Same glob semantics as `component-file-order`: `paths` restricts the rule to
matching files, `ignore` skips matching files (and takes precedence over
`paths`).

```js
{
  rules: {
    '@wl/props-type-name': ['error', { ignore: ['**/*.stories.tsx'] }],
  },
}
```

### `component-file-order`

Enforce a strict top-level order in files that contain a React component:
**imports → component props interface/type → component declaration**, with the
props interface declared **immediately before** the component — no constants,
helpers, or other declarations wedged between them. Helpers are allowed _after_
the component (or between two separate component blocks). Report-only (it does
not auto-reorder code).

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

The rule activates only when the file actually contains a component. A
component's props interface is matched by the **type its parameter actually
references** (e.g. `Props` in `(props: Props)`), not by a name convention — so an
interface named anything is enforced, as long as the component uses it. (When the
parameter has no resolvable named type, the rule falls back to looking for a
`<ComponentName>Props` interface.)

When the first component's props type is **imported** (e.g.
`import type { CardProps } from './types'`) instead of declared in the file,
there is no in-file interface to anchor against — so the component itself must
sit immediately after the imports, with no stray top-level definitions wedged in
between. Only the first component is anchored this way.

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

### `max-jsx-return-size`

Warn when a single component **return** renders too many JSX elements. Large
return blocks are hard to scan; the fix is to extract part of the markup into a
variable or a sub-component. Report-only — the remedy is left to the developer
(no autofix), because safely extracting JSX touches scope, hooks, and keys.

```tsx
// ❌ Incorrect — one return renders too many elements (default max 20)
const Dashboard = () => (
  <div>
    <header>…</header>
    <main>… lots of nested markup …</main>
    <footer>…</footer>
  </div>
)

// ✅ Correct — extract parts into variables or sub-components
const Dashboard = () => {
  const header = <header>…</header>
  const footer = <footer>…</footer>

  return (
    <div>
      {header}
      <Main />
      {footer}
    </div>
  )
}
```

The metric is a **count of `JSXElement` nodes in the returned expression** —
formatting-independent (Prettier reflow never changes the verdict). Each return
in a component is measured on its own, so a small guard such as
`if (loading) return <Spinner />` is never penalised by a large sibling return.

Counting rules:

- **Extraction lowers the count.** JSX hoisted into a variable is referenced as
  `{header}` (a JSX expression container, not a `JSXElement`), so it is not
  counted — extracting strictly reduces the number.
- **Fragments are free.** `<>…</>` contributes `0`; its children still count.
- **Inline-callback JSX counts** in the parent return: `<ul>{items.map(() => <li />)}</ul>`
  counts `<ul>` and `<li>` (extract a `<Row />` sub-component to reduce it).
- **Conditional branches are summed:** `cond ? <A /> : <B />` counts both sides.
- **JSX in attributes is counted:** `<Foo icon={<Icon />} />` counts `Foo` and `Icon`.

Only **top-level declared** components are inspected (same as
`component-arrow-function`), so anonymous inline callbacks are never reported on
their own. A top-level JSX-returning helper (e.g. `const renderRow = () => <li />`)
is treated as a component and measured. The message names the component when
resolvable and uses a generic `component` for anonymous defaults.

**Actionable message.** When one block dominates the return, the message points
at it — its tag, line, and element count — so a human (or an automated lint →
fix → lint loop) knows exactly what to lift out:

```
Dashboard renders 28 JSX elements in one return (max 20). Extract the largest
block — <section> at line 14 (12 elements) — into a variable or a sub-component.
```

When no single block dominates (e.g. many flat sibling elements), there is
nothing useful to point at, so the message instead advises splitting the return
into smaller sub-components.

#### Option: `maxElements` (optional)

The element ceiling before the rule reports. Defaults to `20`. Only counts
strictly greater than the ceiling are reported (`count === max` is allowed).

```js
{
  rules: {
    '@wl/max-jsx-return-size': ['error', { maxElements: 25 }],
  },
}
```

#### Option: `paths` / `ignore` (optional)

Same glob semantics as the other rules: `paths` restricts the rule to matching
files, `ignore` skips matching files (and takes precedence over `paths`).

### `max-components-per-file`

Caps how many React components a single file may declare; extra components
belong in their own files. This keeps files focused and discoverable instead of
growing into multi-component junk drawers.

```tsx
// ❌ Incorrect — 5 components in one file (default ceiling is 4)
const A = () => <div />
const B = () => <div />
const C = () => <div />
const D = () => <div />
const E = () => <div /> // reported here: "This file declares 5 components (max 4)"

// ✅ Correct — split the extra component into its own file
```

Only **top-level** declarations are counted. A multi-declarator statement
(`const A = () => …, B = () => …`) counts each component separately. Re-exports
(`export { X } from './x'`) declare nothing and are not counted, and
`styled.div\`…\`` tagged templates are not component functions, so they are not
counted either. Nested / in-render components are intentionally out of scope —
that is a different concern (component identity / re-render stability), better
served by `react/no-unstable-nested-components`.

Detection uses the same heuristic as the other rules (PascalCase name through
`memo`/`forwardRef`/`observer` wrappers, or a JSX return). A consequence worth
knowing: a PascalCase-named function that returns a non-JSX value (e.g. a factory
`const Make = () => ({ … })`) is counted as a component, because the name
short-circuits the check. This is consistent across the plugin.

The rule reports **once per file**, anchored to the first component over the
limit, rather than once per excess component — there is no autofix, so a single
file-scoped diagnostic is more useful than N copies of the same advice.

In the recommended preset the ceiling is `4` for `*.tsx` generally and tightened
to `1` for dumb `*-component.tsx` files (matching the one-component-per-file
convention the props/order/stories rules already assume); `**/pages/**` and
`**/routes/**` are exempt, since route/page modules legitimately co-locate
multiple route or layout components. For a file that genuinely needs to break the
ceiling, use an inline `// eslint-disable-next-line @wl/max-components-per-file`.

#### Why a custom rule (vs `react/no-multi-comp`)

`eslint-plugin-react`'s `no-multi-comp` covers similar ground but effectively
enforces a fixed ceiling of 1 (it flags the 2nd+ component) and cannot be
configured to an arbitrary limit. This rule exists because it (1) supports a
configurable `maxComponents` ceiling, (2) supports tiered per-file-type limits
via flat-config layering, and (3) reuses this plugin's centralized component
detection so its behavior matches the sibling `@wl` rules. (`eslint-plugin-react`
is not a dependency of this repo.)

#### Option: `maxComponents` (optional)

The component ceiling before the rule reports. Defaults to `4`. Only counts
strictly greater than the ceiling are reported (`count === max` is allowed).

```js
{
  rules: {
    '@wl/max-components-per-file': ['error', { maxComponents: 2 }],
  },
}
```

#### Option: `paths` / `ignore` (optional)

Same glob semantics as the other rules: `paths` restricts the rule to matching
files, `ignore` skips matching files (and takes precedence over `paths`).

> **Flat-config note:** options are **replaced**, not merged, across matching
> config blocks. If you override `maxComponents` for a glob, re-declare `ignore`
> in that same block or its exemptions are lost.

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
