import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MARKER_END, MARKER_START, buildZshenvBlock, initCore, logInitEntry } from '../init'

// Same isolation as init-zshrc-write.test.ts: stub the migration/seed collaborators to no-ops so only
// the real upsertManagedBlock + writeFileSync path executes against a temp $HOME.
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
    // `null`: no git root, so the pointer, install and `.mcp.json` steps stay no-ops here too.
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
let zshenvPath: string

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-zshenv-'))
  zshenvPath = path.join(home, '.zshenv')
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  // Keep the layer-3 reseed a no-op — it needs a git repo we don't have here.
  process.env.INFRA_KIT_NO_SEED = '1'
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.INFRA_KIT_NO_SEED
  fs.rmSync(home, { recursive: true, force: true })
})

const runInit = async (): Promise<void> => {
  await initCore(logInitEntry)
}

/** Everything in `content` that is not the managed block — the bytes the writer must never touch. */
const outsideMarkers = (content: string): string => {
  const start = content.indexOf(MARKER_START)
  const end = content.indexOf(MARKER_END) + MARKER_END.length

  return start === -1 ? content : content.slice(0, start) + content.slice(end)
}

describe('setup --skip-tools — ~/.zshenv injection', () => {
  it('creates ~/.zshenv holding exactly the block when none exists', async () => {
    await runInit()

    expect(fs.readFileSync(zshenvPath, 'utf-8')).toBe(`${buildZshenvBlock()}\n`)
  })

  it('is idempotent — running twice leaves exactly one block', async () => {
    await runInit()
    await runInit()

    const written = fs.readFileSync(zshenvPath, 'utf-8')
    const occurrences = written.match(new RegExp(MARKER_START, 'g'))?.length

    expect(occurrences).toBe(1)
    expect(written).toContain(buildZshenvBlock())
  })

  it('leaves user content outside the markers byte-identical and appends the first install at end-of-file', async () => {
    const user = '# my env\nexport XDG_CACHE_HOME="$HOME/.xdg-cache"\n'

    fs.writeFileSync(zshenvPath, user)

    await runInit()

    const written = fs.readFileSync(zshenvPath, 'utf-8')

    // The user's bytes verbatim, then the block: their own XDG_CACHE_HOME export sits above it, so the
    // block's path expansion sees it.
    expect(written).toBe(`${user}${buildZshenvBlock()}\n`)
  })

  it('keeps a block the user moved above their own content in place (replace-in-place, not append-end)', async () => {
    await runInit()
    const trailing = '\n# added after setup\nexport LATER=1\n'

    fs.appendFileSync(zshenvPath, trailing)
    const before = fs.readFileSync(zshenvPath, 'utf-8')

    await runInit()

    const written = fs.readFileSync(zshenvPath, 'utf-8')

    expect(written).toBe(before)
    expect(written.indexOf(MARKER_START)).toBeLessThan(written.indexOf('export LATER=1'))
    expect(outsideMarkers(written)).toBe(outsideMarkers(before))
  })
})
