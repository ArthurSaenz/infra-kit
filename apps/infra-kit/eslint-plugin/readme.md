# @wl/eslint-plugin

Custom ESLint rules that enforce the white-label frontend architecture conventions.

## Installation

```bash
pnpm add -D @wl/eslint-plugin
```

## Usage (flat config)

Enable everything via the recommended preset:

```js
// eslint.config.js
import wl from '@wl/eslint-plugin'

export default [wl.configs.recommended]
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
