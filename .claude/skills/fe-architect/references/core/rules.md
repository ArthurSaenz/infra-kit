# Enforcement Rules

These 7 rules are **BLOCKING** — fail immediately if violated. Each rule includes examples and a fix recipe.

---

## 1. No Cross-Feature Imports

**Rule:** Features NEVER import from other features (except `import type`).

**Violation:**
```typescript
// features/feature-a/containers/feature-a-container.tsx
import { featureBService } from '#root/features/feature-b'  // ❌ BLOCKING
import { UserCard } from '#root/features/user-profile'      // ❌ BLOCKING
```

**Fix:** Pass data via props at page level:
```typescript
// app/pages/some-page.tsx — page orchestrates features
import { FeatureAContainer } from '#root/features/feature-a'
import { featureBService } from '#root/features/feature-b'

export const SomePage = () => {
  const data = useAtomValue(featureBService.$data)
  return <FeatureAContainer externalData={data} />
}
```

**Type-only imports ARE allowed** (no runtime dependency):
```typescript
import type { FeatureBData } from '#root/features/feature-b'  // ✅ OK
```

### Cross-Feature Communication Patterns

Features compose at the page level using three patterns:

**When to use which:**

| Pattern | Use When | Prop Type |
|---------|----------|-----------|
| Element | Simple slot, no customization needed (icons, badges) | `React.ReactElement` |
| Component | Parent needs to control props | `React.ComponentType<Props>` |
| Render Function | Full control over what/how to render | `(props) => ReactElement` |

**Element Pattern** — Pass pre-rendered components as slots:
```tsx
// page.tsx — page renders FeatureB and passes it to FeatureA
<FeatureAContainer headerIcon={<FeatureBBadge count={5} />} />

// features/feature-a/containers/feature-a-container.tsx
interface FeatureAContainerProps {
  headerIcon?: React.ReactElement  // ← pre-rendered, just place it
}
export const FeatureAContainer = (props: FeatureAContainerProps) => {
  const { headerIcon } = props
  return <header>{headerIcon}</header>
}
```

**Component Pattern** — Pass component type, container controls props:
```tsx
// page.tsx
<FeatureAContainer SidebarComponent={FeatureBList} />

// features/feature-a/containers/feature-a-container.tsx
interface FeatureAContainerProps {
  SidebarComponent?: React.ComponentType<{ items: string[] }>  // ← FeatureA decides props
}
export const FeatureAContainer = (props: FeatureAContainerProps) => {
  const { SidebarComponent } = props
  const items = useAtomValue(featureAService.$sidebarItems)
  return SidebarComponent ? <SidebarComponent items={items} /> : null
}
```

**Render Function Pattern** — Full control over rendering:
```tsx
// page.tsx
<FeatureAContainer renderSection={(data) => <FeatureBForm initialData={data} />} />

// features/feature-a/containers/feature-a-container.tsx
interface FeatureAContainerProps {
  renderSection?: (data: SectionData) => React.ReactElement
}
export const FeatureAContainer = (props: FeatureAContainerProps) => {
  const { renderSection } = props
  const data = useAtomValue(featureAService.$sectionData)
  return renderSection ? renderSection(data) : <DefaultSection data={data} />
}
```

### Type Extraction Across Features

Use `@pkg/web-toolkit` utilities for type-safe cross-feature props:

```typescript
import type { ExtractedAtomType, ExtractWriteOnlyAtomArgs, ExtractAtomSetter } from '@pkg/web-toolkit'

interface FeatureAContainerProps {
  // Read-only atom value
  userData: ExtractedAtomType<typeof import('#root/features/feature-b').featureBService.$userData>
  // Write-only atom args
  onUpdate: (args: ExtractWriteOnlyAtomArgs<typeof import('#root/features/feature-b').featureBService.updateUserFx>) => void
  // Read-write atom setter
  onFilterChange: ExtractAtomSetter<typeof import('#root/features/feature-c').featureCService.$filterAtom>
}
```

---

## 2. Service Export Naming

**Rule:** Service exports MUST follow `[featureName]Service` pattern.

**Violation → Fix:**
```typescript
export * as service from './services'              // ❌ Too generic
export * as userService from './services'           // ❌ Ambiguous
export * as userProfileService from './services'    // ✅ [featureName]Service
```

**Pattern:** Convert kebab-case folder → camelCase + "Service": `user-profile/` → `userProfileService`

---

## 3. Atom `$` Prefix

**Rule:** All state atoms and derived atoms MUST have `$` prefix.

**Violation → Fix:**
```typescript
export const data = atom(null)          // ❌ Missing $
export const $data = atom(null)         // ✅

export const isLoading = atom(false)    // ❌ Missing $
export const $isLoading = atom(false)   // ✅
```

