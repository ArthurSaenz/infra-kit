import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MockInstance } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildEnvClearLines } from 'src/commands/env-clear/env-clear'
import { buildEnvLoadFileLines } from 'src/commands/env-load'
import { loadJiraConfig } from 'src/integrations/jira/api'
import { atomicWriteFileSync, parseVarNamesFromEnvFile, parseVarsFromEnvFile } from 'src/lib/constants'
import { logger } from 'src/lib/logger'

import { applySessionEnv, readSessionEnvState, resetSessionEnvForTests } from '../session-env'

// `vi.spyOn` cannot intercept a named import — the module under test binds
// `parseVarsFromEnvFile` at import time, so the seam has to be the module itself.
vi.mock('src/lib/constants', async (importOriginal) => {
  const original = await importOriginal<typeof import('src/lib/constants')>()

  return { ...original, parseVarsFromEnvFile: vi.fn(original.parseVarsFromEnvFile) }
})

const SESSION = 'session-env-test'
const JIRA_NAMES = ['JIRA_BASE_URL', 'JIRA_TOKEN', 'JIRA_API_TOKEN', 'JIRA_PROJECT_ID', 'JIRA_EMAIL']
const MANUAL_LOAD_UNSETS = ['INFRA_KIT_ENV_AUTOLOADED', 'INFRA_KIT_ENV_CLEARED']

let cacheHome = ''
let sessionDir = ''
let envSnapshot: NodeJS.ProcessEnv = {}
let info: MockInstance<typeof logger.info>
let warn: MockInstance<typeof logger.warn>

const restoreEnv = (snapshot: NodeJS.ProcessEnv): void => {
  for (const name of Object.keys(process.env)) {
    if (!(name in snapshot)) delete process.env[name]
  }

  Object.assign(process.env, snapshot)
}

/** A second sandboxed session dir, for the lanes that need two states at once. */
const makeSessionDir = (name: string): string => {
  const dir = path.join(cacheHome, 'infra-kit', name)

  fs.mkdirSync(dir, { recursive: true })

  return dir
}

const writeLoad = (
  dir: string,
  pairs: Array<[string, string]>,
  { config = 'dev', autoLoaded = false }: { config?: string; autoLoaded?: boolean } = {},
): string => {
  const file = path.join(dir, 'env-load.sh')
  const lines = buildEnvLoadFileLines({
    pairs,
    config,
    project: 'proj',
    projectRoot: dir,
    loadedAt: '2026-09-15T00:00:00.000Z',
    autoLoaded,
  })

  atomicWriteFileSync(file, `${lines.join('\n')}\n`, 0o600)

  return file
}

const writeClear = (dir: string, names: string[]): string => {
  const file = path.join(dir, 'env-clear.sh')

  atomicWriteFileSync(file, `${buildEnvClearLines(names).join('\n')}\n`, 0o600)

  return file
}

/** What `env-clear` does (env-clear.ts): the clear file over the load file's names, then the load file removed. */
const clearLike = (dir: string): string => {
  const loadFile = path.join(dir, 'env-load.sh')
  const clearFile = writeClear(dir, parseVarNamesFromEnvFile(loadFile))

  fs.rmSync(loadFile, { force: true })

  return clearFile
}

const setMtimeMs = (file: string, ms: number): void => {
  fs.utimesSync(file, ms / 1000, ms / 1000)
}

const linesOf = (spy: MockInstance<typeof logger.info>): unknown[] => {
  return spy.mock.calls.map(([line]) => {
    return line
  })
}

/** Back to the launch environment: the sandboxed session, no Jira, no overlay state. */
const resetToLaunchEnv = (): void => {
  resetSessionEnvForTests()
  restoreEnv(envSnapshot)
  process.env.XDG_CACHE_HOME = cacheHome
  process.env.INFRA_KIT_SESSION = SESSION

  for (const name of JIRA_NAMES) delete process.env[name]
}

