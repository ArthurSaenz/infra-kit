# Enforcement Rules — Expanded Rationale & Workflow

This document provides the WHY behind each enforcement rule and expands the two most commonly misunderstood rules (5 and 7). For condensed rule definitions and fix recipes, see [fe-architect rules.md](../../fe-architect/references/core/rules.md).

---

## 6-Step Enforcement Workflow

When a violation is detected during code generation or review:

### Step 1: STOP

Halt code generation immediately. Do not produce more code that builds on a violation.

### Step 2: Identify

Name the specific rule violated (Rule 1–7) and the tier (blocking).

### Step 3: Show Code

Quote the exact line(s) that violate the rule. Include the file path.

```
Rule 5 violation in features/user/components/user-card-component.tsx:
  import { useAtomValue } from 'jotai'  ← prohibited in dumb component
```

### Step 4: Explain WHY

Give the rationale — not just "it's a rule" but why this rule exists and what breaks without it. Reference the WHY sections below.

### Step 5: Provide Fix

Show the corrected code using the fix recipe from rules.md.

### Step 6: Don't Proceed

Do not continue generating code until the violation is resolved. If the user insists on proceeding without fixing, acknowledge the trade-off explicitly.

---

## Blocking vs Warning

### Blocking Rules (STOP immediately)

| Rule | Name | Violation = |
|------|------|-------------|
| 1 | No cross-feature imports | Hidden dependency, breaks feature isolation |
| 2 | Service export naming | Ambiguous API, merge conflicts |
| 3 | Atom `$` prefix | Indistinguishable from regular variables |
| 4 | Async write-only `Fx` suffix | Cannot tell sync from async at call site |
| 5 | Dumb component purity | Untestable, unreusable component |
| 6 | Dumb component `className` + `cn()` | Cannot compose styles from parent |
| 7 | Container state handling | Runtime crashes, poor UX |

### Warning Indicators (flag, don't block)

| Indicator | Threshold | Suggested Action |
|-----------|-----------|------------------|
| Component line count | > 150 lines | Split into subcomponents |
| `services.ts` line count | > 250 lines | Convert to `services/` folder |
| `services.ts` endpoint count | > 3 endpoints | Convert to `services/` folder |
| Props interface size | > 8 properties | Consider composition or grouping |
| Inline type in public API | Any | Extract to named interface |

### Validation Timing

- **During generation:** Check each rule as code is produced. Stop on first blocking violation.
- **After generation:** Run validation scripts to catch anything missed.
- **During review:** Check all rules on the complete changeset. Report all violations at once.

---

## Rule 5 Expanded: Dumb Component Purity

### The Rule

Dumb components (`*-component.tsx`) are pure UI functions: props in, JSX out. They contain ZERO business logic, state management, or external data access.

### Explicitly Prohibited Imports in Dumb Components

```typescript
// ❌ ALL of these are BLOCKING violations in a *-component.tsx file

import { useAtomValue, useSetAtom, useAtom } from 'jotai'        // State management
import { featureService } from '../services'                      // Feature services
import { httpClient } from '#root/lib/http-client'                // Direct API calls
import { calculateDiscount } from '../services/libs'              // Business logic
import { trackEvent } from '../analytics'                         // Analytics (side effect)
import { someService } from '#root/features/other-feature'        // Cross-feature service
```

### Allowed in Dumb Components

| Import/Hook | Why Allowed |
|-------------|-------------|
| `useState` | UI-only state (dropdown open, tooltip visible, input focus) |
| `useRef` | DOM references (scroll position, input focus, measurements) |
| `useMemo` | Performance optimization of derived JSX/values from props |
| `useCallback` | Stable references for event handlers derived from props |
| `cn()` from `#root/lib/utils` | Style composition utility (required by Rule 6) |
| Third-party UI libraries | Headless UI, Radix, etc. — pure UI concerns |
| `React.forwardRef` | DOM ref forwarding |

### What is NOT UI-Only State

```typescript
// ❌ These look like UI state but are actually business logic:
const [isSubmitting, setIsSubmitting] = useState(false)  // ❌ Submission state = business logic
const [error, setError] = useState(null)                 // ❌ Error state = business logic
const [data, setData] = useState(null)                   // ❌ Data fetching = business logic

// ✅ These ARE genuine UI-only state:
const [isDropdownOpen, setIsDropdownOpen] = useState(false)  // ✅ Pure visual toggle
const [tooltipPosition, setTooltipPosition] = useState(null) // ✅ DOM positioning
const [searchInput, setSearchInput] = useState('')            // ✅ Controlled input value
const scrollRef = useRef<HTMLDivElement>(null)                // ✅ DOM reference
```

