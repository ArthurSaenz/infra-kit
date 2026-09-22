/* eslint-disable sonarjs/no-os-command-from-path */
import * as esbuild from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CheckResult } from 'src/commands/doctor/doctor'
import { formatDoctorReport } from 'src/commands/doctor/report'

import { buildOptions } from '../../../scripts/build.js'

/**
 * @fileoverview
 *
 * INTEGRATION tests for the "fail honestly outside an infra-kit project" plan
 * (plan-fail-honestly-v4.md, Test strategy → Integration, I1–I10; I9 went with the
 * MCP server in 0.10.0). These are the cases table/unit tests structurally cannot
 * catch: they need the REAL bundled CLI spawned with an explicit cwd + child env and
 * a real git repo / worktree fixture.
 *
 * HERMETIC BUILD — repo memory "dist-reading tests are vacuous": `qa` has no build
 * step, turbo `test` depends on `^build` (deps, not self), and the `dist` dir is
 * gitignored, so reading `dist/` would test a stale or absent bundle. We build fresh
 * IN-TEST via `scripts/build.js`'s EXPORTED `buildOptions` (the same object the real
 * build uses — a hand-copied flag set would drift and guard nothing).
 *
 * WHERE WE BUILD — into this package's `node_modules/.cache`, exactly as
 * quit-keys-pty.test.ts does: `buildOptions` leaves dependencies external, so the
 * bundle only resolves `zx`, `pino` & co. by walking up to a `node_modules` that
 * exists ABOVE it. Built into `os.tmpdir()` it would die on ERR_MODULE_NOT_FOUND
 * before running. The CLI's OWN cwd (its git context) is the spawn `cwd`, which is
 * independent of where the bundle lives.
 */

const KILL_SWITCHES = {
  INFRA_KIT_NO_SEED: '1',
  INFRA_KIT_NO_AUTO_UPDATE: '1',
  INFRA_KIT_NO_LOCATION_WARN: '1',
} as const

const VALID_CONFIG = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'test' } },
})

const NO_STACK = /\n[ \t]+at\s/
const GIT_FATAL = 'fatal: not a git repository'

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  out: string
}

let cliPath = ''
const tmpDirs: string[] = []

/**
 * Build the child env: the current env (PATH is needed so the spawned CLI can find `git`) plus the
 * three kill switches. `overrides` set a value, or DELETE the key when the value is `undefined`
 * (I2 deletes `INFRA_KIT_NO_SEED` to arm the seed leg).
 */
// `CLAUDECODE` / `INFRA_KIT_AGENT` are scrubbed: the child's stdin is a pipe, so under Claude Code's
// runner the inherited `CLAUDECODE=1` would put it in agent mode (lib/agent-mode) and every
// human-channel remediation here would render its agent wording instead. `INFRA_KIT_SESSION` too: the
// entry overlays the session dir's env-load.sh onto the child, and the developer's real one must not reach it.
const cleanEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...KILL_SWITCHES }

  delete env.CLAUDECODE
  delete env.INFRA_KIT_AGENT
  delete env.INFRA_KIT_SESSION

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  return env
}

/** Spawn the freshly-built CLI with an explicit cwd + env and collect its streams and exit code. */
const runCli = (args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<CliResult> => {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: opts.cwd,
      env: opts.env ?? cleanEnv(),
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr, out: stdout + stderr })
    })
  })
}

const mkTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `fail-honestly-${prefix}-`))

  tmpDirs.push(dir)

  return dir
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** `git init` a clean repo with an identity and an initial empty commit (a clean tree). */
const initRepo = (dir: string): void => {
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@infra-kit.test')
  git(dir, 'config', 'user.name', 'Infra Kit Test')
  git(dir, 'commit', '--allow-empty', '-qm', 'init')
}

/** A git repo that is NOT an infra-kit project (no infra-kit.json), clean tree. */
const makeNonProjectGitRepo = (): string => {
  const dir = mkTmp('nonproject-git')

  initRepo(dir)

  return dir
}

/** A committed infra-kit project (git repo + infra-kit.json). */
const makeProject = (parent: string, name: string, config: string): string => {
  const dir = join(parent, name)

  mkdirSync(dir, { recursive: true })
  initRepo(dir)
  writeFileSync(join(dir, 'infra-kit.json'), config)
  git(dir, 'add', 'infra-kit.json')
  git(dir, 'commit', '-qm', 'add infra-kit.json')

  return dir
}

