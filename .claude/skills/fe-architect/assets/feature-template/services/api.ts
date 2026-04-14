/**
 * API layer for Feature Name feature
 *
 * Pure functions that make HTTP requests
 * - Use httpClient.fetch() from #root/lib/http-client
 * - Always access response.body for the data
 * - Throw errors (let atoms handle them)
 * - NO Jotai atoms here (pure functions only)
 */

import { httpClient } from '#root/lib/http-client'
import type {
  FeatureNameData,
  GetFeatureNameFxArgs,
  UpdateFeatureNameFxArgs,
  DeleteFeatureNameFxArgs,
} from '../types'

/**
 * Fetch data by ID
 */
export async function fetchData(
  args: GetFeatureNameFxArgs
): Promise<FeatureNameData> {
  const { id } = args

  const response = await httpClient.fetch<FeatureNameData>(
    `/api/feature-name/${id}`,
    { method: 'GET' }
  )

  return response.body
}

/**
 * Update data by ID
 */
export async function updateData(
  args: UpdateFeatureNameFxArgs
): Promise<FeatureNameData> {
  const { id, data } = args

  const response = await httpClient.fetch<FeatureNameData>(
    `/api/feature-name/${id}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  )

  return response.body
}

/**
 * Delete data by ID
 */
export async function deleteData(
  args: DeleteFeatureNameFxArgs
): Promise<void> {
  const { id } = args

  await httpClient.fetch(`/api/feature-name/${id}`, {
    method: 'DELETE',
  })
}

/**
 * List all items
 */
export async function fetchList(): Promise<FeatureNameData[]> {
  const response = await httpClient.fetch<FeatureNameData[]>(
    '/api/feature-name',
    { method: 'GET' }
  )

  return response.body
}

/**
 * Create new item
 */
export async function createData(
  data: Omit<FeatureNameData, 'id'>
): Promise<FeatureNameData> {
  const response = await httpClient.fetch<FeatureNameData>(
    '/api/feature-name',
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  )

  return response.body
}
