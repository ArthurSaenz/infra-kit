import type { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { KILL_SWITCHES } from 'src/__tests__/helpers/build-cli-bundle'

/**
 * @fileoverview
 * A throwaway infra-kit project for the spawned-CLI integration lane: a git repo with a release
 * branch, a fake `gh` / `pnpm` on PATH, and an env built FROM SCRATCH rather than from
 * `process.env`. The from-scratch part is load-bearing: this suite runs inside Claude Code, whose
 * `CLAUDECODE=1` is exactly the agent-mode signal under test, so inheriting the parent env would put
 * every "no agent signals" case into agent mode and pass the refusals vacuously.
 */

/** The one release the fixture knows about, in every spelling the CLI and `gh` see. */
export const FIXTURE_RELEASE = {
  version: '9.9.9',
  ref: 'v9.9.9',
  branch: 'release/v9.9.9',
  prTitle: 'Release v9.9.9',
} as const

/** Matches the 8-hex shape the shell integration mints; `env-status` echoes it back verbatim. */
export const FIXTURE_SESSION = 'a9c1f00d'

export interface AgentCliFixture {
  /** The main checkout — every spawn's cwd. Realpath'd so `process.cwd()` inside the child agrees. */
  repoDir: string
  /** `<repoDir>-worktrees`, the sibling `worktrees add` populates. */
  worktreesDir: string
  /** Where a `worktrees add` of the fixture release lands. */
  releaseWorktreeDir: string
  /** Every `gh` argv the fake received, one line each. */
  ghLog: string
  /** `$HOME` for the children — Layer-3 seeds and session caches land here, never in the real one. */
  homeDir: string
  /** The hermetic base env; cases spread their own agent signals over it. */
  env: Record<string, string>
}

const gitEnv = (homeDir: string): Record<string, string> => {
  return {
    // A global config the fixture owns: commit identity, no signing, no hooks path, no
    // `init.defaultBranch` surprise from the developer's own ~/.gitconfig.
    GIT_CONFIG_GLOBAL: join(homeDir, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

// Sync on purpose: fixture creation is sequential setup, and a failed step must stop it right there.
const git = (cwd: string, env: Record<string, string>, args: string[]): void => {
  const result = spawnSync('/usr/bin/git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${String(result.stderr)}`)
  }
}

/**
 * The fake `gh`. Answers exactly the argv shapes `src/integrations/gh` issues for this fixture and
 * fails loudly on anything else, so a new `gh` call in the code under test surfaces as a red test
 * naming the argv rather than as a mysterious empty list.
 *
 * `$*` joins the argv with single spaces, which is what the `case` patterns below match on. zx
 * expands `--search "Release in:title"` to one argv element, so it appears here without quotes.
 */
const fakeGhScript = (logPath: string): string => {
  return `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
case "$*" in
  --version)
    echo 'gh version 2.99.0 (fixture)'
    ;;
  'auth status')
    ;;
  *'Release in:title'*)
    printf '%s\\n' '[{"number":1,"title":"${FIXTURE_RELEASE.prTitle}","headRefName":"${FIXTURE_RELEASE.branch}","state":"OPEN","baseRefName":"dev","createdAt":"2026-09-01T00:00:00Z"}]'
    ;;
  *'Hotfix in:title'*)
    echo '[]'
    ;;
  'pr list --head ${FIXTURE_RELEASE.branch} '*)
    printf '%s\\n' '[{"number":1,"state":"OPEN","title":"${FIXTURE_RELEASE.prTitle}"}]'
    ;;
  'pr list --head '*)
    echo '[]'
    ;;
  'workflow run '*)
    ;;
  *)
    echo "fake gh: unhandled argv: $*" >&2
    exit 1
    ;;
esac
`
}

/**
 * Build the fixture. Everything lives under one `mkdtemp` so a single `rmSync` tears it down.
 *
 * `pnpm` is faked too: `worktrees add` runs `pnpm install` inside each new worktree, and a real
 * install would leave `pnpm-lock.yaml` untracked there — making every freshly added worktree dirty
 * and AC10's "one leaf is dirty" indistinguishable from the default state.
 */
export const makeAgentCliFixture = (): AgentCliFixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-cli-')))
  const homeDir = join(root, 'home')
  const binDir = join(root, 'bin')
  const repoDir = join(root, 'fixture-repo')
  const originDir = join(root, 'origin.git')
  const ghLog = join(binDir, 'gh.log')

  mkdirSync(homeDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(repoDir, { recursive: true })

  writeFileSync(
    join(homeDir, '.gitconfig'),
    '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = /dev/null\n',
  )

  writeFileSync(join(binDir, 'gh'), fakeGhScript(ghLog))
  writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(binDir, 'gh'), 0o755)
  chmodSync(join(binDir, 'pnpm'), 0o755)
  writeFileSync(ghLog, '')

  const env: Record<string, string> = {
    // Fixture binaries first; then only the system dirs `git`, `sh`, `bash` (zx), `cat` and `script`
    // live in. The developer's `orca`, `doppler`, real `gh` and real `pnpm` are all invisible.
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: homeDir,
    XDG_CACHE_HOME: join(homeDir, '.cache'),
    INFRA_KIT_SESSION: FIXTURE_SESSION,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    ...KILL_SWITCHES,
    ...gitEnv(homeDir),
  }

  // `cli-only` is the AC5 setting; the rest is the minimum `getInfraKitConfig` accepts.
  writeFileSync(
    join(repoDir, 'infra-kit.json'),
    `${JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'fixture' } }, protectedEnvs: 'cli-only' }, null, 2)}\n`,
  )
  writeFileSync(join(repoDir, 'package.json'), `${JSON.stringify({ name: 'fixture-repo', private: true }, null, 2)}\n`)
  writeFileSync(join(repoDir, '.gitignore'), '.omc/\n')

  git(repoDir, env, ['init', '-q', '-b', 'dev'])
  git(repoDir, env, ['add', '-A'])
  git(repoDir, env, ['commit', '-q', '-m', 'fixture'])
  git(repoDir, env, ['branch', FIXTURE_RELEASE.branch])
  git(root, env, ['init', '-q', '--bare', originDir])
  git(repoDir, env, ['remote', 'add', 'origin', originDir])
  git(repoDir, env, ['push', '-q', 'origin', 'dev', FIXTURE_RELEASE.branch])

  const worktreesDir = `${repoDir}-worktrees`

  return {
    repoDir,
    worktreesDir,
    releaseWorktreeDir: join(worktreesDir, FIXTURE_RELEASE.branch),
    ghLog,
    homeDir,
    env,
  }
}

/** Register the fixture release's worktree directly with git — for cases that need one to exist without going through the CLI. */
export const ensureReleaseWorktree = (fixture: AgentCliFixture): void => {
  if (existsSync(fixture.releaseWorktreeDir)) return

  mkdirSync(fixture.worktreesDir, { recursive: true })
  git(fixture.repoDir, fixture.env, ['worktree', 'add', '-q', fixture.releaseWorktreeDir, FIXTURE_RELEASE.branch])
}

/** Unregister the fixture release's worktree, dirty or not, so the next case starts from a clean slate. */
export const removeReleaseWorktree = (fixture: AgentCliFixture): void => {
  if (!existsSync(fixture.releaseWorktreeDir)) return

  git(fixture.repoDir, fixture.env, ['worktree', 'remove', '--force', fixture.releaseWorktreeDir])
}

export const readGhLog = (fixture: AgentCliFixture): string[] => {
  return readFileSync(fixture.ghLog, 'utf8')
    .split('\n')
    .filter((line) => {
      return line.length > 0
    })
}

export interface SpawnedRun {
  /** `null` when the deadline killed it. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** `stdout` parsed as ONE JSON object; `undefined` when it is empty or not JSON. */
  json: Record<string, unknown> | undefined
}

/** The per-spawn deadline (AC1): a refusal that hangs on a prompt is the bug, not a slow machine. */
const CLI_DEADLINE_MS = 2_000

const parseOneJsonObject = (stdout: string): Record<string, unknown> | undefined => {
  const trimmed = stdout.trim()

  if (trimmed.length === 0) return undefined

  try {
    const parsed: unknown = JSON.parse(trimmed)

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

interface RunCliOptions {
  cliPath: string
  fixture: AgentCliFixture
  args: string[]
  /** Agent signals for this case, spread over the fixture's base env. `undefined` deletes a key. */
  env?: Record<string, string | undefined>
  deadlineMs?: number
  /** Spawn cwd, for the `-C <dir>` cases that start OUTSIDE the fixture; defaults to the checkout. */
  cwd?: string
}

const mergeEnv = (
  base: Record<string, string>,
  extra: Record<string, string | undefined> | undefined,
): Record<string, string> => {
  const merged: Record<string, string> = { ...base }

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }

  return merged
}

/**
 * Spawn `node cli.js <args>` against the fixture with stdin from `/dev/null` (so `stdin.isTTY` is
 * false, the non-TTY half of every agent-mode heuristic) and collect exit code, stdout and stderr.
 * Past the deadline the child is SIGKILLed and `timedOut` is set; the caller asserts on it.
 */
export const runCli = ({
  cliPath,
  fixture,
  args,
  env,
  deadlineMs = CLI_DEADLINE_MS,
  cwd = fixture.repoDir,
}: RunCliOptions): Promise<SpawnedRun> => {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: mergeEnv(fixture.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, deadlineMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut, json: parseOneJsonObject(stdout) })
    })
  })
}