beforeAll(async () => {
  const cache = resolve(__dirname, '../../..', 'node_modules', '.cache')

  mkdirSync(cache, { recursive: true })

  const outDir = mkdtempSync(join(cache, 'fail-honestly-cli-'))

  tmpDirs.push(outDir)

  await esbuild.build({ ...buildOptions, outdir: outDir })

  cliPath = join(outDir, 'cli.js')
}, 120_000)

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('outside any git repo (kill switches on)', () => {
  // I1 — outside git, kill switches on. `worktrees list` bottoms out at getProjectRoot (via
  // getInfraKitConfig → getInfraKitConfigPaths), which now throws the Step 1 typed error.
  it('i1: worktrees list exits 1 with the Step 1 remediation, no fatal:, no stack', async () => {
    const cwd = mkTmp('no-git')

    const result = await runCli(['worktrees', 'list'], { cwd, env: cleanEnv() })

    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain('run infra-kit from inside an infra-kit project repo')
    expect(result.out).not.toContain(GIT_FATAL)
    expect(NO_STACK.test(result.out), `unexpected stack trace:\n${result.out}`).toBe(false)
  }, 30_000)

  // I2 — outside git, seed leg ARMED (INFRA_KIT_NO_SEED removed, HOME redirected). Step 1's
  // `{ quiet: true }` must suppress every `fatal:` leak from the preAction legs, and outside git the
  // seed returns before writing, so nothing lands under $HOME/.infra-kit/projects/.
  it('i2: no fatal: lines and no files seeded under $HOME even with the seed leg armed', async () => {
    const cwd = mkTmp('no-git-seed')
    const home = mkTmp('home')

    const result = await runCli(['worktrees', 'list'], {
      cwd,
      env: cleanEnv({ INFRA_KIT_NO_SEED: undefined, HOME: home }),
    })

    expect(result.code, result.out).toBe(1)
    expect(result.out).not.toContain(GIT_FATAL)

    const projectsDir = join(home, '.infra-kit', 'projects')

    const seeded = existsSync(projectsDir) ? readdirSync(projectsDir) : []

    expect(seeded, `unexpected seeded files under ${projectsDir}`).toEqual([])
  }, 30_000)
})

describe('inside a git repo that is not an infra-kit project', () => {
  // I3 (CO-HEADLINE) — worktrees list is the silent liar here today. Post-fix it throws the Step 4
  // config message and NEVER prints the fabricated "No active worktrees found".
  it('i3: worktrees list exits 1, no "No active worktrees found", config message present', async () => {
    const cwd = makeNonProjectGitRepo()

    const result = await runCli(['worktrees', 'list'], { cwd, env: cleanEnv() })

    expect(result.code, result.out).toBe(1)
    expect(result.out).not.toContain('No active worktrees found')
    expect(result.out).toContain('infra-kit.json not found at')
  }, 30_000)

  // I4a — worktrees remove. Pre-fix this exits 0 with "No active worktrees to remove"; post-fix it
  // throws before the try block, so neither that log nor any removal marker appears.
  it('i4a: worktrees remove --versions 1.2.3 --yes exits 1 with config message, no removal', async () => {
    const cwd = makeNonProjectGitRepo()

    const result = await runCli(['worktrees', 'remove', '--versions', '1.2.3', '--yes'], {
      cwd,
      env: cleanEnv(),
    })

    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain('infra-kit.json not found at')
    // The hoisted read precedes the try — the destructive path never logs its empty-set success and
    // never reports a removal.
    expect(result.out).not.toContain('No active worktrees to remove')
    expect(result.out).not.toContain('removedWorktrees')
  }, 30_000)

  // I4b — worktrees sync. POST-FIX deterministic state only (its false-success path is gh-dependent;
  // no "prove it lies today" step, per the plan).
  it('i4b: worktrees sync --yes exits 1 with config message, no unused-worktree removal', async () => {
    const cwd = makeNonProjectGitRepo()

    const result = await runCli(['worktrees', 'sync', '--yes'], { cwd, env: cleanEnv() })

    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain('infra-kit.json not found at')
    expect(result.out).not.toContain('No unused worktrees to remove')
  }, 30_000)
})