---

## 4. Async Write-Only `Fx` Suffix

**Rule:** Async write-only atoms MUST have `Fx` suffix. Sync write-only atoms use `Atom` suffix.

**Violation → Fix:**
```typescript
export const getUser = atom(null, async (get, set) => {})     // ❌ Missing Fx
export const getUserFx = atom(null, async (get, set) => {})   // ✅

export const resetData = atom(null, (get, set) => {})         // ❌ Missing Atom
export const resetDataAtom = atom(null, (get, set) => {})     // ✅
```

---

## 5. Object Arguments for Write-Only Atoms

**Rule:** Write-only atoms MUST use object arguments with a typed interface. No direct primitives.

**Violation → Fix:**
```typescript
// ❌ Direct primitive
export const getUserFx = atom(null, async (get, set, userId: string) => {})

// ❌ Inline type
export const getUserFx = atom(null, async (get, set, args: { userId: string }) => {})

// ✅ Typed interface
interface GetUserFxArgs {
  userId: string
}
export const getUserFx = atom(null, async (get, set, args: GetUserFxArgs) => {
  const { userId } = args
})
```

**Interface naming:** `{AtomName}Args` (e.g., `GetUserFxArgs`, `UpdateUserFxArgs`)

---

## 6. Dumb Component `className` + `cn()`

**Rule:** ALL dumb components MUST accept optional `className` prop and use `cn()` utility.

**Violation → Fix:**
```typescript
// ❌ Missing className prop and cn()
export const UserCard = (props: { user: User }) => {
  return <div className="card">{props.user.name}</div>
}

// ✅ className prop + cn() utility
import { cn } from '#root/lib/utils'

interface UserCardComponentProps {
  user: User
  className?: string  // ALWAYS required
}

export const UserCardComponent = (props: UserCardComponentProps) => {
  const { user, className } = props
  return <div className={cn('card', className)}>{user.name}</div>
  //                                ^^^^^^^^^ className ALWAYS last in cn()
}
```

**Additional dumb component rules:**
- ❌ NO Jotai atoms, services, API calls, or business logic imports
- ✅ Props in, JSX out only
- ✅ MUST have tests in feature-root `__tests__/` and stories in feature-root `__stories__/`

---

## 7. Container State Handling

**Rule:** Smart components MUST handle loading, error, and empty states before rendering.

**Violation → Fix:**
```typescript
// ❌ Missing state guards
export const UserContainer = () => {
  const data = useAtomValue(service.$data)
  return <UserComponent data={data} />  // Crashes if data is null
}

// ✅ All states handled
export const UserContainer = () => {
  const data = useAtomValue(service.$data)
  const isLoading = useAtomValue(service.$isLoading)
  const error = useAtomValue(service.$error)

  if (isLoading) return <LoadingSpinner />
  if (error) return <ErrorMessage error={error} />
  if (!data) return <EmptyState message="No data" />

  return <UserComponent data={data} />
}
```

---

## Naming Conventions Quick Reference

| Element | Format | Example |
|---|---|---|
| Feature folder | kebab-case | `user-profile/` |
| Dumb component file | `[name]-component.tsx` | `user-card-component.tsx` |
| Smart component file | `[name]-container.tsx` | `user-card-container.tsx` |
| Dumb component export | PascalCase + Component | `UserCardComponent` |
| Smart component export | PascalCase + Container | `UserCardContainer` |
| State/derived atom | `$` + camelCase | `$userData`, `$isLoading` |
| Async write-only atom | camelCase + `Fx` | `getUserFx`, `updateUserFx` |
| Sync write-only atom | camelCase + `Atom` | `resetDataAtom` |
| Atom args interface | `{AtomName}Args` | `GetUserFxArgs` |
| Service export | `[featureName]Service` | `userProfileService` |
| Props interface | `{ComponentName}Props` | `UserCardComponentProps` |
| Test file | `[name].test.tsx` | `user-card-component.test.tsx` |
| Story file | `[name].stories.tsx` | `user-card-component.stories.tsx` |
| Types file | `types.ts` | Always lowercase |
| Index file | `index.ts` | Always lowercase |

### Props Destructuring

Always add a blank line after destructuring props:
```typescript
export const UserCardComponent = (props: UserCardComponentProps) => {
  const { user, onEdit, className } = props

  return (...)  // blank line above
}
```

---

## Enforcement Workflow

When a violation is detected:

1. **STOP** execution immediately
2. **Identify** the specific rule violated
3. **Show** the problematic code
4. **Provide** the fix using the recipe above
5. **Do not proceed** until resolved