/** Sentinel the pty runner echoes the instant the CLI returns — the pipeline's own exit says nothing (see `runCliOnPty`). */
const PTY_SENTINEL = '__CLI_EXIT__:'

/** The pty chain is `sh → cat → script → sh → node`; node's boot is the bulk, the rest is headroom. */
const PTY_DEADLINE_MS = 6_000

const SINGLE_QUOTE_ESCAPE = String.raw`'\''`

const shellQuote = (value: string): string => {
  return `'${value.replaceAll("'", SINGLE_QUOTE_ESCAPE)}'`
}

export interface PtyRun {
  code: number | null
  /** stdout, captured to a file so the JSON payload never mixes with the pty's `\r\n` stream. */
  stdout: string
  /** Everything that reached the pty: the CLI's stderr (prompts, logs) plus the sentinel line. */
  pty: string
  timedOut: boolean
  json: Record<string, unknown> | undefined
}

/**
 * Run the CLI with a REAL tty on stdin (`script -q /dev/null`, macOS spelling), for the cases whose
 * whole point is `stdin.isTTY === true`: `CLAUDECODE=1` alone must NOT mean agent mode there.
 *
 * Mechanics borrowed from `src/entry/__tests__/quit-keys-pty.test.ts`: `cat` launders node's
 * socketpair stdin into a pipe `script` will accept; the runner echoes a sentinel with the CLI's
 * status because `cat` outlives the CLI; stdout goes to a file so the JSON is read clean while
 * stderr stays on the pty, where a prompt would draw. `detached` so the whole group can be killed.
 */
