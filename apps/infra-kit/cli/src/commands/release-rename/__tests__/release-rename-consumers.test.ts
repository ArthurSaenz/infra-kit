import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { cd } from 'zx'

import type { ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'
import { formatJiraName, parseReleaseRef } from 'src/lib/release-id'
import { loadExistingVersions } from 'src/lib/version-utils/load-existing-versions'

import { SPAWN_TEST_TIMEOUT_MS, output, registerCliBundle, renameOk, withFixture } from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 10 (replacing the spec's unrunnable AC 10): on a converged rename, the other release
 * consumers resolve the release by its new name only — `release list`, `release edit`'s confirm,
 * origin's refs (what a deploy's `--ref` needs) and the `next`-bump source `loadExistingVersions`.
 */

const cliPath = registerCliBundle('release-rename-consumers-')

const originalCwd = process.cwd()
const JIRA_KEYS = ['JIRA_BASE_URL', 'JIRA_TOKEN', 'JIRA_PROJECT_ID', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] as const

const savedJiraEnv = Object.fromEntries(
  JIRA_KEYS.map((key) => {
    return [key, process.env[key]]
  }),
)

afterEach(() => {
  // zx keeps its own cwd: `process.chdir` alone would leave every later `$` in the fixture.
  process.chdir(originalCwd)
  cd(originalCwd)

  for (const [key, value] of Object.entries(savedJiraEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

const lsRemote = (fixture: ReleaseRenameFixture, ref: string): string => {
  const result = spawnSync('/usr/bin/git', ['ls-remote', fixture.originDir, ref], {
    env: fixture.env,
    encoding: 'utf8',
  })

  expect(result.status).toBe(0)

  return result.stdout.trim()
}

const pointInProcessAt = (fixture: ReleaseRenameFixture): void => {
  process.chdir(fixture.repoDir)
  cd(fixture.repoDir)
  delete process.env.JIRA_API_TOKEN
  Object.assign(process.env, fixture.jiraEnv)
}

describe('release rename: consumers see the new name (AC 10)', () => {
  it(
    'release list, release edit, origin refs and loadExistingVersions all resolve <new> and not <old>',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        await renameOk(fixture)

        const list = await fixture.runCli(['release', 'list', '--agent', '--json'])
        const listed = JSON.stringify(list.json?.releases)

        expect(list.code, output(list)).toBe(0)
        expect(list.json?.releases, output(list)).toEqual([expect.objectContaining({ version: '1.3.0' })])
        expect(listed).not.toContain('1.2.0')

        const edit = await fixture.runCli([
          'release',
          'edit',
          '--version',
          '1.3.0',
          '--description',
          'x',
          '--agent',
          '--json',
        ])

        expect(edit.code, output(edit)).toBe(2)
        expect(edit.json?.status, output(edit)).toBe('confirmation_required')
        expect(String(edit.json?.message)).toContain(formatJiraName(parseReleaseRef('1.3.0')))

        expect(lsRemote(fixture, 'refs/heads/release/v1.3.0')).toMatch(
          /^[0-9a-f]{40}\trefs\/heads\/release\/v1\.3\.0$/u,
        )
        expect(lsRemote(fixture, 'refs/heads/release/v1.2.0')).toBe('')

        pointInProcessAt(fixture)

        const versions = await loadExistingVersions()

        expect(versions).toContainEqual([1, 3, 0])
        expect(versions).not.toContainEqual([1, 2, 0])
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})