beforeEach(() => {
  envSnapshot = { ...process.env }
  cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-env-'))
  sessionDir = makeSessionDir(SESSION)
  resetToLaunchEnv()

  for (const name of MANUAL_LOAD_UNSETS) delete process.env[name]

  info = vi.spyOn(logger, 'info').mockImplementation(() => {})
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  vi.mocked(parseVarsFromEnvFile).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetSessionEnvForTests()
  restoreEnv(envSnapshot)
  fs.rmSync(cacheHome, { recursive: true, force: true })
})

describe('readSessionEnvState — the zshenv rule', () => {
  it('no files → none', () => {
    expect(readSessionEnvState()).toEqual({ kind: 'none', signature: 'none' })
  })

  it('load only → load, with the file’s vars, its unset lines and a load signature', () => {
    writeLoad(sessionDir, [['JIRA_TOKEN', 't']])

    const state = readSessionEnvState()

    expect(state.kind).toBe('load')

    if (state.kind !== 'load') return

    expect(state.vars.JIRA_TOKEN).toBe('t')
    expect(state.vars.INFRA_KIT_ENV_CONFIG).toBe('dev')
    expect(state.unset).toEqual(MANUAL_LOAD_UNSETS)
    expect(state.signature).toMatch(/^load:\d+:[\d.]+:\d+$/)
  })

  it('clear only → clear, with every unset name and a clear signature', () => {
    writeClear(sessionDir, ['JIRA_TOKEN'])

    const state = readSessionEnvState()

    expect(state.kind).toBe('clear')

    if (state.kind !== 'clear') return

    expect(state.unset).toEqual([
      'JIRA_TOKEN',
      'INFRA_KIT_ENV',
      'INFRA_KIT_ENV_CONFIG',
      'INFRA_KIT_ENV_PROJECT',
      'INFRA_KIT_ENV_PROJECT_ROOT',
      'INFRA_KIT_ENV_LOADED_AT',
      'INFRA_KIT_ENV_AUTOLOADED',
    ])
    expect(state.signature).toMatch(/^clear:\d+:[\d.]+$/)
  })

  it('both, load newer → load', () => {
    setMtimeMs(writeClear(sessionDir, ['JIRA_TOKEN']), 1_000_000)
    setMtimeMs(writeLoad(sessionDir, [['JIRA_TOKEN', 't']]), 2_000_000)

    expect(readSessionEnvState().kind).toBe('load')
  })

  it('both, clear strictly newer → clear', () => {
    setMtimeMs(writeLoad(sessionDir, [['JIRA_TOKEN', 't']]), 1_000_000)
    setMtimeMs(writeClear(sessionDir, ['JIRA_TOKEN']), 2_000_000)

    expect(readSessionEnvState().kind).toBe('clear')
  })

  it('equal mtimes → load (the zshenv `! clear -nt load` tie)', () => {
    setMtimeMs(writeLoad(sessionDir, [['JIRA_TOKEN', 't']]), 1_000_000)
    setMtimeMs(writeClear(sessionDir, ['JIRA_TOKEN']), 1_000_000)

    expect(readSessionEnvState().kind).toBe('load')
  })

  it('no session id → no-session, one log line per process, and no `no-session` dir is read', () => {
    delete process.env.INFRA_KIT_SESSION
    const stat = vi.spyOn(fs, 'statSync')

    expect(readSessionEnvState()).toEqual({ kind: 'no-session' })
    expect(readSessionEnvState()).toEqual({ kind: 'no-session' })
    expect(applySessionEnv()).toEqual({ set: [], unset: [], changed: false })

    expect(linesOf(warn)).toEqual(['session-env: INFRA_KIT_SESSION unset — no overlay'])
    expect(linesOf(info)).toEqual([])
    expect(stat).not.toHaveBeenCalled()
  })
})

