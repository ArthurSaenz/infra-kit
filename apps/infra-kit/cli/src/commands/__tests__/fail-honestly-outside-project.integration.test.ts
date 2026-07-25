/* eslint-disable sonarjs/no-os-command-from-path */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as esbuild from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CheckResult } from 'src/commands/doctor/doctor'
import { formatDoctorReport } from 'src/commands/doctor/report'

import { buildOptions } from '../../../scripts/build.js'

/**
 * INTEGRATION tests for the "fail honestly outside an infra-kit project" plan
 * (plan-fail-honestly-v4.md, Test strategy → Integration, I1–I10). These are the
 * cases table/unit tests structurally cannot catch: they need the REAL bundled CLI
 * spawned with an explicit cwd + child env, a real git repo / worktree fixture, and
 * the real MCP transport.
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

// Valid JSON, zod-invalid (unknown key + missing required `envManagement`): it EXISTS on disk (so
// project-discovery keeps it) but its `getInfraKitConfig()` REJECTS — the only reachable child failure.
const MALFORMED_CONFIG = JSON.stringify({ environments: 42 })

const NO_STACK = /\n[ \t]+at\s/
const GIT_FATAL = 'fatal: not a git repository'

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  out: string
}

let cliPath = ''
let mcpPath = ''
const tmpDirs: string[] = []

/**
 * Build the child env: the current env (PATH is needed so the spawned CLI can find `git`) plus the
 * three kill switches. `overrides` set a value, or DELETE the key when the value is `undefined`
 * (I2 deletes `INFRA_KIT_NO_SEED` to arm the seed leg).
 */
const cleanEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...KILL_SWITCHES }

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
  mcpPath = join(outDir, 'mcp.js')
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

  // I4c (MANDATORY) — reopen is the only false success that MUTATES external state. The read above the
  // try must throw before openIdeWorkspace/runCmux, so no window opens.
  it('i4c: reopen exits 1 with config message and opens no IDE/cmux window', async () => {
    const cwd = makeNonProjectGitRepo()

    const result = await runCli(['reopen'], { cwd, env: cleanEnv() })

    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain('infra-kit.json not found at')
    // Observable proxy from a spawned process: none of reopen's success markers appear because it
    // fails at the hoisted read, before the Promise.all([openIdeWorkspace, runCmux]) side effects.
    // (The precise "getProjectRoot@:109 / listWorktrees never invoked" tripwire is the unit suite,
    // plan unit test 5, which module-mocks getInfraKitConfig.)
    expect(result.out).not.toContain('Opened editor workspace')
    expect(result.out).not.toContain('Opened cmux workspaces')
    expect(result.out).not.toContain('Nothing to reopen')
  }, 30_000)
})

