# Architectural Decision Trees

8 decision trees for recurring architectural choices. Each tree provides a flowchart, rationale, and concrete thresholds.

---

## 1. Dumb vs Smart Component

**Question:** Should this component be a dumb component (`*-component.tsx`) or a smart container (`*-container.tsx`)?

```
Does the component need to:
├─ Import Jotai atoms (useAtomValue, useSetAtom, useAtom)?
│  └─ YES → Smart container
├─ Call services or API functions?
│  └─ YES → Smart container
├─ Contain business logic (validation, transformation, calculations)?
│  └─ YES → Smart container
├─ Use useEffect for data fetching or side effects?
│  └─ YES → Smart container
└─ NONE of the above → Dumb component
   └─ Even if it uses: useState (UI toggle), useRef (DOM), useMemo, useCallback
```

### Edge Cases

| Scenario | Decision | Reason |
|----------|----------|--------|
| `useState` for form input value | Dumb | Controlled input is UI state |
| `useState` for submission state | Smart | Submission = business process |
| `useEffect` for focus management | Dumb | DOM manipulation, not business logic |
| `useEffect` for data fetching | Smart | Side effect with external dependency |
| `useMemo` to sort props data | Dumb | Derives from props, no external state |
| `useMemo` to combine atom + props | Smart | Requires atom access |

### When in Doubt

Default to **dumb**. Extract to container only when the component demonstrably needs external state or side effects. It's easier to promote a dumb component to a container than to extract logic out of a component that mixed concerns from the start.

---

## 2. services.ts vs services/ Folder

**Question:** Should this feature use a single `services.ts` file or a `services/` folder?

```
Count API endpoints in this feature:
├─ > 3 endpoints → services/ folder
└─ <= 3 endpoints
   └─ Estimate total lines (atoms + API calls + helpers):
      ├─ > 250 lines → services/ folder
      └─ <= 250 lines → services.ts (single file)
```

### services/ Folder Structure

```
services/
├─ main.ts   — Jotai atoms, orchestration logic, re-exports everything
├─ api.ts    — Pure API call functions (httpClient calls, URL construction)
└─ libs.ts   — Pure business logic (transformations, calculations, validation)
```

### Migration Trigger Checklist

Convert `services.ts` → `services/` when ANY is true:
- [ ] File exceeds 250 lines
- [ ] More than 3 API endpoints
- [ ] Business logic functions exceed 50 lines combined
- [ ] Multiple developers need to edit services simultaneously (merge conflict frequency)

### Migration Steps

1. Create `services/` folder with `main.ts`, `api.ts`, `libs.ts`
2. Move API call functions → `api.ts`
3. Move pure business logic → `libs.ts`
4. Move atoms and orchestration → `main.ts`
5. Add re-exports in `main.ts`: `export * from './api'` and `export * from './libs'` as needed
6. Update `index.ts` to import from `./services` (folder auto-resolves to `main.ts` or `index.ts`)
7. Verify all external imports still work

---

## 3. State Scope

**Question:** Where should this piece of state live?

```
Is the state purely visual (open/close, hover, scroll position, input focus)?
├─ YES → useState in the component that owns it
└─ NO → Is it derived from or used by service logic (API responses, computed values)?
   ├─ YES → Jotai atom in feature services
   └─ NO → Is it shared between multiple components in this feature?
      ├─ YES → Jotai atom in feature services
      └─ NO → Is it needed by other features?
         ├─ YES → Jotai atom in the owning feature + page-level prop distribution
         └─ NO → useState in the component (consider promoting if scope grows)
```

### State Scope Ladder

| Scope | Mechanism | Example |
|-------|-----------|---------|
| Single component, UI-only | `useState` / `useRef` | Dropdown open, tooltip position |
| Single component, form | `useState` or form library | Controlled inputs before submission |
| Multiple components, one feature | Jotai atom in services | Feature filter state, selected item |
| Multiple features | Jotai atom + page-level props | User data consumed by several features |
| App-wide | Jotai atom in shared service | Auth state, theme, locale |

### Anti-patterns

- **Prop drilling within a feature:** If passing props through 3+ component levels within one feature, use a Jotai atom in services instead
- **Atom for UI-only state:** Do not create a Jotai atom for a dropdown's open/close state — `useState` is simpler, local, and auto-cleaned on unmount
- **Global atoms for feature-specific state:** Do not put feature state in a global/shared atom; keep it in the feature's services

---

## 4. Props Interface vs Inline Type

**Question:** Should this component use a named `interface` or an inline type for props?

```
Is the component exported (part of public API)?
├─ YES → Named interface: {ComponentName}Props
└─ NO → Is the type reused elsewhere (tests, stories, other components)?
   ├─ YES → Named interface
   └─ NO → Are there > 3 properties?
      ├─ YES → Named interface (readability)
      └─ NO → Inline type is acceptable
         └─ e.g., (props: { label: string; onClick: () => void })
```

### Naming Convention

```typescript
// Public component → named interface
interface UserCardComponentProps {
  user: User
  onEdit: (userId: string) => void
  className?: string
}

// Internal helper with 1-2 props → inline is fine
const Divider = (props: { spacing?: 'sm' | 'md' }) => { ... }
```

### Rules

- Public components (exported in `index.ts`): ALWAYS named interface
- Test/story types reference the named interface: `const props: UserCardComponentProps = { ... }`
- Never use `type` keyword for component props — always `interface` (enables declaration merging if ever needed)

---

## 5. Shared Component vs Feature Component

**Question:** Should this component live in a shared location or inside a feature?

