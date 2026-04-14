# Migration & Refactoring Guide

## Scenario 1: Standalone Component → Feature

**When:** Component >200 lines, manages own state/API calls, used in multiple pages.

### Before

```tsx
// components/UserProfile.tsx (350 lines — state, API, UI all mixed)
export const UserProfile = ({ userId }: { userId: string }) => {
  const [user, setUser] = useState(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    setIsLoading(true)
    apiClient.getUser(userId).then(setUser).finally(() => setIsLoading(false))
  }, [userId])

  if (isLoading) return <div>Loading...</div>
  return <div>{user?.name}</div>
}
```

### After

```
features/user-profile/
├── index.ts           # Public API
├── types.ts           # UserProfileData, GetUserFxArgs, UpdateUserFxArgs
├── services.ts        # $userData, $isLoading, $error, getUserFx, updateUserFx
├── components/
│   └── user-profile-component.tsx  # Props in → JSX out
└── containers/
    └── user-profile-container.tsx  # Jotai atoms + state guards
```

### Steps

1. Create feature folder
2. Extract types to `types.ts`
3. Move state + API logic to `services.ts` with Jotai atoms
4. Create dumb component (UI only, className prop, cn())
5. Create container (loading/error/empty guards)
6. Create `index.ts` public API
7. Add tests + stories
8. Update page imports

---

## Scenario 2: Large Feature → Split

**When:** Feature has >5 components, handles >3 business domains, services.ts >250 lines.

### Before

```
features/dashboard/
├── services.ts (400 lines!)
├── components/ (user-stats, activity-feed, settings, notifications)
└── containers/dashboard-container.tsx (300 lines!)
```

### After

```
features/user-stats/       # Independent feature
features/activity-feed/    # Independent feature
features/settings-panel/   # Independent feature

pages/dashboard.tsx         # Composes features at page level
```

### Steps

1. Identify distinct business domains
2. Create new feature folder for each
3. Move types, services, components, containers
4. Replace cross-feature dependencies with page-level composition
5. Update tests

---

## Scenario 3: services.ts → services/ Folder

**When:** services.ts >250 lines or 3+ API endpoints.

### Before

```tsx
// services.ts (300 lines — atoms, API calls, helpers all mixed)
```

### After

```
services/
├── main.ts    # Atoms + orchestration, re-exports all
├── api.ts     # Pure API functions (httpClient calls)
├── libs.ts    # Pure business logic (validation, formatting)
└── index.ts   # export * from './main'
```

**api.ts** — pure functions, no atoms:
```typescript
export async function fetchBookings(): Promise<Booking[]> {
  const response = await httpClient.fetch<Booking[]>('/api/bookings', { method: 'GET' })
  return response.body
}
```

**main.ts** — atoms that call api functions:
```typescript
export const getBookingsFx = atom(null, async (get, set) => {
  set($isLoading, true)
  try {
    const data = await api.getBookings()
    set($bookings, data)
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoading, false)
  }
})
```

---

## Scenario 4: Extracting Shared Components

**When:** Component duplicated across 3+ features, has ZERO business logic.

### Steps

1. Verify component is purely presentational
2. Create `shared/components/[component-name]/`
3. Add TypeScript types, className prop, cn()
4. Add tests + stories
5. Update all features to import from shared
6. Delete duplicated files

---

## Common Pitfalls

### Circular Dependencies

**Problem:** Feature A imports Feature B, Feature B imports Feature A.
**Fix:** Compose at page level only. Features never import each other (except `import type`).

### Business Logic in Dumb Components

**Problem:** API calls, useEffect, useState for business data in dumb components.
**Fix:** Move all logic to container. Dumb component = props in, JSX out.

### Importing Internal Feature Files

**Problem:** `import { $userData } from '#root/features/user-profile/services'`
**Fix:** Always import from public API: `import { userProfileService } from '#root/features/user-profile'`

### Missing Type-Only Imports

**Problem:** `import { FeatureAData } from '#root/features/feature-a'` (runtime import)
**Fix:** `import type { FeatureAData } from '#root/features/feature-a'`

---

## Migration Strategy for Large Codebases

1. **Incremental over big-bang** — migrate one feature at a time
2. **New features first** — start new work in feature pattern
3. **Bug fixes next** — refactor during bug fixes
4. **Stable features last** — don't touch what works unless needed
5. **No behavior changes** — refactoring must not change functionality
6. **Tests before refactoring** — add tests to existing code first

### Decision Matrix

| Current State | Target State | Scenario |
|---|---|---|
| Large component (>200 lines) | Feature | Scenario 1 |
| Large feature (>5 components) | Multiple features | Scenario 2 |
| services.ts (>250 lines) | services/ folder | Scenario 3 |
| Duplicated component (3+ features) | Shared component | Scenario 4 |
