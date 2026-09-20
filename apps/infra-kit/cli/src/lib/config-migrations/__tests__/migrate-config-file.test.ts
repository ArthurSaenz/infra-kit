import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyConfigMigrations } from '../apply-config-migrations'
import { ConfigFileChangedError, migrateConfigFile, writeMigratedConfigFile } from '../migrate-config-file'

// Spy mode keeps the real fold and lets the writer's "never applies the registry" contract be
// asserted as a call count — a plain `vi.spyOn` on the namespace would not intercept the writer's
// own named import (memory: vispy-cannot-intercept-named-fs-imports).
vi.mock('../apply-config-migrations', { spy: true })

const DIRTY = {
  environments: ['dev'],
  envManagement: { provider: 'doppler', config: { name: 'p' } },
  ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } },
}

const CLEAN_AFTER = {
  envManagement: { provider: 'doppler', config: { name: 'p' } },
  ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
}

let dir: string
let configPath: string

const listTmpFiles = async (inDir: string): Promise<string[]> => {
  return (await fs.readdir(inDir)).filter((name) => {
    return name.endsWith('.tmp')
  })
}

const writeDirty = async (indent: string | number = 2): Promise<string> => {
  const raw = `${JSON.stringify(DIRTY, null, indent)}\n`

  await fs.writeFile(configPath, raw)

  return raw
}

beforeEach(async () => {
  vi.clearAllMocks()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-migrations-'))
  configPath = path.join(dir, 'infra-kit.json')
})

afterEach(async () => {
  // A test may have made the dir read-only; restore so the recursive rm can clean it up.
  await fs.chmod(dir, 0o700)
  await fs.rm(dir, { recursive: true, force: true })
})

