import { describe, expect, it } from 'vitest'

import type { ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'
import { findVersionById } from 'src/integrations/jira/api'
import type { JiraConfig } from 'src/integrations/jira/types'

import { SPAWN_TEST_TIMEOUT_MS, registerCliBundle, renameOk, withFixture } from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 4: the Jira fix version keeps its id and only its name changes — description and
 * release date equal the preflight snapshot, and no issue endpoint is ever requested.
 */

const cliPath = registerCliBundle('release-rename-jira-')

const jiraConfigOf = (fixture: ReleaseRenameFixture): JiraConfig => {
  return {
    baseUrl: fixture.jiraEnv.JIRA_BASE_URL!,
    token: fixture.jiraEnv.JIRA_TOKEN!,
    email: fixture.jiraEnv.JIRA_EMAIL!,
    projectId: Number(fixture.jiraEnv.JIRA_PROJECT_ID),
  }
}

describe('release rename: Jira fix version (AC 4)', () => {
  it(
    'renames the same version id in place; description and release date are untouched; no issue API is used',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const config = jiraConfigOf(fixture)
        const id = fixture.jiraVersionId!
        const preflight = await findVersionById(id, config)

        await renameOk(fixture)

        const after = await findVersionById(id, config)

        expect(after).toMatchObject({
          id: preflight!.id,
          name: 'v1.3.0',
          description: preflight!.description,
          releaseDate: preflight!.releaseDate,
          released: false,
          archived: false,
        })
        expect(fixture.jiraVersions()).toHaveLength(1)

        const requests = fixture.jiraRequests()

        expect(
          requests.filter((request) => {
            return /\/issue|\/search/u.test(request.path)
          }),
        ).toStrictEqual([])
        expect(
          requests.filter((request) => {
            return request.method !== 'GET'
          }),
        ).toStrictEqual([{ method: 'PUT', path: `/rest/api/3/version/${id}`, body: { name: 'v1.3.0' } }])
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})
