/**
 * Public API for Feature Name feature
 *
 * Export pattern:
 * - Containers (primary API)
 * - Services as namespace (featureNameService)
 * - Types (safe across features)
 * - Optional: Dumb components if needed by consumers
 */

// Export containers (primary API)
export { FeatureNameContainer } from './containers/feature-name-container'

// Export services as namespace (REQUIRED naming pattern)
export * as featureNameService from './services'

// Export types (safe across features with type-only imports)
export type {
  FeatureNameData,
  FeatureNameComponentProps,
} from './types'

// Optional: Export dumb components if consumers need direct access
// export { FeatureNameComponent } from './components/feature-name-component'
