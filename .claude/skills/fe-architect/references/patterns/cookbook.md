# Pattern Cookbook

Practical recipes for common feature implementations.

---

## CRUD Pattern

**Use case:** Tasks, notes, bookmarks — full create/read/update/delete.

### Types

```typescript
export interface Task {
  id: string
  title: string
  description: string
  completed: boolean
  createdAt: string
}

export interface CreateTaskFxArgs { title: string; description: string }
export interface UpdateTaskFxArgs { taskId: string; updates: Partial<Omit<Task, 'id' | 'createdAt'>> }
export interface DeleteTaskFxArgs { taskId: string }
```

### Services

```typescript
export const $tasks = atom<Task[]>([])
export const $isLoading = atom(false)
export const $error = atom<Error | null>(null)
export const $completedCount = atom((get) => get($tasks).filter((t) => t.completed).length)

export const getTasksFx = atom(null, async (get, set) => {
  set($isLoading, true)
  set($error, null)
  try {
    const response = await httpClient.fetch<Task[]>('/api/tasks', { method: 'GET' })
    set($tasks, response.body)
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoading, false)
  }
})

export const createTaskFx = atom(null, async (get, set, args: CreateTaskFxArgs) => {
  set($isLoading, true)
  set($error, null)
  try {
    const response = await httpClient.fetch<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(args) })
    set($tasks, [...get($tasks), response.body])
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoading, false)
  }
})

export const updateTaskFx = atom(null, async (get, set, args: UpdateTaskFxArgs) => {
  set($isLoading, true)
  set($error, null)
  try {
    const response = await httpClient.fetch<Task>(`/api/tasks/${args.taskId}`, { method: 'PATCH', body: JSON.stringify(args.updates) })
    set($tasks, get($tasks).map((t) => (t.id === args.taskId ? response.body : t)))
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoading, false)
  }
})

export const deleteTaskFx = atom(null, async (get, set, args: DeleteTaskFxArgs) => {
  set($isLoading, true)
  set($error, null)
  try {
    await httpClient.fetch<void>(`/api/tasks/${args.taskId}`, { method: 'DELETE' })
    set($tasks, get($tasks).filter((t) => t.id !== args.taskId))
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoading, false)
  }
})
```

### Container Pattern

```tsx
const tasks = useAtomValue(service.$tasks)
const isLoading = useAtomValue(service.$isLoading)
const error = useAtomValue(service.$error)
const getTasks = useSetAtom(service.getTasksFx)
const createTask = useSetAtom(service.createTaskFx)
const updateTask = useSetAtom(service.updateTaskFx)
const deleteTask = useSetAtom(service.deleteTaskFx)

useEffect(() => { getTasks() }, [getTasks])

// Pass callbacks to dumb components:
const handleToggle = (taskId: string, completed: boolean) => updateTask({ taskId, updates: { completed } })
const handleDelete = (taskId: string) => deleteTask({ taskId })
```

---

## List with Search & Filters

**Use case:** Product catalog, user directory, search results.

### Filter State Atoms

```typescript
export const $allProducts = atom<Product[]>([])
export const $searchQuery = atom('')
export const $selectedCategory = atom<string | null>(null)
export const $inStockOnly = atom(false)
export const $priceRange = atom({ min: 0, max: 1000 })

export const $filteredProducts = atom((get) => {
  const products = get($allProducts)
  const search = get($searchQuery).toLowerCase()
  const category = get($selectedCategory)
  const inStockOnly = get($inStockOnly)
  const { min, max } = get($priceRange)

  return products.filter((product) => {
    const matchesSearch = product.name.toLowerCase().includes(search)
    const matchesCategory = !category || product.category === category
    const matchesStock = !inStockOnly || product.inStock
    const matchesPrice = product.price >= min && product.price <= max
    return matchesSearch && matchesCategory && matchesStock && matchesPrice
  })
})

export const $categories = atom((get) => {
  const products = get($allProducts)
  return Array.from(new Set(products.map((p) => p.category))).sort()
})

export const resetFiltersAtom = atom(null, (get, set) => {
  set($searchQuery, '')
  set($selectedCategory, null)
  set($inStockOnly, false)
  set($priceRange, { min: 0, max: 1000 })
})
```

---

## Form with Validation

**Use case:** Registration, settings, contact forms.

