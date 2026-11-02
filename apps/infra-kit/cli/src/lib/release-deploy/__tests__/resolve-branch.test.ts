import { describe, expect, it, vi } from 'vitest'

import { resolveIntegrationBranch } from 'src/lib/git-flow'

import { resolveDeployBranch } from '../resolve-branch'

vi.mock('src/lib/git-flow', async (importOriginal) => {
  return { ...(await importOriginal<typeof import('src/lib/git-flow')>()), resolveIntegrationBranch: vi.fn() }
})

describe('resolveDeployBranch — the integration branch of the git flow', () => {
  it('dev flow: "dev" deploys the dev branch', async () => {
    vi.mocked(resolveIntegrationBranch).mockResolvedValue('dev')

    await expect(resolveDeployBranch('dev')).resolves.toBe('dev')
  })

  it('main flow: "main" deploys the main branch', async () => {
    vi.mocked(resolveIntegrationBranch).mockResolvedValue('main')

    await expect(resolveDeployBranch('main')).resolves.toBe('main')
  })

  // A main-flow repo may still carry a stale dev; deploying it must be refused, by name.
  it('main flow: "dev" is refused and points at main', async () => {
    vi.mocked(resolveIntegrationBranch).mockResolvedValue('main')

    await expect(resolveDeployBranch('dev')).rejects.toThrow(/pass --version main/)
  })

  it('a release version still resolves to its branch', async () => {
    vi.mocked(resolveIntegrationBranch).mockResolvedValue('main')

    await expect(resolveDeployBranch('1.2.5')).resolves.toBe('release/v1.2.5')
  })
})
