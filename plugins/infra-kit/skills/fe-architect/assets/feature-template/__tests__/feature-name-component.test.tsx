/**
 * Tests for FeatureNameComponent
 *
 * Test coverage target: 80%+ for dumb components
 */

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import type { FeatureNameComponentProps } from '../types'

import { FeatureNameComponent } from '../components/feature-name-component'

describe('FeatureNameComponent', () => {
  const mockData = {
    id: 'test-id',
    // Add mock data properties
  }

  const defaultProps: FeatureNameComponentProps = {
    data: mockData,
    onAction: vi.fn(),
  }

  it('should render correctly', async () => {
    const screen = await render(<FeatureNameComponent {...defaultProps} />)

    await expect.element(screen.getByText('test-id')).toBeVisible()
  })

  it('should call onAction when button is clicked', async () => {
    const onAction = vi.fn()

    const screen = await render(
      <FeatureNameComponent {...defaultProps} onAction={onAction} />,
    )

    await screen.getByRole('button', { name: /action/i }).click()

    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('should apply custom className', async () => {
    const screen = await render(
      <FeatureNameComponent {...defaultProps} className="custom-class" />,
    )

    const el = screen.container.querySelector('.custom-class')

    expect(el).not.toBeNull()
  })

  it('should not render button when onAction is undefined', async () => {
    const screen = await render(
      <FeatureNameComponent {...defaultProps} onAction={undefined} />,
    )

    expect(screen.getByRole('button').query()).toBeNull()
  })
})