### Validation Logic (services/libs.ts)

```typescript
export const validateForm = (data: FormData): FormErrors => {
  const errors: FormErrors = {}
  if (!data.email) errors.email = 'Email is required'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = 'Invalid email format'
  if (!data.password) errors.password = 'Password is required'
  else if (data.password.length < 8) errors.password = 'Password must be at least 8 characters'
  if (data.password !== data.confirmPassword) errors.confirmPassword = 'Passwords do not match'
  return errors
}
```

### Form Component Pattern

```tsx
const [formData, setFormData] = useState<FormData>({ email: '', password: '', confirmPassword: '' })
const [errors, setErrors] = useState<FormErrors>({})
const [touched, setTouched] = useState<Set<string>>(new Set())

const handleBlur = (field: string) => {
  setTouched((prev) => new Set(prev).add(field))
  setErrors(validateForm(formData))
}

const showError = (field: string) => touched.has(field) && errors[field]

// In JSX:
<input onBlur={() => handleBlur('email')} className={cn(showError('email') && 'border-red-500')} />
{showError('email') && <p className="text-red-500 text-sm">{errors.email}</p>}
```

---

## Multi-Step Wizard

**Use case:** Onboarding, checkout, registration flows.

### Step State Management

```typescript
export const $currentStep = atom<1 | 2 | 3>(1)
export const $step1Data = atom<Step1Data | null>(null)
export const $step2Data = atom<Step2Data | null>(null)
export const $step3Data = atom<Step3Data | null>(null)

export const $canProceed = atom((get) => {
  const step = get($currentStep)
  if (step === 1) return get($step1Valid)
  if (step === 2) return get($step2Valid)
  if (step === 3) return get($step3Valid)
  return false
})

export const $progress = atom((get) => (get($currentStep) / 3) * 100)

export const nextStepAtom = atom(null, (get, set) => {
  const current = get($currentStep)
  if (get($canProceed) && current < 3) set($currentStep, (current + 1) as 1 | 2 | 3)
})

export const previousStepAtom = atom(null, (get, set) => {
  const current = get($currentStep)
  if (current > 1) set($currentStep, (current - 1) as 1 | 2 | 3)
})
```

### Container Pattern

```tsx
{currentStep === 1 && <Step1Component initialData={step1Data} onSubmit={handleStep1} />}
{currentStep === 2 && <Step2Component initialData={step2Data} onSubmit={handleStep2} onBack={previousStep} />}
{currentStep === 3 && <Step3Component initialData={step3Data} onSubmit={handleStep3} onBack={previousStep} isSubmitting={isSubmitting} />}
```

---

## Optimistic UI with Rollback

**Use case:** Like buttons, toggles, instant feedback actions.

```typescript
export interface LikePostFxArgs { postId: string }

export const likePostFx = atom(null, async (get, set, args: LikePostFxArgs) => {
  const posts = get($posts)
  const post = posts.find((p) => p.id === args.postId)
  if (!post) return

  // 1. Save previous state
  const previousValue = { ...post }
  const newValue = {
    ...post,
    isLikedByUser: !post.isLikedByUser,
    likeCount: post.isLikedByUser ? post.likeCount - 1 : post.likeCount + 1,
  }

  // 2. Apply optimistic update
  set($posts, posts.map((p) => (p.id === args.postId ? newValue : p)))

  try {
    // 3. Make API call
    const response = await httpClient.fetch<Post>(`/api/posts/${args.postId}/like`, { method: 'POST' })
    // 4. Update with server response
    set($posts, get($posts).map((p) => (p.id === args.postId ? response.body : p)))
  } catch (err) {
    // 5. Rollback on error
    set($posts, get($posts).map((p) => (p.id === args.postId ? previousValue : p)))
    set($error, err as Error)
    throw err
  }
})
```

---

## Infinite Scroll / Pagination

**Use case:** Social feeds, search results, image galleries.

### Cursor-Based Pagination

