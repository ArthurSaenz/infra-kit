import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { logger } from 'src/lib/logger'

import packageJson from '../../../../package.json' with { type: 'json' }
import { applyConfigMigrations } from '../apply-config-migrations'
import { tryAutoMigrateLayer } from '../auto-migrate-layer'
import type { AutoMigrateLayer } from '../auto-migrate-layer'
import { ConfigFileChangedError, writeMigratedConfigFile } from '../migrate-config-file'

// Spy mode: the real implementations run, and the call counts (registry applied? writer reached?)
// are the contract under test. `vi.spyOn` on the namespace would not intercept the module's own
// named imports (memory: vispy-cannot-intercept-named-fs-imports).
vi.mock('../apply-config-migrations', { spy: true })
vi.mock('../migrate-config-file', { spy: true })

// A stand-in for the override schema: strict (so a retired key is refused), with one defaulted
// leaf so the returned `data` can be told apart from the raw migrated object.
const schema = z.strictObject({
  ide: z
    .strictObject({
      provider: z.literal('cursor'),
      config: z.strictObject({ workspaceConfigPath: z.string().optional() }),
    })
    .optional(),
  worktrees: z.strictObject({ openInOrca: z.boolean().default(true) }).optional(),
})

const DIRTY = {
  environments: ['dev'],
  ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } },
  worktrees: {},
}

const CLEAN_AFTER = { ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } }, worktrees: {} }

let home: string
let configPath: string
let raw: string
let warnSpy: ReturnType<typeof vi.spyOn>
let debugSpy: ReturnType<typeof vi.spyOn>

const writeLayer = async (parsed: Record<string, unknown>): Promise<AutoMigrateLayer> => {
  raw = `${JSON.stringify(parsed, null, 2)}\n`
  await fs.writeFile(configPath, raw)
  const { mtimeMs } = await fs.stat(configPath)

  return { path: configPath, required: false, autoMigrate: 'write', mtimeMs }
}

const readBack = async (): Promise<string> => {
  return fs.readFile(configPath, 'utf8')
}

beforeEach(async () => {
  vi.clearAllMocks()
  // A runner exports CI=true; every case that expects a write must start from "not CI".
  vi.stubEnv('CI', '')

  home = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-migrate-layer-'))
  configPath = path.join(home, 'infra-kit.json')
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})