export const runCliOnPty = ({
  cliPath,
  fixture,
  args,
  env,
  deadlineMs = PTY_DEADLINE_MS,
}: RunCliOptions): Promise<PtyRun> => {
  const runDir = mkdtempSync(join(fixture.homeDir, 'pty-'))
  const stdoutPath = join(runDir, 'stdout')
  const runnerPath = join(runDir, 'runner.sh')
  const argv = [cliPath, ...args].map(shellQuote).join(' ')

  writeFileSync(
    runnerPath,
    `#!/bin/sh\ncd ${shellQuote(fixture.repoDir)}\n${shellQuote(process.execPath)} ${argv} > ${shellQuote(stdoutPath)}\necho "${PTY_SENTINEL}$?"\n`,
  )

  return new Promise((resolvePromise) => {
    const child = spawn(
      '/bin/sh',
      ['-c', `/bin/cat | /usr/bin/script -q /dev/null /bin/sh ${shellQuote(runnerPath)}`],
      {
        cwd: fixture.repoDir,
        env: mergeEnv(fixture.env, env),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let pty = ''
    let settled = false

    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return

      settled = true
      clearTimeout(timer)

      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // The group is already gone — the normal case once the sentinel has been echoed.
      }

      const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : ''

      resolvePromise({ code, stdout, pty, timedOut, json: parseOneJsonObject(stdout) })
    }

    const timer = setTimeout(() => {
      finish(null, true)
    }, deadlineMs)

    child.stdout.on('data', (chunk: Buffer) => {
      pty += String(chunk)

      const match = new RegExp(`${PTY_SENTINEL}(\\d+)`).exec(pty)

      if (match) finish(Number(match[1]), false)
    })
    child.on('close', () => {
      finish(null, false)
    })
  })
}
