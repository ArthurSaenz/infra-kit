/**
 * Type definitions for Feature Name feature
 *
 * Include:
 * - Data models
 * - Component props (MUST include className?)
 * - Service interfaces
 * - Write-only atom argument interfaces
 */

// Data models
export interface FeatureNameData {
  id: string
  // Add your data properties here
}

// Component props (MUST include className)
export interface FeatureNameComponentProps {
  data: FeatureNameData
  onAction?: () => void
  className?: string // REQUIRED for all dumb components
}

// Container props
export interface FeatureNameContainerProps {
  id?: string
  className?: string
}

// Write-only atom arguments (MUST use object with typed interface)
export interface GetFeatureNameFxArgs {
  id: string
}

export interface UpdateFeatureNameFxArgs {
  id: string
  data: Partial<FeatureNameData>
}

export interface DeleteFeatureNameFxArgs {
  id: string
}
