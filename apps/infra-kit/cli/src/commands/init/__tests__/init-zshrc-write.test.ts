import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MARKER_START, buildShellBlock, initCore, logInitEntry } from '../init'

// Isolate the additive half's ~/.zshrc injection from the config-migration/seed machinery:
// stub the collaborators to no-ops so only the real removeExistingBlock +
// upsertManagedBlock + writeFileSync path executes against a temp $HOME.
vi.mock('../migrate-config', () => {
  return {
    migrateFactoryConfigToJson: vi.fn(async () => {}),
    migrateLegacyConfig: vi.fn(async () => {}),
    migrateCmuxConfigToOrca: vi.fn(async () => {}),
    migrateUserGlobalConfigFilename: vi.fn(async () => {}),
    normalizeLegacyIdeStructures: vi.fn(async () => {}),
  }
})

vi.mock('../agent-files', () => {
  return {
    // `null`: no git root here either, so the pointer, install and `.mcp.json` steps stay the
    // no-ops this suite needs — the gate split gave them their own resolver, separate from the
    // guidance sync's. `initCore` calls the announcing wrapper, so that is the name to stub; the bare
    // predicate is `doctor`'s, and this suite never reaches it.
    resolveGitRootForWrites: vi.fn(async () => {
      return null
    }),
    writeAgentFiles: vi.fn(async () => {}),
    syncRepoGuidance: vi.fn(async () => {
      return { skipped: true, root: null, version: '0.0.0-test', written: [] }
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let home: string
let zshrcPath: string

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-zshrc-'))
  zshrcPath = path.join(home, '.zshrc')
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  // Keep the layer-3 reseed a no-op — it needs a git repo we don't have here.
  process.env.INFRA_KIT_NO_SEED = '1'
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.INFRA_KIT_NO_SEED
  fs.rmSync(home, { recursive: true, force: true })
})

/**
 * The additive half on its own: `initCore` with the CLI's entry logger, which is exactly what
 * `infra-kit setup --skip-tools` runs (setup wraps the same sink only to hold its closing
 * shell-activation line back until after the dependency half). The standalone `init` command this
 * suite used to drive no longer exists, so the pairing IS the subject now.
 */
const runInit = async (): Promise<void> => {
  await initCore(logInitEntry)
}

describe('setup --skip-tools — ~/.zshrc injection', () => {
  it('creates ~/.zshrc with the current shell block when none exists', async () => {
    await runInit()

    const written = fs.readFileSync(zshrcPath, 'utf-8')

    expect(written).toContain(buildShellBlock())
  })

  it('is idempotent — running twice leaves exactly one block', async () => {
    await runInit()
    await runInit()

    const written = fs.readFileSync(zshrcPath, 'utf-8')
    const occurrences = written.match(new RegExp(MARKER_START, 'g'))?.length

    expect(occurrences).toBe(1)
    expect(written).toContain(buildShellBlock())
  })

  it('preserves pre-existing user content and appends the block at end-of-file', async () => {
    fs.writeFileSync(zshrcPath, '# my rc\nexport USER_VAR=42\n')

    await runInit()

    const written = fs.readFileSync(zshrcPath, 'utf-8')

    expect(written).toContain('export USER_VAR=42')
    expect(written.indexOf('export USER_VAR=42')).toBeLessThan(written.indexOf(MARKER_START))
    expect(written).toContain(buildShellBlock())
  })
})
