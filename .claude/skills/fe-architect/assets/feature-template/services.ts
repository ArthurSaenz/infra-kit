/**
 * Services for Feature Name feature (Single file version)
 *
 * Use this file when:
 * - < 3 API endpoints
 * - < 250 lines total
 * - Simple business logic
 *
 * For complex features (3+ endpoints, >250 lines), use services/ folder instead
 */

import { atom } from 'jotai'
import { httpClient } from '#root/lib/http-client'
import type {
  FeatureNameData,
  GetFeatureNameFxArgs,
  UpdateFeatureNameFxArgs,
  DeleteFeatureNameFxArgs,
} from './types'

// ============================================================================
// State Atoms ($ prefix)
// ============================================================================

export const $data = atom<FeatureNameData | null>(null)
export const $isLoading = atom<boolean>(false)
export const $error = atom<Error | null>(null)

// Derived atoms ($ prefix)
export const $hasData = atom((get) => get($data) !== null)

// ============================================================================
// Write-Only Atoms (Fx suffix for async, Atom suffix for sync)
// ============================================================================

// Fetch data
export const getFeatureNameFx = atom(
  null,
  async (_get, set, args: GetFeatureNameFxArgs) => {
    const { id } = args
    set($isLoading, true)
    set($error, null)

    try {
      const response = await httpClient.fetch<FeatureNameData>(
        `/api/feature-name/${id}`,
        { method: 'GET' }
      )
      set($data, response.body)
    } catch (err) {
      set($error, err as Error)
    } finally {
      set($isLoading, false)
    }
  }
)

// Update data
export const updateFeatureNameFx = atom(
  null,
  async (_get, set, args: UpdateFeatureNameFxArgs) => {
    const { id, data } = args
    set($isLoading, true)
    set($error, null)

    try {
      const response = await httpClient.fetch<FeatureNameData>(
        `/api/feature-name/${id}`,
        {
          method: 'PUT',
          body: JSON.stringify(data),
        }
      )
      set($data, response.body)
    } catch (err) {
      set($error, err as Error)
    } finally {
      set($isLoading, false)
    }
  }
)

// Delete data
export const deleteFeatureNameFx = atom(
  null,
  async (_get, set, args: DeleteFeatureNameFxArgs) => {
    const { id } = args
    set($isLoading, true)
    set($error, null)

    try {
      await httpClient.fetch(`/api/feature-name/${id}`, {
        method: 'DELETE',
      })
      set($data, null)
    } catch (err) {
      set($error, err as Error)
    } finally {
      set($isLoading, false)
    }
  }
)

// Sync write-only atoms (Atom suffix)
export const resetFeatureNameAtom = atom(null, (_get, set) => {
  set($data, null)
  set($error, null)
  set($isLoading, false)
})