### Full Violation Example

```tsx
// ❌ VIOLATION — features/user/components/user-card-component.tsx
import { useAtomValue } from 'jotai'
import { cn } from '#root/lib/utils'
import { userService } from '../services'

interface UserCardComponentProps {
  userId: string
  className?: string
}

export const UserCardComponent = (props: UserCardComponentProps) => {
  const { userId, className } = props

  // ❌ Atom access in dumb component
  const user = useAtomValue(userService.$users).find((u) => u.id === userId)
  // ❌ Business logic (filtering) in dumb component

  if (!user) return null

  return (
    <div className={cn('card', className)}>
      <span>{user.name}</span>
    </div>
  )
}
```

### Fix

```tsx
// ✅ FIXED — features/user/components/user-card-component.tsx
import { cn } from '#root/lib/utils'
import type { User } from '../types'

interface UserCardComponentProps {
  user: User
  className?: string
}

export const UserCardComponent = (props: UserCardComponentProps) => {
  const { user, className } = props

  return (
    <div className={cn('card', className)}>
      <span>{user.name}</span>
    </div>
  )
}

// Container handles data fetching and filtering:
// ✅ features/user/containers/user-card-container.tsx
import { useAtomValue } from 'jotai'
import { userService } from '../services'
import { UserCardComponent } from '../components/user-card-component'

interface UserCardContainerProps {
  userId: string
}

export const UserCardContainer = (props: UserCardContainerProps) => {
  const { userId } = props

  const users = useAtomValue(userService.$users)
  const user = users.find((u) => u.id === userId)

  if (!user) return null

  return <UserCardComponent user={user} />
}
```

### WHY: Rationale for Dumb Component Purity

1. **Testability** — Dumb components test with simple prop objects. No Jotai provider, no mock services, no async setup. Tests run fast and never flake.
2. **Reusability** — A pure dumb component works in any context: different features, Storybook, design system docs. Coupled components only work where their services exist.
3. **Predictability** — Given the same props, a dumb component always renders the same output. No hidden state changes, no surprise re-renders from atom subscriptions.
4. **Storybook compatibility** — Stories define props directly. If a component needs atoms or services, every story requires complex decorators and mock providers.
5. **Performance isolation** — Atom subscriptions cause re-renders. Keeping subscriptions in containers means dumb components only re-render when their props actually change.

---

## Rule 7 Expanded: Container State Handling

### The Rule

Smart components (containers) must handle all possible states before rendering content: loading, error, empty, and content.

### Loading: First Fetch Only

```tsx
// ❌ WRONG — Shows loading spinner on every refetch
const isLoading = useAtomValue(service.$isLoading)
if (isLoading) return <LoadingSpinner />

// ✅ CORRECT — Loading for first fetch, separate refreshing indicator
const isLoading = useAtomValue(service.$isLoading)
const data = useAtomValue(service.$data)
const isRefreshing = useAtomValue(service.$isRefreshing)

// First load: no data yet → full loading state
if (isLoading && !data) return <LoadingSpinner />

// Refetch: show existing data with a subtle refresh indicator
// (never replace existing content with a full spinner)
return (
  <div>
    {isRefreshing && <RefreshIndicator />}
    <DataComponent data={data} />
  </div>
)
```

**Why:** Replacing visible content with a spinner during refetch (pull-to-refresh, polling, re-navigation) is jarring and makes the app feel slow. Show the stale data with a subtle indicator instead.

### Minimum Required States

Every container must handle these 4 states in this order:

```tsx
export const FeatureContainer = () => {
  const data = useAtomValue(service.$data)
  const isLoading = useAtomValue(service.$isLoading)
  const error = useAtomValue(service.$error)

  // 1. Loading (first fetch only)
  if (isLoading && !data) return <LoadingSpinner />

  // 2. Error
  if (error) return <ErrorMessage error={error} />

  // 3. Empty (data loaded but nothing to show)
  if (!data || data.length === 0) return <EmptyState message="No items found" />

  // 4. Content (data is guaranteed non-null here)
  return <FeatureComponent data={data} />
}
```

