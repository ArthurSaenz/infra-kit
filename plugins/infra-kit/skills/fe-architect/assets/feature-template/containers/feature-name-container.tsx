/**
 * FeatureNameContainer - Smart Component (Logic + UI)
 *
 * Rules:
 * - Use Jotai atoms for state management
 * - Handle loading/error/empty states (REQUIRED)
 * - API calls via services
 * - Pass data to dumb components via props
 */

import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import * as service from '../services'
import { FeatureNameComponent } from '../components/feature-name-component'
import type { FeatureNameContainerProps } from '../types'

export const FeatureNameContainer = (props: FeatureNameContainerProps) => {
  const { id = 'default-id', className } = props

  // State atoms
  const data = useAtomValue(service.$data)
  const isLoading = useAtomValue(service.$isLoading)
  const error = useAtomValue(service.$error)

  // Actions
  const getData = useSetAtom(service.getFeatureNameFx)
  const updateData = useSetAtom(service.updateFeatureNameFx)

  // Fetch data on mount
  useEffect(() => {
    getData({ id })
  }, [id, getData])

  // Event handlers (business logic)
  const handleAction = () => {
    updateData({
      id,
      data: {
        // Update properties
      },
    })
  }

  // 1. Loading state (REQUIRED)
  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-500" />
      </div>
    )
  }

  // 2. Error state (REQUIRED)
  if (error) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-4">
        <h3 className="text-lg font-semibold text-red-800">Error</h3>
        <p className="text-red-600">{error.message}</p>
        <button
          onClick={() => getData({ id })}
          className="mt-2 rounded bg-red-500 px-4 py-2 text-white hover:bg-red-600"
        >
          Retry
        </button>
      </div>
    )
  }

  // 3. Empty state (REQUIRED)
  if (!data) {
    return (
      <div className="rounded-lg border border-gray-300 bg-gray-50 p-8 text-center">
        <p className="text-gray-600">No data available</p>
      </div>
    )
  }

  // 4. Success state - safe to render
  return (
    <div className={className}>
      {isLoading && (
        <div className="mb-2 text-sm text-gray-500">Updating...</div>
      )}
      <FeatureNameComponent
        data={data}
        onAction={handleAction}
      />
    </div>
  )
}