```typescript
export const $allItems = atom<FeedItem[]>([])
export const $nextCursor = atom<string | null>(null)
export const $hasMore = atom(true)
export const $isLoadingInitial = atom(false)
export const $isLoadingMore = atom(false)

export const loadInitialFx = atom(null, async (get, set) => {
  set($isLoadingInitial, true)
  try {
    const response = await httpClient.fetch<PageData>('/api/feed?limit=20', { method: 'GET' })
    set($allItems, response.body.items)
    set($nextCursor, response.body.nextCursor)
    set($hasMore, response.body.hasMore)
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoadingInitial, false)
  }
})

export interface LoadMoreFxArgs { cursor: string }

export const loadMoreFx = atom(null, async (get, set, args: LoadMoreFxArgs) => {
  if (get($isLoadingMore) || !get($hasMore)) return
  set($isLoadingMore, true)
  try {
    const response = await httpClient.fetch<PageData>(`/api/feed?cursor=${args.cursor}&limit=20`, { method: 'GET' })
    set($allItems, [...get($allItems), ...response.body.items])
    set($nextCursor, response.body.nextCursor)
    set($hasMore, response.body.hasMore)
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoadingMore, false)
  }
})
```

### IntersectionObserver Trigger

```tsx
export const InfiniteScrollTrigger = ({ onIntersect, isLoading, hasMore }) => {
  const observerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && hasMore && !isLoading) onIntersect() },
      { threshold: 0.1 }
    )
    const current = observerRef.current
    if (current) observer.observe(current)
    return () => { if (current) observer.unobserve(current) }
  }, [onIntersect, isLoading, hasMore])

  return <div ref={observerRef} className="h-20 flex items-center justify-center">
    {isLoading && <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />}
  </div>
}
```

---

## Cross-Feature Communication

Features compose at the page level. See [rules.md](../core/rules.md) for patterns.

```tsx
// pages/project-dashboard.tsx — page orchestrates 3 features
import { ProjectHeaderContainer, projectService } from '#root/features/project'
import { TaskListContainer } from '#root/features/task-list'
import { TeamMembersContainer, teamService } from '#root/features/team-members'

export const ProjectDashboardPage = () => {
  // Read from one feature's service to pass data to another
  const project = useAtomValue(projectService.$currentProject)
  const memberCount = useAtomValue(teamService.$memberCount)

  return (
    <div className="grid grid-cols-3 gap-6">
      {/* Data wiring: pass service data as props */}
      <ProjectHeaderContainer memberCount={memberCount} />

      {/* Component injection: pass a feature as a renderable slot */}
      <TaskListContainer
        projectId={project?.id}
        renderAssignee={(userId) => <TeamMembersContainer userId={userId} variant="avatar" />}
      />
    </div>
  )
}
```

---

## Authentication Flow

**Use case:** Login/logout, protected routes, token management.

### Auth State

```typescript
import { atomWithStorage } from 'jotai/utils'

export const $authToken = atomWithStorage<AuthToken | null>('auth-token', null)
export const $currentUser = atom<User | null>(null)
export const $isAuthenticated = atom((get) => {
  const token = get($authToken)
  return token ? token.expiresAt > Date.now() : false
})
export const $isAdmin = atom((get) => get($currentUser)?.role === 'admin')
```

### Login Effect

```typescript
export interface LoginFxArgs { credentials: { email: string; password: string }; redirectTo?: string }

export const loginFx = atom(null, async (get, set, args: LoginFxArgs) => {
  set($isLoading, true)
  set($error, null)
  try {
    const response = await httpClient.fetch<{ user: User; token: AuthToken }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(args.credentials),
    })
    set($authToken, response.body.token)
    set($currentUser, response.body.user)
    if (args.redirectTo) window.location.href = args.redirectTo
  } catch (err) {
    set($error, err as Error)
    throw err
  } finally {
    set($isLoading, false)
  }
})
```

### Protected Route Component

```tsx
export const ProtectedRouteComponent = (props) => {
  const { isAuthenticated, currentUser, requiredRole, redirectTo = '/login', onRedirect, children } = props

  useEffect(() => {
    if (!isAuthenticated) {
      const currentUrl = window.location.pathname + window.location.search
      onRedirect(`${redirectTo}?redirect=${encodeURIComponent(currentUrl)}`)
    } else if (requiredRole && currentUser?.role !== requiredRole) {
      onRedirect('/unauthorized')
    }
  }, [isAuthenticated, currentUser, requiredRole, redirectTo, onRedirect])

  if (!isAuthenticated) return <div>Redirecting to login...</div>
  if (requiredRole && currentUser?.role !== requiredRole) return <div>Unauthorized</div>
  return <>{children}</>
}
```