describe('applySessionEnv', () => {
  it('is synchronous — the result is not a thenable', () => {
    writeLoad(sessionDir, [['JIRA_TOKEN', 't']])

    const result = applySessionEnv()

    expect(typeof (result as { then?: unknown }).then).toBe('undefined')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result.changed).toBe(true)
  })

  it('captures the baseline at the first call, so load → clear → none restores process.env exactly (AC5)', () => {
    process.env.SESSION_ENV_SENTINEL = 'launch'
    const before = { ...process.env }

    writeLoad(sessionDir, [
      ['JIRA_TOKEN', 'a'],
      ['SESSION_ENV_SENTINEL', 'from-file'],
    ])
    applySessionEnv()
    expect(process.env.JIRA_TOKEN).toBe('a')
    expect(process.env.SESSION_ENV_SENTINEL).toBe('from-file')

    clearLike(sessionDir)
    applySessionEnv()
    expect(process.env.JIRA_TOKEN).toBeUndefined()
    expect(process.env.INFRA_KIT_ENV_CLEARED).toBe('1')

    fs.rmSync(path.join(sessionDir, 'env-clear.sh'))
    expect(applySessionEnv().changed).toBe(true)
    expect({ ...process.env }).toEqual(before)
  })

  it('reports set/unset names on a manual load and drops the load file’s unset markers', () => {
    process.env.INFRA_KIT_ENV_CLEARED = '1'
    writeLoad(sessionDir, [['JIRA_TOKEN', 't']])

    const result = applySessionEnv()

    expect(result.set).toEqual([
      'JIRA_TOKEN',
      'INFRA_KIT_ENV',
      'INFRA_KIT_ENV_CONFIG',
      'INFRA_KIT_ENV_PROJECT',
      'INFRA_KIT_ENV_PROJECT_ROOT',
      'INFRA_KIT_ENV_LOADED_AT',
    ])
    expect(result.unset).toEqual(MANUAL_LOAD_UNSETS)
    expect(process.env.INFRA_KIT_ENV_CLEARED).toBeUndefined()
  })

  it('short-circuits on an unchanged signature without re-parsing, and re-parses a same-content atomic rewrite', () => {
    const file = writeLoad(sessionDir, [['JIRA_TOKEN', 't']])
    const content = fs.readFileSync(file, 'utf8')
    const { ino } = fs.statSync(file)

    expect(applySessionEnv().changed).toBe(true)
    expect(applySessionEnv()).toEqual({ set: [], unset: [], changed: false })
    expect(vi.mocked(parseVarsFromEnvFile)).toHaveBeenCalledTimes(1)
    expect(linesOf(info)).toHaveLength(1)

    atomicWriteFileSync(file, content, 0o600)
    expect(fs.statSync(file).ino).not.toBe(ino)
    expect(applySessionEnv().changed).toBe(true)
    expect(vi.mocked(parseVarsFromEnvFile)).toHaveBeenCalledTimes(2)
  })

  it('a clear subtracts names the baseline holds; none brings them back (AC10, AC5)', () => {
    process.env.JIRA_TOKEN = 'launch'
    process.env.INFRA_KIT_ENV_CONFIG = 'dev'

    writeClear(sessionDir, ['JIRA_TOKEN'])
    applySessionEnv()
    expect(process.env.JIRA_TOKEN).toBeUndefined()
    expect(process.env.INFRA_KIT_ENV_CONFIG).toBeUndefined()
    expect(process.env.INFRA_KIT_ENV_CLEARED).toBe('1')

    fs.rmSync(path.join(sessionDir, 'env-clear.sh'))
    applySessionEnv()
    expect(process.env.JIRA_TOKEN).toBe('launch')
    expect(process.env.INFRA_KIT_ENV_CONFIG).toBe('dev')
    expect(process.env.INFRA_KIT_ENV_CLEARED).toBeUndefined()
  })

  it('a13: baseline dev, clear(dev), then load(arthur) yields dev ∪ arthur with arthur winning per name', () => {
    process.env.JIRA_TOKEN = 'dev-token'
    process.env.DEV_ONLY = 'dev'

    setMtimeMs(writeClear(sessionDir, ['JIRA_TOKEN', 'DEV_ONLY']), 1_000_000)
    applySessionEnv()
    expect(process.env.JIRA_TOKEN).toBeUndefined()
    expect(process.env.DEV_ONLY).toBeUndefined()

    setMtimeMs(
      writeLoad(
        sessionDir,
        [
          ['JIRA_TOKEN', 'arthur-token'],
          ['ARTHUR_ONLY', 'arthur'],
        ],
        { config: 'arthur' },
      ),
      2_000_000,
    )
    applySessionEnv()
    expect(process.env.JIRA_TOKEN).toBe('arthur-token')
    expect(process.env.DEV_ONLY).toBe('dev')
    expect(process.env.ARTHUR_ONLY).toBe('arthur')
    expect(process.env.INFRA_KIT_ENV_CLEARED).toBeUndefined()
  })

  it('aC4: protected names are skipped on assign and on unset, and named once', () => {
    const originalPath = process.env.PATH

    fs.writeFileSync(
      path.join(sessionDir, 'env-load.sh'),
      "set -a\nPATH='/nowhere'\nINFRA_KIT_SESSION='other'\nJIRA_TOKEN='t'\nset +a\n",
    )

    const result = applySessionEnv()

    expect(result.set).toEqual(['JIRA_TOKEN'])
    expect(process.env.PATH).toBe(originalPath)
    expect(process.env.INFRA_KIT_SESSION).toBe(SESSION)
    expect(linesOf(warn)).toEqual(['session-env: skipped protected names [PATH, INFRA_KIT_SESSION]'])
    expect(readSessionEnvState().kind).toBe('load')

    warn.mockClear()
    fs.rmSync(path.join(sessionDir, 'env-load.sh'))
    writeClear(sessionDir, ['PATH', 'XDG_CACHE_HOME', 'JIRA_TOKEN'])

    expect(applySessionEnv().unset).toEqual([
      'JIRA_TOKEN',
      'INFRA_KIT_ENV',
      'INFRA_KIT_ENV_CONFIG',
      'INFRA_KIT_ENV_PROJECT',
      'INFRA_KIT_ENV_PROJECT_ROOT',
      'INFRA_KIT_ENV_LOADED_AT',
      'INFRA_KIT_ENV_AUTOLOADED',
    ])
    expect(process.env.PATH).toBe(originalPath)
    expect(process.env.XDG_CACHE_HOME).toBe(cacheHome)
    expect(linesOf(warn)).toEqual(['session-env: skipped protected names [PATH, XDG_CACHE_HOME]'])
  })

  it('aC9: flow 1 — a baseline that already holds the file’s vars is unchanged by the first apply', () => {
    const file = writeLoad(sessionDir, [
      ['JIRA_TOKEN', 't'],
      ['JIRA_EMAIL', 'e'],
    ])

    Object.assign(process.env, parseVarsFromEnvFile(file))
    const before = { ...process.env }

    expect(applySessionEnv().changed).toBe(true)
    expect({ ...process.env }).toEqual(before)
  })

  it('two applies of different states back-to-back leave process.env equal to exactly one full result', () => {
    const otherDir = makeSessionDir('other-session')

    writeLoad(sessionDir, [
      ['JIRA_TOKEN', 'first'],
      ['FIRST_ONLY', '1'],
    ])
    writeLoad(otherDir, [['JIRA_TOKEN', 'second']], { config: 'arthur' })

    const first = readSessionEnvState(sessionDir)
    const second = readSessionEnvState(otherDir)

    applySessionEnv(first)
    const firstResult = { ...process.env }

    resetToLaunchEnv()
    applySessionEnv(second)
    const secondResult = { ...process.env }

    resetToLaunchEnv()
    applySessionEnv(first)
    applySessionEnv(second)

    expect(firstResult).not.toEqual(secondResult)
    expect([firstResult, secondResult]).toContainEqual({ ...process.env })
  })

  it('s3: a read that fails between stat and parse yields a zero-var load, never throws, and the next state wins', () => {
    const file = writeLoad(sessionDir, [['JIRA_TOKEN', 't']])
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw enoent
    })

    const result = applySessionEnv()

    expect(result.changed).toBe(true)
    expect(result.set).toEqual([])
    expect(process.env.JIRA_TOKEN).toBeUndefined()

    // The race completes: the writer's rename landed a new inode, which the next stat sees.
    atomicWriteFileSync(file, fs.readFileSync(file, 'utf8'), 0o600)
    expect(applySessionEnv().set).toContain('JIRA_TOKEN')
    expect(process.env.JIRA_TOKEN).toBe('t')
  })

  it('logs one string line per apply, names only, never a value, and nothing when unchanged', () => {
    writeLoad(sessionDir, [
      ['JIRA_TOKEN', 'jira-sentinel-8f3a'],
      ['JIRA_EMAIL', 'sentinel@example.invalid'],
    ])
    applySessionEnv()
    applySessionEnv()
    clearLike(sessionDir)
    applySessionEnv()
    fs.rmSync(path.join(sessionDir, 'env-clear.sh'))
    applySessionEnv()

    expect(linesOf(info)).toEqual([
      'session-env applied: set [JIRA_TOKEN, JIRA_EMAIL, INFRA_KIT_ENV, INFRA_KIT_ENV_CONFIG, INFRA_KIT_ENV_PROJECT, INFRA_KIT_ENV_PROJECT_ROOT, INFRA_KIT_ENV_LOADED_AT] unset [INFRA_KIT_ENV_AUTOLOADED, INFRA_KIT_ENV_CLEARED] (load, 7 vars)',
      // env-clear lists the load file's marker assignments AND its own marker lines, so the
      // names repeat — the log mirrors the file rather than deduplicating it.
      'session-env applied: set [INFRA_KIT_ENV_CLEARED] unset [JIRA_TOKEN, JIRA_EMAIL, INFRA_KIT_ENV, INFRA_KIT_ENV_CONFIG, INFRA_KIT_ENV_PROJECT, INFRA_KIT_ENV_PROJECT_ROOT, INFRA_KIT_ENV_LOADED_AT, INFRA_KIT_ENV, INFRA_KIT_ENV_CONFIG, INFRA_KIT_ENV_PROJECT, INFRA_KIT_ENV_PROJECT_ROOT, INFRA_KIT_ENV_LOADED_AT, INFRA_KIT_ENV_AUTOLOADED] (clear)',
      'session-env applied: set [] unset [] (none)',
    ])

    const everyArg = JSON.stringify([...info.mock.calls, ...warn.mock.calls])

    expect(everyArg).not.toContain('jira-sentinel-8f3a')
    expect(everyArg).not.toContain('sentinel@example.invalid')
    expect(everyArg).not.toContain('"vars"')
  })
})

describe('the read site, in-process (§6.2b)', () => {
  it('loadJiraConfig sees the overlay: incomplete → the file’s values → incomplete again', async () => {
    await expect(loadJiraConfig()).rejects.toThrow(/incomplete/)

    writeLoad(sessionDir, [
      ['JIRA_BASE_URL', 'http://127.0.0.1:1/'],
      ['JIRA_TOKEN', 'jira-sentinel-8f3a'],
      ['JIRA_PROJECT_ID', '1'],
      ['JIRA_EMAIL', 'sentinel@example.invalid'],
    ])
    applySessionEnv()

    await expect(loadJiraConfig()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:1',
      token: 'jira-sentinel-8f3a',
      projectId: 1,
      email: 'sentinel@example.invalid',
    })

    clearLike(sessionDir)
    applySessionEnv()

    await expect(loadJiraConfig()).rejects.toThrow(/incomplete/)
  })
})
