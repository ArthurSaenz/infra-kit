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
- **Isolated testing** — Test each feature with mock props; no need to spin up other features
- **Predictable refactoring** — Changes inside a feature cannot break other features

---

## 3 Component Injection Patterns

### Pattern 1: Element (Pre-rendered Slot)

Pass a fully rendered `ReactElement` as a prop. The receiving feature places it without modification.

```tsx
// page.tsx — page renders both features, connects them via element prop
import { DashboardContainer } from '#root/features/dashboard'
import { NotificationBadge, notificationsService } from '#root/features/notifications'

export const DashboardPage = () => {
  const count = useAtomValue(notificationsService.$unreadCount)

  return (
    <DashboardContainer
      headerBadge={<NotificationBadge count={count} />}
    />
  )
}

// features/dashboard/containers/dashboard-container.tsx
interface DashboardContainerProps {
  headerBadge?: React.ReactElement
}

export const DashboardContainer = (props: DashboardContainerProps) => {
  const { headerBadge } = props

  return (
    <header>
      <h1>Dashboard</h1>
      {headerBadge}
    </header>
  )
}
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
// page.tsx
import { ProjectListContainer } from '#root/features/project-list'
import { UserAvatarComponent } from '#root/features/user-profile'

export const ProjectsPage = () => {
  return (
    <ProjectListContainer
      AvatarComponent={UserAvatarComponent}
    />
  )
}

// features/project-list/containers/project-list-container.tsx
interface ProjectListContainerProps {
  AvatarComponent?: React.ComponentType<{ userId: string; size?: 'sm' | 'md' }>
}

export const ProjectListContainer = (props: ProjectListContainerProps) => {
  const { AvatarComponent } = props

  const projects = useAtomValue(projectListService.$projects)

  return (
    <ul>
      {projects.map((project) => (
        <li key={project.id}>
          {AvatarComponent && (
            <AvatarComponent userId={project.ownerId} size="sm" />
          )}
          <span>{project.name}</span>
        </li>
      ))}
    </ul>
  )
}
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
// page.tsx
import { TaskBoardContainer } from '#root/features/task-board'
import { TaskCommentsContainer } from '#root/features/task-comments'

export const TaskBoardPage = () => {
  return (
    <TaskBoardContainer
      renderTaskDetail={(task) => (
        <div>
          <h2>{task.title}</h2>
          <TaskCommentsContainer taskId={task.id} />
        </div>
      )}
    />
  )
}

// features/task-board/containers/task-board-container.tsx
import type { Task } from '../types'

interface TaskBoardContainerProps {
  renderTaskDetail?: (task: Task) => React.ReactElement
}

export const TaskBoardContainer = (props: TaskBoardContainerProps) => {
  const { renderTaskDetail } = props

  const selectedTask = useAtomValue(taskBoardService.$selectedTask)

  return (
    <div className="board">
      <TaskListComponent tasks={tasks} />
      {selectedTask && renderTaskDetail?.(selectedTask)}
    </div>
  )
}
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
4. **Type extraction:** Use `@pkg/web-toolkit` utilities for type-safe prop definitions

### Full Example: Two Features Sharing Data

```tsx
// Page orchestrates both features
// app/pages/analytics-page.tsx
import { ChartContainer } from '#root/features/chart'
import { FilterContainer } from '#root/features/filter'
import { filterService } from '#root/features/filter'

export const AnalyticsPage = () => {
  const activeFilters = useAtomValue(filterService.$activeFilters)
  const setFilters = useSetAtom(filterService.$activeFilters)

  return (
    <div>
      <FilterContainer />
      <ChartContainer
        filters={activeFilters}
        onFilterReset={() => setFilters([])}
      />
    </div>
  )
}

// features/chart/containers/chart-container.tsx
// Does NOT import filterService — receives data via props
interface ChartContainerProps {
  filters: FilterConfig[]
  onFilterReset: () => void
}

