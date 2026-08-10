/**
 * Pure business logic functions for Feature Name feature
 *
 * - NO side effects
 * - NO HTTP requests
 * - NO Jotai atoms
 * - Pure functions only (input -> output)
 * - Easy to test
 */

import type { FeatureNameData } from '../types'

/**
 * Process raw data from API
 */
export function processData(data: FeatureNameData): FeatureNameData {
  // Add any data transformation logic here
  return {
    ...data,
    // Add computed properties or transformations
  }
}

/**
 * Validate data before submission
 */
export function validateData(
  data: Partial<FeatureNameData>
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Add validation logic
  if (!data.id) {
    errors.push('ID is required')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Format data for display
 */
export function formatData(data: FeatureNameData): string {
  // Add formatting logic
  return `${data.id}`
}

/**
 * Sort data by criteria
 */
export function sortData(
  items: FeatureNameData[],
  sortBy: 'id' | 'name' = 'id'
): FeatureNameData[] {
  return [...items].sort((a, b) => {
    if (sortBy === 'id') {
      return a.id.localeCompare(b.id)
    }
    return 0
  })
}

/**
 * Filter data by criteria
 */
export function filterData(
  items: FeatureNameData[],
  query: string
): FeatureNameData[] {
  if (!query) return items

  const lowerQuery = query.toLowerCase()
  return items.filter((item) => item.id.toLowerCase().includes(lowerQuery))
}