describe('tryAutoMigrateLayer', () => {
  it('migrates: rewrites the file, warns once, and returns the schema output', async () => {
    const layer = await writeLayer(DIRTY)

    const outcome = await tryAutoMigrateLayer(layer, DIRTY, raw, { schema })

    // `worktrees.openInOrca` is not in the file: it proves `data` is the second parse, not the raw object.
    expect(outcome).toEqual({
      kind: 'migrated',
      data: { ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } }, worktrees: { openInOrca: true } },
    })
    expect(await readBack()).toBe(`${JSON.stringify(CLEAN_AFTER, null, 2)}\n`)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      `Migrated ~/infra-kit.json: removed legacy "mode" and the retired "environments" key (deploy targets now come from each workflow's workflow_dispatch options, auth from the token store) (retired by infra-kit ${packageJson.version})`,
    )
    expect(debugSpy).not.toHaveBeenCalled()
  })

  it('autoMigrate: off → not-applicable before the registry is even consulted', async () => {
    const layer = await writeLayer(DIRTY)

    const outcome = await tryAutoMigrateLayer({ ...layer, autoMigrate: 'off' }, DIRTY, raw, { schema })

    expect(outcome).toEqual({ kind: 'not-applicable' })
    expect(applyConfigMigrations).not.toHaveBeenCalled()
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
    expect(await readBack()).toBe(raw)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('nothing to migrate (a plain typo key) → not-applicable, no write', async () => {
    const typo = { ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } }, worktree: {} }
    const layer = await writeLayer(typo)

    const outcome = await tryAutoMigrateLayer(layer, typo, raw, { schema })

    expect(outcome).toEqual({ kind: 'not-applicable' })
    expect(applyConfigMigrations).toHaveBeenCalledTimes(1)
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
    expect(await readBack()).toBe(raw)
  })

  it('a retired key AND a second real problem → not-applicable, no write, even on the required layer in CI', async () => {
    vi.stubEnv('CI', 'true')
    const twoProblems = { ...DIRTY, worktree: {} }
    const layer = await writeLayer(twoProblems)

    const outcome = await tryAutoMigrateLayer({ ...layer, required: true }, twoProblems, raw, { schema })

    // Not `ci-gated`: the hint must only appear when a migration would actually have fixed the file.
    expect(outcome).toEqual({ kind: 'not-applicable' })
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
    expect(await readBack()).toBe(raw)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('required layer in CI → ci-gated, file untouched, no line', async () => {
    vi.stubEnv('CI', 'true')
    const layer = await writeLayer(DIRTY)

    const outcome = await tryAutoMigrateLayer({ ...layer, required: true }, DIRTY, raw, { schema })

    expect(outcome).toEqual({ kind: 'ci-gated' })
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
    expect(await readBack()).toBe(raw)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('required layer outside CI → migrated', async () => {
    const layer = await writeLayer(DIRTY)

    const outcome = await tryAutoMigrateLayer({ ...layer, required: true }, DIRTY, raw, { schema })

    expect(outcome.kind).toBe('migrated')
    expect(JSON.parse(await readBack())).toEqual(CLEAN_AFTER)
  })

  it('a per-machine (non-required) layer in CI → migrated', async () => {
    vi.stubEnv('CI', 'true')
    const layer = await writeLayer(DIRTY)

    const outcome = await tryAutoMigrateLayer(layer, DIRTY, raw, { schema })

    expect(outcome.kind).toBe('migrated')
    expect(JSON.parse(await readBack())).toEqual(CLEAN_AFTER)
  })

  it('write failure → one debug line and not-applicable; the migrated value is never returned', async () => {
    const layer = await writeLayer(DIRTY)
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

    vi.mocked(writeMigratedConfigFile).mockRejectedValueOnce(eacces)

    const outcome = await tryAutoMigrateLayer(layer, DIRTY, raw, { schema })

    expect(outcome).toEqual({ kind: 'not-applicable' })
    expect(debugSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledWith(eacces, `auto-migration could not rewrite ${configPath}`)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(await readBack()).toBe(raw)
  })

  it('stale read (the real ConfigFileChangedError path) → debug line, not-applicable, file untouched', async () => {
    const layer = await writeLayer(DIRTY)
    const edited = '{"edited": "by a human"}\n'

    await fs.writeFile(configPath, edited)
    await fs.utimes(configPath, new Date(), new Date(Date.now() + 10_000))

    const outcome = await tryAutoMigrateLayer(layer, DIRTY, raw, { schema })

    expect(outcome).toEqual({ kind: 'not-applicable' })
    expect(writeMigratedConfigFile).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy.mock.calls[0]?.[0]).toBeInstanceOf(ConfigFileChangedError)
    expect(await readBack()).toBe(edited)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('passes the loader-observed mtime through as the stale-read baseline', async () => {
    const layer = await writeLayer(DIRTY)

    await tryAutoMigrateLayer(layer, DIRTY, raw, { schema })

    expect(writeMigratedConfigFile).toHaveBeenCalledWith({
      path: configPath,
      raw,
      migrated: CLEAN_AFTER,
      expectedMtimeMs: layer.mtimeMs,
    })
  })

  it('a single retired zed entry: the whole ide key goes and the layer parses', async () => {
    const zedOnly = { ide: { provider: 'zed', config: {} } }
    const layer = await writeLayer(zedOnly)

    const outcome = await tryAutoMigrateLayer(layer, zedOnly, raw, { schema })

    expect(outcome).toEqual({ kind: 'migrated', data: {} })
    expect(await readBack()).toBe('{}\n')
    expect(warnSpy).toHaveBeenCalledWith(
      `Migrated ~/infra-kit.json: removed the retired "zed" provider (retired by infra-kit ${packageJson.version})`,
    )
  })
})
