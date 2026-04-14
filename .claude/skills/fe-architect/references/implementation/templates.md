# Feature Component Templates

Complete code templates for implementing features.

---

## Types Template

```typescript
// features/[feature-name]/types.ts

// DATA MODELS
export interface FeatureNameData {
  id: string
  name: string
}

// COMPONENT PROPS (dumb components MUST include className?)
export interface FeatureNameComponentProps {
  data: FeatureNameData
  onAction?: () => void
  className?: string
}

// CONTAINER PROPS
export interface FeatureNameContainerProps {
  dataId: string
  className?: string
}

// ATOM ARGUMENTS (ALWAYS use object with typed interface)
export interface GetFeatureNameFxArgs {
  dataId: string
}

export interface UpdateFeatureNameFxArgs {
  dataId: string
  updates: Partial<FeatureNameData>
}
```

---

## Dumb Component Template

```tsx
// features/[feature-name]/components/[name]-component.tsx
import { cn } from '#root/lib/utils'
import type { FeatureNameComponentProps } from '../types'

export const FeatureNameComponent = (props: FeatureNameComponentProps) => {
  const { data, onAction, className } = props

  return (
    <div className={cn('rounded-lg border p-4', className)}>
      <h3 className="text-lg font-bold">{data.name}</h3>
      {onAction && (
        <button onClick={onAction} className="mt-4 rounded bg-blue-600 px-4 py-2 text-white">
          Action
        </button>
      )}
    </div>
  )
}
```

**Rules:** No business logic, no API calls, no Jotai imports. Props in → JSX out. Must have tests + stories.

---

## Smart Component Template

```tsx
// features/[feature-name]/containers/[name]-container.tsx
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import * as service from '../services'
import { FeatureNameComponent } from '../components/feature-name-component'

interface FeatureNameContainerProps {
  dataId: string
  className?: string
}

export const FeatureNameContainer = (props: FeatureNameContainerProps) => {
  const { dataId, className } = props

  const data = useAtomValue(service.$data)
  const isLoading = useAtomValue(service.$isLoading)
  const error = useAtomValue(service.$error)
  const getData = useSetAtom(service.getDataFx)

  useEffect(() => {
    getData({ dataId })
  }, [dataId, getData])

  // REQUIRED: Handle all states
  if (isLoading) return <LoadingSpinner className={className} />
  if (error) return <ErrorMessage error={error} className={className} />
  if (!data) return <EmptyState message="No data found" className={className} />

  return <FeatureNameComponent data={data} className={className} />
}
```

**Rules:** Must handle loading/error/empty states. Use Jotai atoms. No Storybook stories.

---

## Services Template (Single File)

Use when: < 3 API endpoints AND < 250 lines total.

```typescript
// features/[feature-name]/services.ts
import { atom } from 'jotai'
import { httpClient } from '#root/lib/http-client'
import type { FeatureNameData, GetFeatureNameFxArgs, UpdateFeatureNameFxArgs } from './types'

// ===== STATE ATOMS ($prefix) =====
export const $data = atom<FeatureNameData | null>(null)
export const $isLoading = atom<boolean>(false)
export const $error = atom<Error | null>(null)

// ===== DERIVED ATOMS ($prefix) =====
export const $hasData = atom((get) => get($data) !== null)

// ===== WRITE-ONLY ATOMS (Fx suffix for async) =====
export const getDataFx = atom(
  null,
  async (get, set, args: GetFeatureNameFxArgs) => {
    set($isLoading, true)
    set($error, null)
    try {
      const response = await httpClient.fetch<FeatureNameData>(`/api/data/${args.dataId}`, {
        method: 'GET',
      })
      set($data, response.body)
    } catch (err) {
      set($error, err as Error)
    } finally {
      set($isLoading, false)
    }
  }
)

export const updateDataFx = atom(
  null,
  async (get, set, args: UpdateFeatureNameFxArgs) => {
    set($isLoading, true)
    set($error, null)
    try {
      const response = await httpClient.fetch<FeatureNameData>(`/api/data/${args.dataId}`, {
        method: 'PATCH',
        body: args.updates,
      })
      set($data, response.body)
    } catch (err) {
      set($error, err as Error)
      throw err
    } finally {
      set($isLoading, false)
    }
  }
)

// Sync write-only (Atom suffix, no Fx)
export const resetDataAtom = atom(null, (get, set) => {
  set($data, null)
  set($error, null)
  set($isLoading, false)
})
```

---

