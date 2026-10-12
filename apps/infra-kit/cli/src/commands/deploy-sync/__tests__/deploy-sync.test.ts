import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deploySync } from '../deploy-sync'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), error: vi.fn() } }
})

// Type-only import + `satisfies`: the form a repo still on an older @slip-stream-kit/config can use.
const MANIFEST = `import type { DeployConfig } from '@slip-stream-kit/config'

export default {
  environments: ['dev', 'arthur'],
  services: { 'client-be': {}, 'docs-fe': { envs: ['dev'] } },
} satisfies DeployConfig
`

const ALL = '.github/workflows/deploy-all-v2.yml'
const SELECTED = '.github/workflows/deploy-selected-v2.yml'

let repo: string

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-sync-'))
})

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

const writeManifest = async (body = MANIFEST) => {
  await fs.writeFile(path.join(repo, 'infra-kit.deploy.ts'), body)
}

describe('deploySync', () => {
  it('creates both workflows, then reports them unchanged', async () => {
    await writeManifest()

    const first = await deploySync({ cwd: repo })

    expect(first.structuredContent).toEqual({
      status: 'written',
      ok: true,
      files: [
        { path: ALL, status: 'created' },
        { path: SELECTED, status: 'created' },
      ],
    })
    expect(await fs.readFile(path.join(repo, SELECTED), 'utf-8')).toContain('service: docs-fe')

    const second = await deploySync({ cwd: repo })

    expect(second.structuredContent.status).toBe('unchanged')
  })

  it('--check flags a hand-edited workflow and leaves it alone', async () => {
    await writeManifest()
    await deploySync({ cwd: repo })
    await fs.appendFile(path.join(repo, ALL), '# hand edit\n')

    const checked = await deploySync({ cwd: repo, check: true })

    expect(checked.structuredContent).toMatchObject({ status: 'drift', ok: false })
    expect(checked.structuredContent.files).toContainEqual({ path: ALL, status: 'updated' })
    expect(await fs.readFile(path.join(repo, ALL), 'utf-8')).toContain('# hand edit')
  })

  it('--check flags a workflow that was never generated, without writing it', async () => {
    await writeManifest()

    const checked = await deploySync({ cwd: repo, check: true })

    expect(checked.structuredContent.ok).toBe(false)
    await expect(fs.access(path.join(repo, ALL))).rejects.toThrow()
  })

  it('a repo without a manifest fails a write but passes --check', async () => {
    expect((await deploySync({ cwd: repo })).structuredContent).toMatchObject({ status: 'missing-config', ok: false })
    expect((await deploySync({ cwd: repo, check: true })).structuredContent.ok).toBe(true)
  })

  it('rejects an invalid manifest with the offending key', async () => {
    await writeManifest(`export default { environments: ['dev'], services: { 'client-be': { env: ['dev'] } } }\n`)

    await expect(deploySync({ cwd: repo })).rejects.toThrow(/infra-kit\.deploy\.ts[\s\S]*env/)
  })
})
