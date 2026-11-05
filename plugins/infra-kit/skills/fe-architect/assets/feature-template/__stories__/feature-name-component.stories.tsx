/**
 * Storybook stories for FeatureNameComponent
 *
 * Required for all dumb components
 */

import type { Meta, StoryObj } from '@storybook/react'
import { FeatureNameComponent } from '../components/feature-name-component'

const meta: Meta<typeof FeatureNameComponent> = {
  title: 'features/feature-name/feature-name-component',
  component: FeatureNameComponent,
  tags: ['autodocs'],
  argTypes: {
    onAction: { action: 'onAction' },
  },
}

export default meta
type Story = StoryObj<typeof FeatureNameComponent>

const mockData = {
  id: 'example-id',
  // Add mock data
}

export const Default: Story = {
  args: {
    data: mockData,
  },
}

export const WithAction: Story = {
  args: {
    data: mockData,
  },
}

export const CustomStyling: Story = {
  args: {
    data: mockData,
    className: 'border-2 border-blue-500 shadow-lg',
  },
}
