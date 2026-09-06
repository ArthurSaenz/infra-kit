# Cross-Feature Communication Patterns

## 5 Golden Rules for Feature Independence

1. **No runtime imports between features** — `import type` is allowed (no runtime dependency); everything else is forbidden
2. **Page orchestrates, features execute** — Pages are the only place where multiple features meet; features never know about each other
3. **Props are the only interface** — All cross-feature data flows through component props, never through shared atoms or direct service calls
4. **Type-only coupling is acceptable** — Using `import type` to share type definitions keeps features structurally independent while maintaining type safety
5. **Composition over configuration** — Pass components/elements/render functions as props instead of feature flags or config objects

### Why These Rules Exist

Feature independence enables:
- **Parallel development** — Teams work on features without merge conflicts or coordination overhead
- **Safe deletion** — Remove a feature by deleting its folder and updating the page; no cascading breakage
- **Isolated testing** — A feature that imports another feature's service drags that service's entire dependency tree into its tests; props are mockable, imports are not
- **Predictable refactoring** — Changes inside a feature cannot break other features
- **A traceable dependency graph** — Cross-feature imports create hidden chains that grow exponentially and quickly become impossible to hold in your head

### How much of this does tooling catch?

Rule 1 is the one rule with real lint coverage: the ESLint config models features, services and
`shared` as elements and rejects runtime imports between them — type-only imports allowed, the
`shared` barrel as the single runtime exception.

**Check what is actually in force rather than trusting a note here.** Severities and rule names live
in the lint config, they change there, and a copy written into a skill goes stale silently:

```bash
pnpm exec eslint --print-config path/to/feature/file.tsx
```

One gap the lint layer cannot close on its own:

- **Only `features/` is classified.** The element patterns key off `**/features/*`, so code living
  outside a `features/` directory is unclassified and therefore unpoliced.
  `fe-architect/scripts/analyze_imports.mjs` matches on the path string instead and does not care
  where the file sits — but nothing runs it for you.

Layer ownership for all 7 rules is in
[fe-architect enforcement.md](../../fe-architect/references/core/enforcement.md).

---

## 3 Component Injection Patterns

### Pattern 1: Element (Pre-rendered Slot)

Pass a fully rendered `ReactElement` as a prop. The receiving feature places it without modification.

```tsx
// app/pages/dashboard-page.tsx — the page renders both features and connects them
<DashboardContainer headerBadge={<NotificationBadge count={count} />} />

// features/dashboard/containers/dashboard-container.tsx
interface DashboardContainerProps {
  headerBadge?: React.ReactElement   // pre-rendered — the feature only places it
}
// … <header><h1>Dashboard</h1>{headerBadge}</header>
```

**When to use:**
- Simple visual slots (icons, badges, labels, avatars)
- The receiving feature does not need to pass any data to the injected element
- The element is fully self-contained or configured at the page level

**Pros:**
- Simplest pattern, minimal API surface
- Receiving feature has zero knowledge of what the element is

**Cons:**
- No way for the receiving feature to pass props to the element
- Re-renders of the page may re-create the element (mitigate with `useMemo` if needed)

---

### Pattern 2: Component (Type-level Injection)

Pass a component type. The receiving feature instantiates it and controls props.

```tsx
// app/pages/projects-page.tsx — passes the type, not an instance
<ProjectListContainer AvatarComponent={UserAvatarComponent} />

// features/project-list/containers/project-list-container.tsx
interface ProjectListContainerProps {
  AvatarComponent?: React.ComponentType<{ userId: string; size?: 'sm' | 'md' }>
}
// … the receiving feature decides the props and when to render, once per row:
{AvatarComponent && <AvatarComponent userId={project.ownerId} size="sm" />}
```

**When to use:**
- The receiving feature needs to control WHAT data the injected component receives
- Multiple instances needed (e.g., rendering in a list)
- The receiving feature defines the prop contract

**Pros:**
- Receiving feature controls when/how to render and what props to pass
- Works naturally in loops and conditional rendering
- Component type is PascalCase — visually clear in JSX

**Cons:**
- The receiving feature must define a prop contract that the injected component satisfies
- Tighter coupling than Element (receiving feature knows the shape of props)

---

### Pattern 3: Render Function (Full Control)

Pass a function that receives data and returns JSX. Maximum flexibility.

```tsx
// app/pages/task-board-page.tsx — consumer composes another feature into the slot
<TaskBoardContainer
  renderTaskDetail={(task) => <TaskCommentsContainer taskId={task.id} />}
/>

// features/task-board/containers/task-board-container.tsx
interface TaskBoardContainerProps {
  renderTaskDetail?: (task: Task) => React.ReactElement   // Task from '../types'
}
// … the feature hands its own data to the consumer's function:
{selectedTask && renderTaskDetail?.(selectedTask)}
```