describe('migrateConfigFile', () => {
  it('rewrites a dirty file with the detected indent and a trailing newline', async () => {
    await writeDirty(2)

    const outcome = await migrateConfigFile(configPath)

    expect(outcome).toEqual({
      changed: true,
      result: CLEAN_AFTER,
      notes: ['legacy "mode"', expect.any(String)],
      path: configPath,
    })
    expect(await fs.readFile(configPath, 'utf8')).toBe(`${JSON.stringify(CLEAN_AFTER, null, 2)}\n`)
  })

  it('preserves a 4-space indent instead of reformatting the file wholesale', async () => {
    await writeDirty(4)

    await migrateConfigFile(configPath)

    expect(await fs.readFile(configPath, 'utf8')).toBe(`${JSON.stringify(CLEAN_AFTER, null, 4)}\n`)
  })

  it('preserves a tab indent', async () => {
    await writeDirty('\t')

    await migrateConfigFile(configPath)

    expect(await fs.readFile(configPath, 'utf8')).toBe(`${JSON.stringify(CLEAN_AFTER, null, '\t')}\n`)
  })

  it('falls back to 2 spaces for a single-line file', async () => {
    await fs.writeFile(configPath, JSON.stringify(DIRTY))

    await migrateConfigFile(configPath)

    expect(await fs.readFile(configPath, 'utf8')).toBe(`${JSON.stringify(CLEAN_AFTER, null, 2)}\n`)
  })

  it('leaves a clean file byte-for-byte untouched with its mtime unchanged', async () => {
    const raw = '{"envManagement":{"provider":"doppler","config":{"name":"p"}}}'

    await fs.writeFile(configPath, raw)
    const before = await fs.stat(configPath)

    const outcome = await migrateConfigFile(configPath)

    expect(outcome.changed).toBe(false)
    expect(outcome.notes).toEqual([])
    expect(await fs.readFile(configPath, 'utf8')).toBe(raw)
    expect((await fs.stat(configPath)).mtimeMs).toBe(before.mtimeMs)
    expect(await listTmpFiles(dir)).toEqual([])
  })

  it('treats an empty or whitespace-only file as a no-op, not a JSON error', async () => {
    await fs.writeFile(configPath, '')

    await expect(migrateConfigFile(configPath)).resolves.toMatchObject({ changed: false, notes: [] })
    expect(await fs.readFile(configPath, 'utf8')).toBe('')

    await fs.writeFile(configPath, '\n  \n')

    await expect(migrateConfigFile(configPath)).resolves.toMatchObject({ changed: false })
    expect(await fs.readFile(configPath, 'utf8')).toBe('\n  \n')
  })

  it('leaves no .tmp file behind after a rewrite', async () => {
    await writeDirty()

    await migrateConfigFile(configPath)

    expect(await listTmpFiles(dir)).toEqual([])
  })

  it('keeps a symlinked target a symlink and rewrites the link target', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-migrations-target-'))
    const target = path.join(targetDir, 'dotfiles-infra-kit.json')

    try {
      await fs.writeFile(target, `${JSON.stringify(DIRTY, null, 2)}\n`)
      await fs.symlink(target, configPath)

      await migrateConfigFile(configPath)

      expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true)
      expect(await fs.readlink(configPath)).toBe(target)
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual(CLEAN_AFTER)
      expect(await listTmpFiles(targetDir)).toEqual([])
      expect(await listTmpFiles(dir)).toEqual([])
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it('preserves a 0600 mode on the rewritten file', async () => {
    await fs.writeFile(configPath, `${JSON.stringify(DIRTY, null, 2)}\n`, { mode: 0o600 })
    await fs.chmod(configPath, 0o600)

    await migrateConfigFile(configPath)

    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
  })

  // root ignores directory permission bits, so the EACCES can only be observed unprivileged.
  it.skipIf(process.getuid?.() === 0)(
    'throws when the directory is not writable and leaves the file untouched',
    async () => {
      const raw = await writeDirty()

      await fs.chmod(dir, 0o500)

      await expect(migrateConfigFile(configPath)).rejects.toMatchObject({ code: 'EACCES' })

      expect(await fs.readFile(configPath, 'utf8')).toBe(raw)
    },
  )

  it('throws ConfigFileChangedError and leaves the target untouched when the file moved on since the read', async () => {
    const raw = await writeDirty()
    const { mtimeMs } = await fs.stat(configPath)
    const edited = '{"edited": "by a human"}\n'

    await fs.writeFile(configPath, edited)
    // Filesystems with coarse timestamps could otherwise produce an identical mtime for two writes
    // inside one tick; push it well clear.
    await fs.utimes(configPath, new Date(), new Date(Date.now() + 10_000))

    await expect(
      writeMigratedConfigFile({ path: configPath, raw, migrated: CLEAN_AFTER, expectedMtimeMs: mtimeMs }),
    ).rejects.toBeInstanceOf(ConfigFileChangedError)

    expect(await fs.readFile(configPath, 'utf8')).toBe(edited)
    expect(await listTmpFiles(dir)).toEqual([])
  })

  it('leaves identical final bytes when two writers race on the same content', async () => {
    const raw = await writeDirty()
    const { mtimeMs } = await fs.stat(configPath)
    const write = (): Promise<void> => {
      return writeMigratedConfigFile({ path: configPath, raw, migrated: CLEAN_AFTER, expectedMtimeMs: mtimeMs })
    }

    const settled = await Promise.allSettled([write(), write()])

    expect(
      settled.some((outcome) => {
        return outcome.status === 'fulfilled'
      }),
    ).toBe(true)
    // The loser (if any) is the stale-read guard, never a torn write.
    for (const outcome of settled) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(ConfigFileChangedError)
    }
    expect(await fs.readFile(configPath, 'utf8')).toBe(`${JSON.stringify(CLEAN_AFTER, null, 2)}\n`)
    expect(await listTmpFiles(dir)).toEqual([])
  })
})

describe('registry runs exactly once per file', () => {
  it('migrateConfigFile applies the registry once', async () => {
    await writeDirty()

    await migrateConfigFile(configPath)

    expect(applyConfigMigrations).toHaveBeenCalledTimes(1)
  })

  it('writeMigratedConfigFile never applies the registry — the caller already did', async () => {
    const raw = await writeDirty()
    const { mtimeMs } = await fs.stat(configPath)

    await writeMigratedConfigFile({ path: configPath, raw, migrated: CLEAN_AFTER, expectedMtimeMs: mtimeMs })

    expect(applyConfigMigrations).toHaveBeenCalledTimes(0)
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual(CLEAN_AFTER)
  })
})