### Guard Clause Ordering Rationale

The order matters:

1. **Loading first** — Prevents rendering error/empty states during initial fetch (error might be null but data is also null)
2. **Error second** — If loading finished and there's an error, show it regardless of data state
3. **Empty third** — Data loaded successfully but is empty; distinct from error
4. **Content last** — All edge cases handled; TypeScript can narrow the type to non-null

### Full Violation Example

```tsx
// ❌ VIOLATION — features/projects/containers/project-list-container.tsx
export const ProjectListContainer = () => {
  const projects = useAtomValue(projectService.$projects)

  // ❌ No loading state — blank screen during fetch
  // ❌ No error state — crashes or shows nothing on failure
  // ❌ No empty state — shows broken layout with empty array

  return <ProjectListComponent projects={projects} />
  // ❌ Crashes if projects is null (not yet fetched)
}
```

### Fix

```tsx
// ✅ FIXED — features/projects/containers/project-list-container.tsx
export const ProjectListContainer = () => {
  const projects = useAtomValue(projectService.$projects)
  const isLoading = useAtomValue(projectService.$isLoading)
  const error = useAtomValue(projectService.$error)

  if (isLoading && !projects) return <LoadingSpinner />
  if (error) return <ErrorMessage error={error} />
  if (!projects || projects.length === 0) {
    return <EmptyState message="No projects found" />
  }

  return <ProjectListComponent projects={projects} />
}
```

### WHY: Rationale for Container State Handling

1. **Crash prevention** — Accessing properties on `null`/`undefined` data is the most common runtime error in React apps. Guard clauses eliminate this class of bugs entirely.
2. **User experience** — Every state tells the user what's happening. A blank screen is worse than a loading spinner; a loading spinner is worse than an error message with a retry button.
3. **TypeScript narrowing** — Guard clauses progressively narrow the type. After `if (!data) return ...`, TypeScript knows `data` is non-null in the content branch — eliminating the need for non-null assertions or optional chaining.
4. **Debugging** — When something goes wrong, a visible error state with details is infinitely more useful than a blank screen or a console error buried in noise.

---

## Rules 1–4, 6: WHY Rationale

Fix recipes for these rules are in [fe-architect rules.md](../../fe-architect/references/core/rules.md). Below is the expanded rationale for WHY each rule exists.

### Rule 1: No Cross-Feature Imports — WHY

- **Deletion safety** — Deleting a feature folder should require updating only the page(s) that use it, not other features
- **Dependency graph** — Cross-feature imports create hidden dependency chains that grow exponentially and become impossible to track
- **Parallel development** — Two teams cannot independently develop features that import from each other
- **Testing isolation** — A feature that imports another feature's service requires that service's entire dependency tree in tests

### Rule 2: Service Export Naming (`[featureName]Service`) — WHY

- **Disambiguation** — `service.$data` is meaningless in a page that imports 5 features; `userProfileService.$data` is clear
- **Grep-ability** — Searching for `userProfileService` finds all usages instantly; `service` matches everything
- **Merge conflict prevention** — Generic names like `service` cause conflicts when features are composed in the same page file

### Rule 3: Atom `$` Prefix — WHY

- **Visual scanning** — In a file with 20 imports, `$userData` immediately reads as "reactive state" while `userData` could be anything
- **Accidental mutation prevention** — The `$` signals "subscribe to this, don't mutate it" — a cognitive guardrail
- **Convention alignment** — Consistent with observable/signal conventions in other state libraries (MobX, Solid, Svelte stores)

### Rule 4: Async Write-Only `Fx` Suffix — WHY

- **Async awareness** — `getUserFx` tells the developer at the call site that this is async (needs error handling, may be slow, returns a promise)
- **Sync vs async distinction** — `resetDataAtom` (sync, instant) vs `resetDataFx` (async, may fail) require different handling patterns
- **Error handling obligation** — The `Fx` suffix is a reminder that the call may fail and the error must be handled somewhere

### Rule 6: Dumb Component `className` + `cn()` — WHY

- **Composability** — Without `className`, a parent cannot adjust spacing, sizing, or layout of a child component without wrapper divs
- **Design system alignment** — `cn()` merges Tailwind classes correctly (later classes override earlier ones), preventing specificity bugs
- **Consistent API** — Every dumb component has the same escape hatch for styling, reducing the "how do I customize this?" question to zero
