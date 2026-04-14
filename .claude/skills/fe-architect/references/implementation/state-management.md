# State Management with Jotai

## Atom Types

| Type | Naming | Example | Purpose |
|---|---|---|---|
| State atom | `$` prefix | `$data`, `$isLoading` | Store data |
| Derived atom | `$` prefix | `$userName`, `$hasData` | Computed values |
| Async write-only | `Fx` suffix | `getUserFx` | API calls, side effects |
| Sync write-only | `Atom` suffix | `resetDataAtom` | State resets, toggles |

## Basic Patterns

### State Atoms
```typescript
export const $data = atom<Data | null>(null)        // Always provide type
export const $isLoading = atom<boolean>(false)
export const $error = atom<Error | null>(null)
```

### Derived Atoms
```typescript
export const $userName = atom((get) => {
  const data = get($data)
  return data ? data.name : 'Unknown'
})

export const $hasData = atom((get) => get($data) !== null)

export const $filteredUsers = atom((get) => {
  const users = get($users)
  const filter = get($filter)
  return users.filter(u => applyFilter(u, filter))
})
```

### Async Write-Only (Fx)
```typescript
interface GetDataFxArgs { dataId: string }

export const getDataFx = atom(
  null,
  async (get, set, args: GetDataFxArgs) => {
    try {
      set($isLoading, true)
      set($error, null)
      const response = await httpClient.fetch(`/api/data/${args.dataId}`, { method: 'GET' })
      set($data, response.body)
    } catch (error) {
      set($error, error.message)
    } finally {
      set($isLoading, false)
    }
  }
)
```

### Sync Write-Only (Atom)
```typescript
export const resetDataAtom = atom(null, (get, set) => {
  set($data, null)
  set($error, null)
})

export const toggleModeAtom = atom(null, (get, set) => {
  set($mode, get($mode) === 'light' ? 'dark' : 'light')
})
```

## Using Atoms in Components

```tsx
// Read-only (preferred when you don't need setter)
const data = useAtomValue(service.$data)

// Write-only (for effects/actions)
const getData = useSetAtom(service.getDataFx)

// Read + write (when you need both)
const [data, setData] = useAtom(service.$data)
```

## Atoms vs Local State

**Use Jotai atoms when:** State shared across components, persists beyond lifecycle, part of business logic, accessed in services.

**Use `useState` when:** UI-only state (modal open/close, hover, accordion), single component, not business logic.

## Organization

Group atoms in services files with clear sections:
```typescript
// ===== STATE ATOMS =====
// ===== DERIVED ATOMS =====
// ===== WRITE-ONLY ATOMS =====
```

## Optimistic Updates

```typescript
export const toggleTaskFx = atom(null, async (get, set, args: ToggleTaskFxArgs) => {
  const tasks = get($tasks)
  // Optimistic update
  set($tasks, tasks.map(t => t.id === args.taskId ? { ...t, completed: !t.completed } : t))
  try {
    const response = await httpClient.fetch(`/api/tasks/${args.taskId}/toggle`, { method: 'PATCH' })
    set($tasks, tasks.map(t => t.id === args.taskId ? response.body : t))
  } catch (error) {
    set($tasks, tasks) // Rollback
    set($error, error.message)
  }
})
```

## Best Practices

- Always provide type annotations: `atom<Data | null>(null)`
- Always use object arguments with typed interfaces for write-only atoms
- Create new objects/arrays, never mutate: `set($tasks, [...tasks, newTask])`
- Use `useAtomValue` when you only need to read (better performance)
- Use derived atoms for frequently computed values (auto-memoized)
- Split large atoms into smaller ones (components only re-render when their atoms change)