describe('non-regression: real project and its linked worktree', () => {
  // I5 (AC4) — from inside a LINKED WORKTREE of a real project, `worktrees list` still succeeds. The
  // regression is invisible in a main checkout.
  it('i5: worktrees list succeeds from inside a linked worktree', async () => {
    const base = mkTmp('worktree-base')
    const mainRepo = makeProject(base, 'main-repo', VALID_CONFIG)
    const worktreeDir = join(base, 'wt-feature')

    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature-x', worktreeDir)

    const list = await runCli(['worktrees', 'list'], { cwd: worktreeDir, env: cleanEnv() })

    expect(list.code, list.out).toBe(0)
  }, 45_000)
})

describe('audit stays soft', () => {
  // I8 (AC6) — audit in a standalone package dir (package.json + its own infra-kit.config.ts audit
  // rules, NO infra-kit.json, and — deliberately — NOT a git repo) still audits it: exit 0, zero
  // fatal: lines. Run outside git so the assertion is non-vacuous: outside a git repo the preAction
  // legs used to leak `fatal:`, and Step 1's `{ quiet: true }` is what silences them. audit's default
  // path never reads infra-kit.json (it validates against infra-kit.config.ts), so it stays soft. The
  // config is a self-contained object export (no `@slip-stream-kit/config` import to resolve) with
  // empty rules so the package passes with only a package.json + config present.
  it('i8: audit in a standalone package exits 0 with no fatal: lines', async () => {
    const cwd = mkTmp('standalone-pkg')

    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'standalone-pkg', type: 'module', version: '0.0.0' }),
    )
    writeFileSync(join(cwd, 'infra-kit.config.ts'), 'export default { requiredScripts: [], requiredFiles: [] }\n')

    const result = await runCli(['audit'], { cwd, env: cleanEnv() })

    expect(result.code, result.out).toBe(0)
    expect(result.out).not.toContain('fatal:')
  }, 30_000)
})

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')

/** Pull the single-line `infra-kit.json not found at …` message out of pino-pretty stderr. */
const extractConfigMessage = (out: string): string => {
  const clean = out.replace(ANSI, '')
  const start = clean.indexOf('infra-kit.json not found at')

  if (start === -1) return ''

  const rest = clean.slice(start)
  const end = rest.indexOf('\n')

  return end === -1 ? rest.trim() : rest.slice(0, end).trim()
}

describe('doctor renders the enriched config message intact', () => {
  // I10 (AC7) — doctor surfaces the missing-config message verbatim in a "Project config" check row
  // (`infra-kit config valid`). We assert the change end-to-end: capture the REAL Step 4 message off a
  // spawned CLI failing in a non-project git repo (no hardcoded literal that could drift), then render
  // it through the REAL grouped report (report.ts, source-untouched). The enriched text must survive
  // and the grouped layout must still render.
  //
  // A full cross-host `doctor` SPAWN snapshot is deliberately NOT attempted: doctor probes the live
  // host (gh, portless daemon, doppler tokens, network), so a byte-identical snapshot is inherently
  // non-hermetic and machine-dependent — exactly what the plan's hermetic-build mandate forbids. This
  // renders the one thing that actually changed (the config message) through the one renderer AC7
  // protects.
  it('i10: the real missing-config message renders in the Project config section', async () => {
    const cwd = makeNonProjectGitRepo()

    const result = await runCli(['worktrees', 'list'], { cwd, env: cleanEnv() })

    expect(result.code, result.out).toBe(1)

    const message = extractConfigMessage(result.out)

    expect(message.startsWith('infra-kit.json not found at ')).toBe(true)
    expect(message).toContain('this git repo is not an infra-kit project')

    const checks: CheckResult[] = [{ name: 'infra-kit config valid', status: 'fail', message }]

    // Wide width so the long message is not wrapped, keeping the byte-preservation assertion exact.
    const lines = formatDoctorReport(checks, { color: false, width: 1000 })
    const rendered = lines.join('\n')

    expect(rendered).toContain('Project config')
    expect(rendered).toContain(message)
  }, 30_000)
})