```
Is the component used by 3+ features?
├─ YES → Does it contain ZERO business logic?
│  ├─ YES → Shared component (e.g., packages/ui or shared/components)
│  └─ NO → Split: dumb part → shared, logic → each feature's container
└─ NO → Is it used by exactly 2 features?
   ├─ YES → Keep in one feature, pass to the other via injection pattern
   │        Promote to shared only if a 3rd consumer appears
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

Premature abstraction creates components that satisfy no consumer perfectly. With 3 consumers, the common patterns become clear, and the abstraction has a solid foundation. Two consumers might have coincidentally similar needs.

---

## 6. Component Splitting

**Question:** Should this component be split into smaller components?

```
Is the component > 150 lines?
├─ YES → Split it
└─ NO → Does it handle > 2 distinct visual sections?
   ├─ YES → Consider splitting by section
   └─ NO → Does the JSX tree have > 3 levels of nesting?
      ├─ YES → Extract nested sections into named subcomponents
      └─ NO → Keep as-is
```

### Splitting Strategies

| Symptom | Strategy |
|---------|----------|
| Long component with distinct sections | Extract each section into a subcomponent |
| Repeated JSX pattern | Extract into a mapped subcomponent |
| Complex conditional rendering | Extract each branch into a named component |
| Many event handlers | Group related handlers in a custom hook |

### Where to Place Subcomponents

- **Same file:** Private subcomponents used only by the parent (< 50 lines each)
- **Separate file, same directory:** Reusable within the feature but not exported
- **components/ directory:** If the subcomponent is a proper dumb component with its own tests/stories

### Naming for Subcomponents

```
Parent: UserProfileComponent
├─ UserProfileHeaderComponent (separate file if > 50 lines)
├─ UserProfileStatsComponent
└─ UserProfileActionsComponent
```

---

## 7. Error Handling Strategy

**Question:** What error handling approach should this code use?

```
What type of error?
├─ Network error (fetch failure, timeout, 5xx)
│  └─ Catch in service api.ts → set $error atom → container shows ErrorMessage
├─ Validation error (user input, 4xx with field errors)
│  └─ Parse response → set field-level error atoms → dumb component shows inline errors
├─ ServerError (status 570)
│  └─ Catch specifically: if (error instanceof ServerError) → show error.message to user
│     ServerError contains user-facing messages from the backend
├─ Unexpected error (programming bug, unhandled case)
│  └─ Let it propagate → React error boundary catches → Sentry reports
└─ Optimistic update failure
   └─ Rollback atom to previous value → show toast notification
```

### Error Handling Layers

| Layer | Responsibility | Mechanism |
|-------|----------------|-----------|
| `api.ts` | Throw on non-OK responses, parse error bodies | `httpClient` + `ServerError` check |
| `main.ts` (atoms) | Catch errors, update `$error` atom, optionally rollback | try/catch in `Fx` atoms |
| Container | Read `$error`, render appropriate UI | Guard clause pattern (Rule 7) |
| Error Boundary | Catch uncaught errors, prevent white screen | React error boundary component |
| Sentry | Report unexpected errors for debugging | Automatic capture via boundary |

### ServerError Pattern

```typescript
import { ServerError } from '#root/lib/http-client'

// In api.ts — httpClient already throws ServerError for status 570
export const updateUser = async (args: UpdateUserArgs) => {
  return httpClient.put(`/api/users/${args.userId}`, { body: args.data })
}

// In main.ts — catch and handle
export const updateUserFx = atom(null, async (get, set, args: UpdateUserFxArgs) => {
  try {
    const result = await updateUser(args)
    set($userData, result)
  } catch (error) {
    if (error instanceof ServerError) {
      // ServerError has a user-facing message from the backend
      set($error, error.message)
    } else {
      // Unexpected error — set generic message, let Sentry capture
      set($error, 'An unexpected error occurred')
      throw error  // Re-throw for error boundary / Sentry
    }
  }
})
```

---

## 8. Optimistic Updates

**Question:** Should this action use optimistic updates?

```
Is the action user-initiated (click, submit, toggle)?
├─ NO → Standard async flow (loading → success/error)
└─ YES → Is the expected success rate > 95%?
   ├─ NO → Standard async flow (risky actions need confirmation, not optimism)
   └─ YES → Is the UI change immediately visible and meaningful?
      ├─ NO → Standard async flow (no UX benefit)
      └─ YES → Optimistic update
         └─ Apply immediately, rollback on failure, show toast on error
```

### When to Use Optimistic Updates

| Action | Optimistic? | Reason |
|--------|-------------|--------|
| Toggle favorite/bookmark | Yes | High success rate, instant visual feedback |
| Like/unlike | Yes | High success rate, instant visual feedback |
| Reorder list items (drag) | Yes | Lag during drag feels broken |
| Delete item | No | Destructive, hard to undo visually |
| Submit form | No | Complex validation, moderate failure rate |
| File upload | No | Long operation, progress tracking needed |
| Payment/checkout | No | Critical action, must confirm success |

### Optimistic Update Pattern

```typescript
// In main.ts
export const toggleFavoriteFx = atom(null, async (get, set, args: ToggleFavoriteFxArgs) => {
  const { itemId } = args
  const previousItems = get($items)

  // 1. Apply optimistically
  set($items, (items) =>
    items.map((item) =>
      item.id === itemId ? { ...item, isFavorite: !item.isFavorite } : item
    )
  )

  try {
    // 2. Send to server
    await toggleFavoriteApi({ itemId })
  } catch (error) {
    // 3. Rollback on failure
    set($items, previousItems)
    // 4. Notify user
    set($toastMessage, 'Failed to update. Please try again.')
  }
})
```

### Rollback Strategy

1. **Capture previous state** before applying the optimistic change
2. **Apply the change** immediately to the atom
3. **Send the request** to the server
4. **On failure:** Restore the captured state and show a non-intrusive notification (toast)
5. **On success:** No action needed (state already reflects the correct value)
