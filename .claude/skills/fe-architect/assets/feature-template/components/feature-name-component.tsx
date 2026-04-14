/**
 * FeatureNameComponent - Dumb Component (UI only)
 *
 * Rules:
 * - Props in, JSX out - NO business logic
 * - MUST accept className prop
 * - MUST use cn() utility
 * - NO Jotai atoms, NO API calls, NO services
 */

import { cn } from '#root/lib/utils'
import type { FeatureNameComponentProps } from '../types'

export const FeatureNameComponent = (props: FeatureNameComponentProps) => {
  const { data, onAction, className } = props

  return (
    <div className={cn('rounded-lg border p-4', className)}>
      <h2 className="text-xl font-semibold">{data.id}</h2>

      {/* Add your UI here */}

      {onAction && (
        <button
          onClick={onAction}
          className="mt-4 rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
        >
          Action
        </button>
      )}
    </div>
  )
}