## Services Template (Folder)

Use when: 3+ API endpoints OR > 250 lines.

```
services/
├── main.ts      # Re-exports everything
├── api.ts       # API calls (pure functions)
└── libs.ts      # Pure business logic
```

**services/api.ts:**
```typescript
import { httpClient } from '#root/lib/http-client'
import type { FeatureNameData } from '../types'

export async function fetchData(id: string): Promise<FeatureNameData> {
  const response = await httpClient.fetch<FeatureNameData>(`/api/data/${id}`, { method: 'GET' })
  return response.body
}
```

**services/main.ts:**
```typescript
import { atom } from 'jotai'
import { fetchData } from './api'
import type { GetFeatureNameFxArgs } from '../types'

export const $data = atom<FeatureNameData | null>(null)
export const $isLoading = atom<boolean>(false)
export const $error = atom<Error | null>(null)

export const getDataFx = atom(null, async (get, set, args: GetFeatureNameFxArgs) => {
  set($isLoading, true)
  set($error, null)
  try {
    const data = await fetchData(args.dataId)
    set($data, data)
  } catch (err) {
    set($error, err as Error)
  } finally {
    set($isLoading, false)
  }
})

export * from './api'
export * from './libs'
```

---

## Public API Template

```typescript
// features/[feature-name]/index.ts
export { FeatureNameContainer } from './containers/feature-name-container'
export * as featureNameService from './services'  // [featureName]Service
export type { FeatureNameData, FeatureNameComponentProps } from './types'
```

---

## Test Templates

### Dumb Component Test

```tsx
// __tests__/feature-name-component.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FeatureNameComponent } from '../components/feature-name-component'

describe('FeatureNameComponent', () => {
  const mockData = { id: '1', name: 'Test' }

  it('renders data', () => {
    render(<FeatureNameComponent data={mockData} />)
    expect(screen.getByText('Test')).toBeInTheDocument()
  })

  it('calls onAction', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    render(<FeatureNameComponent data={mockData} onAction={onAction} />)
    await user.click(screen.getByRole('button', { name: /action/i }))
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('applies custom className', () => {
    const { container } = render(<FeatureNameComponent data={mockData} className="custom" />)
    expect(container.firstChild).toHaveClass('custom')
  })
})
```

### Smart Component Test

```tsx
// __tests__/feature-name-container.test.tsx
import { render, screen } from '@testing-library/react'
import { Provider } from 'jotai'
import { useHydrateAtoms } from 'jotai/utils'
import * as service from '../services'
import { FeatureNameContainer } from '../containers/feature-name-container'

const HydrateAtoms = ({ initialValues, children }) => {
  useHydrateAtoms(initialValues)
  return children
}

const TestProvider = ({ initialValues, children }) => (
  <Provider>
    <HydrateAtoms initialValues={initialValues}>{children}</HydrateAtoms>
  </Provider>
)

describe('FeatureNameContainer', () => {
  it('renders loading state', () => {
    render(
      <TestProvider initialValues={[[service.$isLoading, true]]}>
        <FeatureNameContainer dataId="1" />
      </TestProvider>
    )
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('renders data when loaded', () => {
    render(
      <TestProvider initialValues={[[service.$data, { id: '1', name: 'Test' }]]}>
        <FeatureNameContainer dataId="1" />
      </TestProvider>
    )
    expect(screen.getByText('Test')).toBeInTheDocument()
  })

  it('renders error state', () => {
    render(
      <TestProvider initialValues={[[service.$error, new Error('Failed')]]}>
        <FeatureNameContainer dataId="1" />
      </TestProvider>
    )
    expect(screen.getByText(/failed/i)).toBeInTheDocument()
  })
})
```

---

## Storybook Template

```tsx
// __stories__/feature-name-component.stories.tsx
import type { Meta, StoryObj } from '@storybook/react'
import { FeatureNameComponent } from '../components/feature-name-component'

const meta = {
  title: 'Features/FeatureName/FeatureNameComponent',
  component: FeatureNameComponent,
  tags: ['autodocs'],
} satisfies Meta<typeof FeatureNameComponent>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    data: { id: '1', name: 'Example Name', description: 'Example description' },
  },
}

export const WithAction: Story = {
  args: { ...Default.args, onAction: () => console.log('clicked') },
}

export const LongName: Story = {
  args: {
    data: { id: '1', name: 'Very long name that should wrap or truncate properly' },
  },
}
```

Only dumb components get stories. Containers do NOT have stories.
