# Testing & Storybook

## Core Principles

1. **Every component must have tests** — both dumb and smart
2. **Test behavior, not implementation** — focus on what users see and interact with
3. **Mock at boundaries** — mock `httpClient`, not internal functions
4. **Only dumb components get stories** — containers do NOT have stories

---

## Dumb Component Tests

Test: rendering, user interactions, conditional rendering, className prop.

```tsx
// __tests__/feature-name-component.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { FeatureNameComponent } from '../components/feature-name-component'

describe('FeatureNameComponent', () => {
  const mockData = { id: '1', name: 'Test', description: 'Description' }

  it('renders data', async () => {
    const screen = await render(<FeatureNameComponent data={mockData} />)
    await expect.element(screen.getByText('Test')).toBeVisible()
  })

  it('calls onAction when clicked', async () => {
    const onAction = vi.fn()
    const screen = await render(<FeatureNameComponent data={mockData} onAction={onAction} />)
    await screen.getByRole('button', { name: /action/i }).click()
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('applies custom className', async () => {
    const screen = await render(<FeatureNameComponent data={mockData} className="custom" />)
    const el = screen.container.querySelector('.custom')
    expect(el).not.toBeNull()
  })

  it('conditionally renders description', async () => {
    const screen = await render(<FeatureNameComponent data={mockData} showDetails={false} />)
    expect(screen.getByText('Description').query()).toBeNull()
  })
})
```

---

## Smart Component Tests

Test: loading/error/empty states, Jotai atom integration via mock atoms + `vi.mock`.

### Mock Atoms Pattern

```tsx
// __tests__/feature-name-container.test.tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { atom, Provider } from 'jotai'
import { useHydrateAtoms } from 'jotai/utils'

import type { WritableAtom } from 'jotai'

import { FeatureNameContainer } from '../containers/feature-name-container'

// Mock atoms — real Jotai atoms we can hydrate per test
const $data = atom<unknown>(null)
const $isLoading = atom<boolean>(false)
const $error = atom<Error | null>(null)

// Fx atoms — write-only atoms wrapping vi.fn for call tracking
const mockGetFn = vi.fn()
const getFeatureNameFx = atom(null, (_get, _set, args: unknown) => {
  mockGetFn(args)
})

vi.mock('../services', () => ({
  $data,
  $isLoading,
  $error,
  getFeatureNameFx,
}))
```

### Test Provider Helper

```tsx
type AtomEntry = readonly [WritableAtom<unknown, [unknown], unknown>, unknown]

const HydrateAtoms = (props: {
  initialValues: AtomEntry[]
  children: React.ReactNode
}) => {
  useHydrateAtoms(props.initialValues)
  return props.children
}

const TestProvider = (props: {
  initialValues?: AtomEntry[]
  children: React.ReactNode
}) => (
  <Provider>
    <HydrateAtoms initialValues={props.initialValues ?? []}>{props.children}</HydrateAtoms>
  </Provider>
)
```

### Container Test

```tsx
describe('FeatureNameContainer', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders loading state', async () => {
    const screen = await render(
      <TestProvider initialValues={[[$isLoading as any, true], [$data as any, null]]}>
        <FeatureNameContainer id="1" />
      </TestProvider>,
    )
    const spinner = screen.container.querySelector('.animate-spin')
    expect(spinner).not.toBeNull()
  })

  it('renders data when loaded', async () => {
    const screen = await render(
      <TestProvider initialValues={[[$data as any, { id: '1', name: 'Test' }]]}>
        <FeatureNameContainer id="1" />
      </TestProvider>,
    )
    await expect.element(screen.getByText('Test')).toBeVisible()
  })

  it('renders error state', async () => {
    const screen = await render(
      <TestProvider initialValues={[[$error as any, new Error('Failed')]]}>
        <FeatureNameContainer id="1" />
      </TestProvider>,
    )
    await expect.element(screen.getByText('Failed')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: /retry/i })).toBeVisible()
  })

  it('calls retry on button click', async () => {
    const screen = await render(
      <TestProvider initialValues={[[$error as any, new Error('Network error')]]}>
        <FeatureNameContainer id="1" />
      </TestProvider>,
    )
    mockGetFn.mockClear()
    await screen.getByRole('button', { name: /retry/i }).click()
    expect(mockGetFn).toHaveBeenCalledWith({ id: '1' })
  })
})
```

---

## Testing API Calls

```tsx
vi.mock('#root/lib/http-client', () => ({
  httpClient: { fetch: vi.fn() },
}))

it('fetches data on mount', async () => {
  vi.mocked(httpClient.fetch).mockResolvedValue({
    body: mockData, status: 200, ok: true,
  })

  const screen = await render(
    <Provider>
      <FeatureNameContainer dataId="1" />
    </Provider>,
  )

  await expect.element(screen.getByText('Test')).toBeVisible()
  expect(httpClient.fetch).toHaveBeenCalledWith('/api/data/1', { method: 'GET' })
})
```

---

## Testing Atoms Directly

```tsx
import { createStore } from 'jotai'

it('getDataFx updates $data', async () => {
  vi.mocked(httpClient.fetch).mockResolvedValueOnce({
    body: mockData, status: 200, headers: {}, ok: true,
  })

  const store = createStore()
  await store.set(service.getDataFx, { dataId: '1' })
  expect(store.get(service.$data)).toEqual(mockData)
})
```

---

## Mock Patterns

### Mock Factory

```tsx
export const createMockData = (overrides?: Partial<FeatureData>): FeatureData => ({
  id: '1',
  name: 'Default Name',
  description: 'Default description',
  ...overrides,
})
```

---

## Query Priority

Use semantic queries that reflect how users interact:

```tsx
// Preferred (most → least)
screen.getByRole('button', { name: /submit/i })
screen.getByLabelText('Email')
screen.getByText('Welcome')
screen.getByAltText('Profile picture')

// Avoid
screen.getByTestId('submit-btn')  // implementation detail
```

---

## Storybook

### Story Template (CSF3)

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

export const Empty: Story = {
  args: { data: { id: '1', name: '', description: '' } },
}
```

### Key Rules

- **Only dumb components** get stories (never containers)
- **File location:** `__stories__/[name].stories.tsx`
- **Title format:** `Features/[FeatureName]/[ComponentName]`
- **Always include:** Default, edge cases (long text, empty, many items)
- **Use `autodocs` tag** for auto-generated documentation
- **Use realistic mock data**, not "test" or "placeholder"
- **No API calls** in stories — use mock data only

### Interactive Stories

```tsx
export const WithInteraction: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value)
    return <Component {...args} value={value} onChange={setValue} />
  },
  args: { value: '', options: ['Option 1', 'Option 2'] },
}
```

### Compose Stories

```tsx
export const WithLongText: Story = {
  args: {
    ...Default.args,
    data: { ...Default.args.data, name: 'Very long name that tests wrapping behavior' },
  },
}
```
