import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GENERATED_MARKER } from 'src/lib/deploy-workflows'

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

const REPLACING = MANIFEST.replace(
  "environments: ['dev', 'arthur'],",
  "environments: ['dev', 'arthur', 'prod'],\n  replaceV1: true,",
)

const ALL = '.github/workflows/deploy-all-v2.yml'
const SELECTED = '.github/workflows/deploy-selected-v2.yml'
const V1_ALL = '.github/workflows/deploy-all.yml'
const V1_SELECTED = '.github/workflows/deploy-selected-services.yml'

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

  // Each manifest gets its own repo: the loader imports it once per process, as the CLI does.
  it('under replaceV1 writes the v1 names and removes the generated pilot pair', async () => {
    await writeManifest(REPLACING)
    await fs.mkdir(path.join(repo, '.github/workflows'), { recursive: true })
    await fs.writeFile(path.join(repo, ALL), `${GENERATED_MARKER}: edit that file\n`)
    await fs.writeFile(path.join(repo, SELECTED), `${GENERATED_MARKER}: edit that file\n`)
    await fs.writeFile(path.join(repo, V1_ALL), 'name: hand-written v1\n')

    const checked = await deploySync({ cwd: repo, check: true })

    expect(checked.structuredContent.ok).toBe(false)
    expect(checked.structuredContent.files).toContainEqual({ path: ALL, status: 'removed' })
    expect(await fs.readFile(path.join(repo, ALL), 'utf-8')).toContain(GENERATED_MARKER)

    const written = await deploySync({ cwd: repo })

    expect(written.structuredContent.files).toEqual([
      { path: V1_ALL, status: 'updated' },
      { path: V1_SELECTED, status: 'created' },
      { path: ALL, status: 'removed' },
      { path: SELECTED, status: 'removed' },
    ])
    await expect(fs.access(path.join(repo, ALL))).rejects.toThrow()
    expect((await deploySync({ cwd: repo, check: true })).structuredContent.ok).toBe(true)
  })

  it('never removes a pilot-named file it did not generate', async () => {
    await writeManifest(REPLACING)
    await fs.mkdir(path.join(repo, '.github/workflows'), { recursive: true })
    await fs.writeFile(path.join(repo, ALL), 'name: hand-written\n')

    await deploySync({ cwd: repo })

    expect(await fs.readFile(path.join(repo, ALL), 'utf-8')).toBe('name: hand-written\n')
  })

  it('refuses to sync once replaceV1 is turned off, rather than delete the deploy-all.yml delivery needs', async () => {
    await writeManifest()
    await fs.mkdir(path.join(repo, '.github/workflows'), { recursive: true })
    await fs.writeFile(path.join(repo, V1_ALL), `${GENERATED_MARKER}: edit that file\n`)

    await expect(deploySync({ cwd: repo })).rejects.toThrow(/deploy-all\.yml was generated under replaceV1/)
    expect(await fs.readFile(path.join(repo, V1_ALL), 'utf-8')).toContain(GENERATED_MARKER)
  })

  it('refuses replaceV1 without prod, which delivery dispatches deploy-all.yml with', async () => {
    await writeManifest(
      MANIFEST.replace("environments: ['dev', 'arthur'],", "environments: ['dev', 'arthur'],\n  replaceV1: true,"),
    )

    await expect(deploySync({ cwd: repo })).rejects.toThrow(/replaceV1: environments must include 'prod'/)
  })

  it('rejects a gate on an unknown environment', async () => {
    await writeManifest(
      `export default { environments: ['dev', 'stage'], services: { 'docs-fe': { skipEnvs: ['stagee'] } } }\n`,
    )

    await expect(deploySync({ cwd: repo })).rejects.toThrow(/services\.docs-fe\.skipEnvs: unknown environment 'stagee'/)
  })

  it('accepts a gate on prod, which is delivered and so never offered', async () => {
    await writeManifest(`export default { environments: ['dev'], services: { 'docs-fe': { skipEnvs: ['prod'] } } }\n`)

    expect((await deploySync({ cwd: repo })).structuredContent.ok).toBe(true)
  })

  it('rejects an invalid manifest with the offending key', async () => {
    await writeManifest(`export default { environments: ['dev'], services: { 'client-be': { env: ['dev'] } } }\n`)

    await expect(deploySync({ cwd: repo })).rejects.toThrow(/infra-kit\.deploy\.ts[\s\S]*env/)
  })
})
