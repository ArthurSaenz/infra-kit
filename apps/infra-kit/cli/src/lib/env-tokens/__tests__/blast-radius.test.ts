import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { worktreesList } from 'src/commands/worktrees-list'
import { ensureUserProjectConfig, resetUserProjectSeedGuard } from 'src/lib/config-bootstrap'
import { getInfraKitConfig, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { readTokenStore } from '../env-tokens'

/**
 * The blast-radius criterion, and the whole reason `tokens.json` is a SIBLING of the layer-3 config
 * rather than a key inside it: a corrupt token store must break its three readers and NOTHING else.
 *
 * Deliberately NOT mocked: git-utils is real (a throwaway `git init` repo, cwd'd into), the config
 * loader is real, and `worktreesList` is the real command — the same entry path every command takes
 * (`ensureUserProjectConfig` on the preAction hook, then the config merge). Mocking any of those out
 * is exactly how this test would become a false green.
 */

const VALID_CONFIG = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'infra-kit' } },
})

let home: string
let repo: string
let originalCwd: string
let storePath: string

beforeEach(async () => {
  // The bootstrap's kill switch is armed globally in vitest.setup.ts; disarm it (truthiness check)
  // so the real preAction seed runs — against the stubbed temp HOME below, never the developer's.
  vi.stubEnv('INFRA_KIT_NO_SEED', '')

  originalCwd = process.cwd()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-home-'))
  // git reports the REALPATH as the toplevel, so canonicalize here or the repo basename (and hence
  // the store dir) would be derived from a different string on macOS (/var → /private/var).
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-repo-')))

  await $({ cwd: repo })`git init --quiet`
  fs.writeFileSync(path.join(repo, 'infra-kit.json'), VALID_CONFIG)

  storePath = path.join(home, '.infra-kit', 'projects', path.basename(repo), 'tokens.json')

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.spyOn(logger, 'info').mockImplementation(() => {})

  process.chdir(repo)
  // zx SNAPSHOTS process.cwd() at import time (`$[CWD]`) and spawns with `$.cwd || $[CWD]`, so a
  // bare `process.chdir` does NOT move `git rev-parse` — without this every git call below would run
  // in the REAL infra-kit repo and the whole file would be a false green (verified: it was).
  $.cwd = repo

  resetUserProjectSeedGuard()
  resetInfraKitConfigCache()
})

afterEach(() => {
  process.chdir(originalCwd)
  $.cwd = originalCwd
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetUserProjectSeedGuard()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('a corrupt tokens.json', () => {
  const writeGarbageStore = (): void => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, 'garbage')
  }

  it('does not brick an unrelated command: worktrees-list still succeeds', async () => {
    writeGarbageStore()

    // The entry boundary every command crosses (CLI preAction / MCP tool call).
    await expect(ensureUserProjectConfig()).resolves.toBeUndefined()

    const result = await worktreesList()

    expect(result.structuredContent).toEqual({ worktrees: [], count: 0 })
  })

  it('does not brick the config merge chain — the loader never globs the sibling', async () => {
    writeGarbageStore()

    await expect(getInfraKitConfig()).resolves.toMatchObject({
      envManagement: { provider: 'doppler', config: { name: 'infra-kit' } },
    })
  })

  it('throws ONLY in the token store reader', async () => {
    writeGarbageStore()

    await expect(readTokenStore()).rejects.toThrow(/Invalid JSON in the token store/)
  })
})
