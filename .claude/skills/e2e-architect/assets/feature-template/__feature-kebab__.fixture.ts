import { E2E_BASE_URL_BACKOFFICE } from '#root/constants'
import { test as base, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

import { __FeaturePascal__Page } from './__feature-kebab__.page'

/**
 * __Feature Title__ test fixture.
 *
 * Provides a ready `__featureCamel__Page` and — crucially — GUARANTEES cleanup of every entity
 * the test created, in teardown, even when the test fails before its own inline cleanup. This is
 * the one non-obvious reliability pattern worth keeping in even the smallest suite: without it, a
 * mid-test failure leaves state behind on the shared env and later runs flake.
 *
 * Cleanup uses the same-origin authed API. The `request` context inherits the authenticated
 * storageState, so it carries the auth cookie. Adapt `API`, `ApiRow`, and the removal call below
 * to the real feature — many features soft-delete via an `/archive` endpoint; some hard-delete.
 * If the feature creates nothing (a read-only page), delete this fixture and import `test` from
 * `@playwright/test` directly.
 */
interface __FeaturePascal__Fixtures {
  __featureCamel__Page: __FeaturePascal__Page
}

const API = `${E2E_BASE_URL_BACKOFFICE}/api/v1/__feature-kebab__`

interface ApiRow {
  _id?: string
  marker?: string
}

/**
 * Removes every entity whose marker is in `markers` (best-effort; never throws, so a teardown
 * failure can't mask the test result). Lists once, then removes each match by id.
 */
export const cleanupByMarker = async (request: APIRequestContext, markers: string[]): Promise<void> => {
  if (markers.length === 0) {
    return
  }

  try {
    const res = await request.get(API)

    if (!res.ok()) {
      return
    }

    // If the real API wraps results (e.g. `{ data: [...] }`), unwrap here before filtering.
    const rows = (await res.json()) as ApiRow[]
    const wanted = new Set(markers)

    const toRemove = (Array.isArray(rows) ? rows : []).filter((row) => {
      return Boolean(row._id) && typeof row.marker === 'string' && wanted.has(row.marker)
    })

    for (const row of toRemove) {
      await request.delete(`${API}/${encodeURIComponent(row._id as string)}`).catch(() => {
        // best-effort: an already-removed entity (or transient error) must not fail teardown
      })
    }
  } catch {
    // Cleanup is best-effort — never let it surface as a test failure.
  }
}

export const test = base.extend<__FeaturePascal__Fixtures>({
  __featureCamel__Page: async ({ page, request }, use) => {
    const __featureCamel__Page = new __FeaturePascal__Page(page)

    await use(__featureCamel__Page)

    await cleanupByMarker(request, __featureCamel__Page.createdMarkers)
  },
})

export { expect }