**When to use:**
- The consumer needs access to data from the receiving feature to decide what to render
- Complex composition where multiple features combine in the rendered output
- Conditional rendering based on the receiving feature's internal state

**Pros:**
- Maximum flexibility — consumer controls both structure and content
- Can compose multiple features in the render output
- Can access page-level scope (closures)

**Cons:**
- Most complex pattern, hardest to read
- Risk of creating components inside the render function (see Common Mistakes)
- Type definitions can become verbose

---

## Pattern Selection Decision Matrix

```
Need to pass data TO the injected content?
├─ NO → Element Pattern
└─ YES → Does the receiving feature control WHAT props to pass?
    ├─ YES → Component Pattern
    └─ NO → Does the consumer need to compose multiple things or use closures?
        ├─ YES → Render Function Pattern
        └─ NO → Component Pattern (simpler)
```

| Criterion | Element | Component | Render Function |
|-----------|---------|-----------|-----------------|
| Simplicity | Best | Good | Complex |
| Data flow to injected content | None | Receiver → Injected | Receiver → Consumer → Injected |
| Multiple instances (lists) | Awkward | Natural | Possible |
| Consumer flexibility | None | Limited | Full |
| Type safety effort | Low | Medium | Medium-High |

---

## Service Access Pattern

Features access their own services internally but NEVER access another feature's services directly. Cross-feature service data flows through the page.

### 4 Rules for Service Access

1. **Inside a feature:** Containers import from their own `services` freely
2. **Between features:** Page reads from Feature B's service, passes as props to Feature A
3. **Never:** Feature A imports Feature B's service directly
4. **Type extraction:** Use `@wl/web-toolkit` utilities for type-safe prop definitions

### Full Example: Two Features Sharing Data

```tsx
// app/pages/analytics-page.tsx — the only place the two features meet
const activeFilters = useAtomValue(filterService.$activeFilters)
// … <FilterContainer />
//    <ChartContainer filters={activeFilters} onFilterReset={() => setFilters([])} />

// features/chart/containers/chart-container.tsx
// filterService is imported NOWHERE in this feature — filters arrive as a prop.
interface ChartContainerProps {
  filters: FilterConfig[]
  onFilterReset: () => void
}
// … the chart still owns its own data, fetched from the filters it was given:
useEffect(() => chartService.fetchChartDataFx({ filters }), [filters])
```

---

## Type Extraction

Use `@wl/web-toolkit` type utilities to extract types from atoms without runtime imports.

### Variant 1: `ExtractedAtomType` — Read-Only Atom Value

Extract the value type `T` from `Atom<T>`. Use when passing atom values as props.

```typescript
import type { ExtractedAtomType } from '@wl/web-toolkit'

// In page or consuming feature's types
type UserData = ExtractedAtomType<typeof import('#root/features/user').userService.$userData>
// Resolves to: User | null (whatever the atom holds)

interface MyContainerProps {
  userData: UserData
}
```

### Variant 2: `ExtractAtomActionArgs` — Write-Only Atom Arguments

Extract the argument type from a write-only atom's write function. Use when forwarding actions.

**Important:** The actual export is `ExtractAtomActionArgs`, not `ExtractWriteOnlyAtomArgs`.

```typescript
import type { ExtractAtomActionArgs } from '@wl/web-toolkit'

// Extract the args type from a Fx atom
type UpdateUserArgs = ExtractAtomActionArgs<
  typeof import('#root/features/user').userService.updateUserFx
>
// Resolves to: UpdateUserFxArgs (the interface defined for the atom)

interface MyContainerProps {
  onUpdateUser: (args: UpdateUserArgs) => void
}
```

### Variant 3: `ExtractAtomSetter` — Read-Write Atom Setter

Extract the updater function signature `(prev: Value) => Value` from a writable atom.

```typescript
import type { ExtractAtomSetter } from '@wl/web-toolkit'

type SetTheme = ExtractAtomSetter<typeof import('#root/features/theme').themeService.$theme>
// Resolves to: (prev: ThemeConfig) => ThemeConfig

interface MyContainerProps {
  onThemeChange: SetTheme
}
```

### Variant 4: Direct `import type` for Exported Domain Types

When a feature exports domain types via `index.ts`, import them directly.

```typescript
// features/user/index.ts
export type { User, UserRole } from './types'

// In another feature's types.ts
import type { User, UserRole } from '#root/features/user'
// ✅ import type = no runtime dependency
```

### When to Use Which

