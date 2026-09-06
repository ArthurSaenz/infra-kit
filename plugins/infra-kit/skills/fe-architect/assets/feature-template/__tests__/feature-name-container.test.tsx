/**
 * Tests for FeatureNameContainer
 *
 * Test coverage target: 70%+ for smart components
 * Uses useHydrateAtoms to inject per-test atom state
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { atom, Provider } from 'jotai'
import { useHydrateAtoms } from 'jotai/utils'

import type { WritableAtom } from 'jotai'

import { FeatureNameContainer } from '../containers/feature-name-container'

// ---------------------------------------------------------------------------
// Mock atoms — replace real service atoms with test-controlled versions
// ---------------------------------------------------------------------------

// State atoms (real Jotai atoms we can hydrate per test)
const $data = atom<unknown>(null)
const $isLoading = atom<boolean>(false)
const $error = atom<Error | null>(null)

// Fx atoms (write-only atoms wrapping vi.fn for call tracking)
const mockGetFn = vi.fn()
const getFeatureNameFx = atom(null, (_get, _set, args: unknown) => {
  mockGetFn(args)
})

const mockUpdateFn = vi.fn()
const updateFeatureNameFx = atom(null, (_get, _set, args: unknown) => {
  mockUpdateFn(args)
})

vi.mock('../services', () => ({
  $data,
  $isLoading,
  $error,
  getFeatureNameFx,
  updateFeatureNameFx,
}))

// ---------------------------------------------------------------------------
// Test Provider — hydrates atoms with per-test values
// ---------------------------------------------------------------------------

type AtomEntry = readonly [WritableAtom<unknown, [unknown], unknown>, unknown]

const HydrateAtoms = (props: {
  initialValues: AtomEntry[]
  children: React.ReactNode
}) => {
  const { initialValues, children } = props
  useHydrateAtoms(initialValues)
  return children
}

const TestProvider = (props: {
  initialValues?: AtomEntry[]
  children: React.ReactNode
}) => {
  const { initialValues = [], children } = props
  return (
    <Provider>
      <HydrateAtoms initialValues={initialValues}>{children}</HydrateAtoms>
    </Provider>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeatureNameContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should fetch data on mount', async () => {
    await render(
      <TestProvider
        initialValues={[
          [$isLoading as any, true],
          [$data as any, null],
          [$error as any, null],
        ]}
      >
        <FeatureNameContainer id="test-id" />
      </TestProvider>,
    )

    expect(mockGetFn).toHaveBeenCalledWith({ id: 'test-id' })
  })

  it('should render loading state when loading with no data', async () => {
    const screen = await render(
      <TestProvider
        initialValues={[
          [$isLoading as any, true],
          [$data as any, null],
          [$error as any, null],
        ]}
      >
        <FeatureNameContainer id="test-id" />
      </TestProvider>,
    )

    // Spinner is a div with animate-spin class
    const spinner = screen.container.querySelector('.animate-spin')

    expect(spinner).not.toBeNull()
  })

  it('should render error state with retry button', async () => {
    const screen = await render(
      <TestProvider
        initialValues={[
          [$isLoading as any, false],
          [$data as any, null],
          [$error as any, new Error('Something went wrong')],
        ]}
      >
        <FeatureNameContainer id="test-id" />
      </TestProvider>,
    )

    await expect.element(screen.getByText('Something went wrong')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: /retry/i })).toBeVisible()
  })

  it('should call getData when retry button is clicked', async () => {
    const screen = await render(
      <TestProvider
        initialValues={[
          [$isLoading as any, false],
          [$data as any, null],
          [$error as any, new Error('Network error')],
        ]}
      >
        <FeatureNameContainer id="test-id" />
      </TestProvider>,
    )

    // Clear the initial mount call
    mockGetFn.mockClear()

    await screen.getByRole('button', { name: /retry/i }).click()

    expect(mockGetFn).toHaveBeenCalledWith({ id: 'test-id' })
  })

  it('should render empty state when no data and not loading', async () => {
    const screen = await render(
      <TestProvider
        initialValues={[
          [$isLoading as any, false],
          [$data as any, null],
          [$error as any, null],
        ]}
      >
        <FeatureNameContainer id="test-id" />
      </TestProvider>,
    )

    await expect.element(screen.getByText(/no data/i)).toBeVisible()
  })

  it('should render component with data on success', async () => {
    const mockData = { id: 'test-id', name: 'Test Item' }

    const screen = await render(
      <TestProvider
        initialValues={[
          [$isLoading as any, false],
          [$data as any, mockData],
          [$error as any, null],
        ]}
      >
        <FeatureNameContainer id="test-id" />
      </TestProvider>,
    )

    // Success state renders the FeatureNameComponent with data
    await expect.element(screen.getByText('test-id')).toBeVisible()
  })

  it('should show updating indicator when loading with existing data', async () => {
    const mockData = { id: 'test-id', name: 'Test Item' }

    const screen = await render(
      <TestProvider
        initialValues={[
          [$isLoading as any, true],
          [$data as any, mockData],
          [$error as any, null],
        ]}
      >
        <FeatureNameContainer id="test-id" />
      </TestProvider>,
    )

    await expect.element(screen.getByText('Updating...')).toBeVisible()
    // Component should still be rendered with existing data
    await expect.element(screen.getByText('test-id')).toBeVisible()
  })
})
