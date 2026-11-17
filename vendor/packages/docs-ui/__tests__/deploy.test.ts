import { describe, expect, it, vi } from 'vitest'

import deploy from '../deploy.ts'

// Never the real build output: run from the repo root, the copy would find and overwrite it.
vi.mock('node:fs/promises', () => {
  return {
    default: {
      copyFile: async () => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      },
    },
  }
})

const BUCKET_PARAMETER = '/hulyo/s3/docs/bucket_name'
const DISTRIBUTION_PARAMETER = '/hulyo/cloudfront/docs/id'

const createToolkit = (parameters: Record<string, string>) => {
  return {
    project: 'hulyo' as string | undefined,
    ssm: vi.fn(async () => {
      return parameters
    }),
    run: vi.fn(async () => {}),
    aws: vi.fn(async () => {}),
    retry: vi.fn(async (_label: string, action: () => Promise<unknown>) => {
      return action()
    }),
  }
}

const runDeploy = (toolkit: ReturnType<typeof createToolkit>) => {
  return deploy(toolkit as unknown as Parameters<typeof deploy>[0])
}

describe('docs-fe deploy', () => {
  it.each([
    [BUCKET_PARAMETER, { [DISTRIBUTION_PARAMETER]: 'E1' }],
    [BUCKET_PARAMETER, { [BUCKET_PARAMETER]: '', [DISTRIBUTION_PARAMETER]: 'E1' }],
    [DISTRIBUTION_PARAMETER, { [BUCKET_PARAMETER]: 'docs-bucket' }],
  ])('refuses before building or syncing when %s has no value', async (parameter, parameters) => {
    const toolkit = createToolkit(parameters)

    await expect(runDeploy(toolkit)).rejects.toThrow(`SSM parameter ${parameter} has no value`)
    expect(toolkit.run).not.toHaveBeenCalled()
    expect(toolkit.aws).not.toHaveBeenCalled()
  })

  it('refuses without a project before reading SSM', async () => {
    const toolkit = createToolkit({})

    toolkit.project = undefined

    await expect(runDeploy(toolkit)).rejects.toThrow(/set `project`/)
    expect(toolkit.ssm).not.toHaveBeenCalled()
  })

  it('keeps the reason when the SPA shell cannot be copied, and syncs nothing', async () => {
    const toolkit = createToolkit({ [BUCKET_PARAMETER]: 'docs-bucket', [DISTRIBUTION_PARAMETER]: 'E1' })

    const error = await runDeploy(toolkit).catch((caught: unknown) => {
      return caught as Error
    })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('_shell.html')
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(toolkit.aws).not.toHaveBeenCalled()
  })
})