export const ChartContainer = (props: ChartContainerProps) => {
  const { filters, onFilterReset } = props

  const chartData = useAtomValue(chartService.$chartData)

  useEffect(() => {
    // Use filters from props to fetch chart data
    chartService.fetchChartDataFx({ filters })
  }, [filters])

  return <ChartComponent data={chartData} onReset={onFilterReset} />
}
```

---

## Type Extraction

Use `@pkg/web-toolkit` type utilities to extract types from atoms without runtime imports.

### Variant 1: `ExtractedAtomType` — Read-Only Atom Value

Extract the value type `T` from `Atom<T>`. Use when passing atom values as props.

```typescript
import type { ExtractedAtomType } from '@pkg/web-toolkit'

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
import type { ExtractAtomActionArgs } from '@pkg/web-toolkit'

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
import type { ExtractAtomSetter } from '@pkg/web-toolkit'

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
// Shared state lives in one feature (the "owner")
// Other features receive it as props

// app/pages/workspace-page.tsx
import { SidebarContainer, sidebarService } from '#root/features/sidebar'
import { ContentContainer } from '#root/features/content'

export const WorkspacePage = () => {
  // Page reads from the owning feature's service
  const selectedItem = useAtomValue(sidebarService.$selectedItem)
  const setSelectedItem = useSetAtom(sidebarService.selectItemAtom)

  return (
    <div className="flex">
      <SidebarContainer />
      <ContentContainer
        selectedItem={selectedItem}
        onItemSelect={(id) => setSelectedItem({ itemId: id })}
      />
    </div>
  )
}
```

**Key principle:** One feature owns the state. The page reads it and distributes to others via props. Never duplicate state across features.

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
// ❌ BAD — Creates a new component on every render, destroys all internal state
<TaskBoard
  renderDetail={(task) => {
    const DetailView = () => <TaskComments taskId={task.id} />  // ❌ New component each render
    return <DetailView />
  }}
/>

// ✅ GOOD — Return JSX directly, no intermediate component
<TaskBoard
  renderDetail={(task) => (
    <TaskComments taskId={task.id} />
  )}
/>
```

**Why it breaks:** React sees a new component type each render → unmounts and remounts → loses all state, triggers effects, causes flicker.

### Mistake 2: Feature Importing Another Feature's Service

```tsx
// ❌ BAD — Direct cross-feature import
// features/dashboard/containers/dashboard-container.tsx
import { userService } from '#root/features/user'  // ❌ BLOCKING VIOLATION

export const DashboardContainer = () => {
  const user = useAtomValue(userService.$currentUser)  // ❌
  return <DashboardComponent user={user} />
}

// ✅ GOOD — Page passes the data
// app/pages/home-page.tsx
import { DashboardContainer } from '#root/features/dashboard'
import { userService } from '#root/features/user'

export const HomePage = () => {
  const user = useAtomValue(userService.$currentUser)
  return <DashboardContainer currentUser={user} />
}
```

**Why it breaks:** Creates a hidden dependency graph between features. Deleting the `user` feature would break `dashboard` with no compile-time warning in many cases.

### Mistake 3: Passing Atom References as Props

```tsx
// ❌ BAD — Passing the atom itself creates runtime coupling
<FeatureA userAtom={userService.$currentUser} />

// features/feature-a/containers/feature-a-container.tsx
const FeatureAContainer = ({ userAtom }) => {
  const user = useAtomValue(userAtom)  // ❌ Feature A now depends on Jotai atom from Feature B
  return <FeatureAComponent user={user} />
}

// ✅ GOOD — Pass the resolved value
<FeatureA currentUser={useAtomValue(userService.$currentUser)} />

// features/feature-a/containers/feature-a-container.tsx
const FeatureAContainer = ({ currentUser }) => {
  return <FeatureAComponent user={currentUser} />  // ✅ Plain data, no atom dependency
}
```

**Why it breaks:** The receiving feature becomes coupled to Jotai's runtime. It cannot be tested without a Jotai provider wrapping the atom's store, and it cannot be reused in a non-Jotai context.