describe('non-regression: real project and its linked worktree', () => {
  // I5 (AC4) — from inside a LINKED WORKTREE of a real project, both commands still succeed AND the
  // reported repo name is the MAIN repo's basename, not the worktree leaf. This is the only
  // integration tripwire for the §1.5 `getMainRepoRoot($({ cwd: root, quiet: true }))` merge — the
  // regression is invisible in a main checkout.
  it('i5: worktrees list + reopen --dry-run succeed and resolve the MAIN repo name', async () => {
    const base = mkTmp('worktree-base')
    const mainRepo = makeProject(base, 'main-repo', VALID_CONFIG)
    const mainName = basename(mainRepo)
    const worktreeDir = join(base, 'wt-feature')

    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature-x', worktreeDir)

    const list = await runCli(['worktrees', 'list'], { cwd: worktreeDir, env: cleanEnv() })

    expect(list.code, list.out).toBe(0)

    const dryRun = await runCli(['reopen', '--dry-run', '--json'], { cwd: worktreeDir, env: cleanEnv() })

    expect(dryRun.code, dryRun.out).toBe(0)

    const parsed = JSON.parse(dryRun.stdout) as { repo: string }

    expect(parsed.repo).toBe(mainName)
    expect(parsed.repo).not.toBe('wt-feature')
  }, 45_000)

  // I6 (AC5) — reopen --all --root <tmpdir> from a NON-git cwd exits 0 and reports zero projects.
  it('i6: reopen --all --root <empty> from a non-git cwd exits 0 with 0 projects', async () => {
    const cwd = mkTmp('no-git-all')
    const root = mkTmp('empty-root')

    const result = await runCli(['reopen', '--all', '--root', root, '--json'], { cwd, env: cleanEnv() })

    expect(result.code, result.out).toBe(0)

    const parsed = JSON.parse(result.stdout) as { projects: unknown[] }

    expect(parsed.projects).toEqual([])
  }, 30_000)

  // I7 (RESPECIFIED) — the fan-out's only REACHABLE child failure is a config that EXISTS but does
  // not load (zod-invalid). A plain-git repo is filtered by project-discovery (:78) and never
  // spawned, so it would be a vacuous fixture. Assert: parent exit 0; the good project succeeded; the
  // bad child's failure is recorded & ISOLATED without failing the sweep. --dry-run keeps the good
  // child side-effect free.
  it('i7: reopen --all isolates a zod-invalid child while the valid project succeeds', async () => {
    const home = mkTmp('home-all')
    const root = mkTmp('fanout-root')

    makeProject(root, 'good', VALID_CONFIG)
    makeProject(root, 'bad', MALFORMED_CONFIG)

    const result = await runCli(['reopen', '--all', '--root', root, '--dry-run', '--json'], {
      cwd: root,
      env: cleanEnv({ HOME: home }),
    })

    expect(result.code, result.out).toBe(0)

    const parsed = JSON.parse(result.stdout) as { results: Array<{ repo: string; ok: boolean }> }

    const good = parsed.results.find((entry) => {
      return entry.repo === 'good'
    })
    const bad = parsed.results.find((entry) => {
      return entry.repo === 'bad'
    })

    expect(good?.ok, `good project result: ${JSON.stringify(good)}`).toBe(true)
    expect(bad?.ok, `bad project result: ${JSON.stringify(bad)}`).toBe(false)
  }, 60_000)
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

describe('mCP server survives a non-project tool call', () => {
  // I9 (AC8) — a worktrees-list tool call in a non-project cwd returns a TOOL ERROR (not a crash), the
  // server accepts a subsequent call, and the error text advises the OPERATOR — it contains neither
  // `cd ` nor `--project`. We spawn the REAL built MCP server (`mcp.js`) over the SDK's stdio transport
  // with an explicit cwd, exactly as an MCP host would, rather than in-process: the server resolves its
  // project from its launch cwd, and zx's git spawns follow the child's real cwd (an in-process
  // `process.chdir` does NOT propagate to the config resolution — it resolved against the test runner's
  // own cwd, the real infra-kit repo, and the guard never fired). `tool-handler.ts:39-48` catches →
  // logs → rethrows, so the long-lived server degrades to an ordinary tool error.
  it('i9: returns a tool error, stays up, and never says "cd " or "--project"', async () => {
    const repo = makeNonProjectGitRepo()

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: repo,
      env: cleanEnv() as Record<string, string>,
    })

    const client = new Client({ name: 'integration-test', version: '0.0.0' })

    await client.connect(transport)

    try {
      const errored = (await client.callTool({ name: 'worktrees-list', arguments: {} })) as {
        isError?: boolean
        content: Array<{ type: string; text?: string }>
      }

      expect(errored.isError).toBe(true)

      const errorText = errored.content
        .map((part) => {
          return part.text ?? ''
        })
        .join('\n')

      expect(errorText).not.toContain('cd ')
      expect(errorText).not.toContain('--project')
      expect(errorText).toContain('not an infra-kit project')

      // The server stays up and answers a subsequent call that needs no project.
      const survived = (await client.callTool({ name: 'version', arguments: {} })) as { isError?: boolean }

      expect(survived.isError).toBeFalsy()
    } finally {
      await client.close()
    }
  }, 45_000)
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