| Scenario | Utility |
|----------|---------|
| Pass atom value as prop | `ExtractedAtomType` |
| Forward write-only atom action | `ExtractAtomActionArgs` |
| Forward atom setter function | `ExtractAtomSetter` |
| Reference shared domain types | Direct `import type` |

---

## State Sharing Between Features

When two features need to share reactive state, coordinate at the page level.

### Page-Level Coordination Pattern

```tsx
// app/pages/workspace-page.tsx — sidebar OWNS the state; content only receives it
const selectedItem = useAtomValue(sidebarService.$selectedItem)
const setSelectedItem = useSetAtom(sidebarService.selectItemAtom)

// … <SidebarContainer />
//    <ContentContainer
//      selectedItem={selectedItem}
//      onItemSelect={(id) => setSelectedItem({ itemId: id })}
//    />
```

**Key principle:** One feature owns the state. The page reads it and distributes to others via props. Never duplicate state across features.

---

## Shared vs Feature Component

Where a component lives is a boundary question: the moment a second feature wants it, you are
deciding whether to create a dependency or a shared asset.

```
Is the component used by 3+ features?
├─ YES → Does it contain ZERO business logic?
│  ├─ YES → Shared component (e.g., packages/ui or shared/components)
│  └─ NO → Split: dumb part → shared, logic → each feature's container
└─ NO → Is it used by exactly 2 features?
   ├─ YES → Keep it in one feature; the other receives it via an injection pattern
   │        Promote to shared only when a 3rd consumer appears
   └─ NO → Feature component (stays in the feature)
```

### Promotion Checklist

Before promoting a component to shared:
- [ ] Zero imports from any feature (no atoms, services, feature types)
- [ ] Accepts `className` prop with `cn()` (Rule 6 compliant)
- [ ] Has comprehensive tests and stories
- [ ] Props interface is generic enough (no feature-specific types)
- [ ] At least 3 consumers exist or are planned

### Why Wait for 3 Consumers

Premature abstraction creates components that satisfy no consumer perfectly. With 3 consumers the
common pattern becomes visible and the abstraction has a foundation. Two consumers might have
coincidentally similar needs — and a shared component built for a coincidence is harder to remove
than one that was never shared.

Note the asymmetry with the runtime rule: `shared` is the one place features may import from at
runtime, and only through its barrel. That exception is what makes
promotion safe — and what makes promoting too early expensive.

---

## Best Practices

- **Explicit props over implicit context** — Always pass data explicitly via props rather than using shared atoms or React context across features
- **No component creation in render** — Never define components inside render functions (causes remount on every render)
- **No callback internals exposed** — Pass simple callback signatures (`() => void`, `(id: string) => void`), not atom setters or service methods directly
- **Props interface in the feature** — Each feature defines its own props interface; the page satisfies it using whatever sources it needs
- **Minimal prop surface** — Pass only what the feature needs, not entire objects "just in case"

---

## Common Mistakes

### Mistake 1: Creating Components Inside Render Functions

```tsx
// ❌ a new component type on every render — remounts, state lost
renderDetail={(task) => {
  const DetailView = () => <TaskComments taskId={task.id} />
  return <DetailView />
}}

// ✅ return the JSX directly, no intermediate component
renderDetail={(task) => <TaskComments taskId={task.id} />}
```

**Why it breaks:** React sees a new component type each render → unmounts and remounts → loses all state, triggers effects, causes flicker.

### Mistake 2: Feature Importing Another Feature's Service

```tsx
// ❌ features/dashboard/containers/dashboard-container.tsx
import { userService } from '#root/features/user'   // BLOCKING — hidden dependency
const user = useAtomValue(userService.$currentUser)

// ✅ app/pages/home-page.tsx — the page owns the cross-feature wiring
const user = useAtomValue(userService.$currentUser)
// … <DashboardContainer currentUser={user} />   ← dashboard just takes a prop
```

**Why it breaks:** Creates a hidden dependency graph between features. Deleting the `user` feature would break `dashboard` with no compile-time warning in many cases.

### Mistake 3: Passing Atom References as Props

```tsx
// ❌ passing the atom itself — Feature A now depends on Jotai's runtime
<FeatureA userAtom={userService.$currentUser} />
const user = useAtomValue(userAtom)                 // … inside Feature A

// ✅ resolve at the page, pass plain data
<FeatureA currentUser={useAtomValue(userService.$currentUser)} />
// … <FeatureAComponent user={currentUser} />       ← no atom dependency
```

**Why it breaks:** The receiving feature becomes coupled to Jotai's runtime. It cannot be tested without a Jotai provider wrapping the atom's store, and it cannot be reused in a non-Jotai context.
