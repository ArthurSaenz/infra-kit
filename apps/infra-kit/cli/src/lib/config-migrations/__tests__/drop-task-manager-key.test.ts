import { describe, expect, it } from 'vitest'

import { dropTaskManagerKeyMigration } from '../migrations/drop-task-manager-key'

const { apply, note } = dropTaskManagerKeyMigration

describe('drop-task-manager-key', () => {
  it('removes only the top-level key, siblings and their order intact', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      taskManager: { provider: 'jira', config: { baseUrl: 'https://acme.atlassian.net', projectId: 123 } },
      aliasRepo: 'p',
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('taskManager')
    expect(Object.keys(result)).toEqual(['envManagement', 'aliasRepo'])
  })

  it('does not mutate the input', () => {
    const parsed = { taskManager: { provider: 'jira' } }

    apply(parsed)

    expect(parsed).toHaveProperty('taskManager')
  })

  it('returns the same reference and changed:false when the key is absent', () => {
    const parsed = { worktrees: { openInOrca: true } }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('points at the env vars that actually configure Jira', () => {
    expect(note).toContain('JIRA_PROJECT_ID')
  })
})
