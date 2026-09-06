/**
 * Services for Feature Name feature (Folder version - main.ts)
 *
 * Use services/ folder when:
 * - 3+ API endpoints
 * - > 250 lines total
 * - Complex business logic
 *
 * This file (main.ts):
 * - Defines all Jotai atoms
 * - Orchestrates API calls from api.ts
 * - Uses pure functions from libs.ts
 * - Re-exports everything
 */

import { atom } from 'jotai'
import * as api from './api'
import * as libs from './libs'
import type {
  FeatureNameData,
  GetFeatureNameFxArgs,
  UpdateFeatureNameFxArgs,
  DeleteFeatureNameFxArgs,
} from '../types'

// ============================================================================
// State Atoms ($ prefix)
// ============================================================================

export const $data = atom<FeatureNameData | null>(null)
export const $isLoading = atom<boolean>(false)
export const $error = atom<Error | null>(null)

// Derived atoms
export const $hasData = atom((get) => get($data) !== null)

// ============================================================================
// Write-Only Atoms (Fx suffix for async)
// ============================================================================

export const getFeatureNameFx = atom(
  null,
  async (get, set, args: GetFeatureNameFxArgs) => {
    set($isLoading, true)
    set($error, null)

    try {
      const data = await api.fetchData(args)
      const processed = libs.processData(data)
      set($data, processed)
    } catch (err) {
      set($error, err as Error)
    } finally {
      set($isLoading, false)
    }
  }
)

export const updateFeatureNameFx = atom(
  null,
  async (get, set, args: UpdateFeatureNameFxArgs) => {
    set($isLoading, true)
    set($error, null)

    try {
      const data = await api.updateData(args)
      set($data, data)
    } catch (err) {
      set($error, err as Error)
    } finally {
      set($isLoading, false)
    }
  }
)

export const deleteFeatureNameFx = atom(
  null,
  async (get, set, args: DeleteFeatureNameFxArgs) => {
    set($isLoading, true)
    set($error, null)

    try {
      await api.deleteData(args)
      set($data, null)
    } catch (err) {
      set($error, err as Error)
    } finally {
      set($isLoading, false)
    }
  }
)

// Sync write-only atoms
export const resetFeatureNameAtom = atom(null, (get, set) => {
  set($data, null)
  set($error, null)
  set($isLoading, false)
})

// ============================================================================
// Re-exports (for convenience)
// ============================================================================

export * from './api'
export * from './libs'
