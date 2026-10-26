/**
 * `setup --auto`: the run the update worker starts after every update check. Once per installed
 * version it runs `setup --unattended` for the machine (from `$HOME`), then once per infra-kit project
 * on this machine, and records one verdict per run.
 *
 * Every run is its own child process of THIS binary, never an in-process loop over `chdir`: the config
 * loader, the agent-mode flag and the git-root resolvers are all keyed to the process cwd, and a child is
 * the only boundary a timeout can kill cleanly. One project that hangs or crashes costs its own row.
 *
 * Nothing here may throw past {@link autoSetup}, prompt, or print to stdout: the process is detached
 * with nowhere to write, and the update worker never waits on it.
 */
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

import { rerunSetupCommand } from 'src/commands/init'
import { unattendedChildEnv } from 'src/lib/auto-setup/child-env'
import { discoverInfraKitProjects } from 'src/lib/auto-setup/discover'
import {
  autoSetupDue,
  autoSetupLockPath,
  autoSetupLogPath,
  readAutoSetupRecord,
  writeAutoSetupRecord,
} from 'src/lib/auto-setup/record'
import type { AutoSetupRecord, AutoSetupRun } from 'src/lib/auto-setup/record'
import { acquireUpdateLock } from 'src/lib/update-check/lock'
import { textContent } from 'src/types'

import packageJson from '../../../package.json' with { type: 'json' }

/** One setup run measured at a few seconds; three minutes is a wedged child, not a slow one. */
export const AUTO_SETUP_RUN_TIMEOUT_MS = 3 * 60 * 1000

/**
 * The whole pass. Below the lock's 30-minute staleness window with room to spare, so a live pass is
 * never reaped by the next one; projects past the budget are recorded `failed` and retried.
 */
export const AUTO_SETUP_BUDGET_MS = 15 * 60 * 1000

export type AutoSetupOutcome = 'ran' | 'not-due' | 'already-running'

export interface RunSetupChildInput {
  cwd: string
  timeoutMs: number
}

export interface RunSetupChildResult {
  /** Exit code, or null when the child was killed or never started. */
  status: number | null
  stdout: string
  stderr: string
  /** Why the child produced no verdict: a spawn error or the signal that killed it. */
  error: string | null
}

export interface AutoSetupDeps {
  version?: string
  home?: string
  clock?: () => number
  acquireLock?: () => (() => void) | null
  readRecord?: () => AutoSetupRecord | null
  writeRecord?: (record: AutoSetupRecord) => void
  discoverProjects?: () => string[]
  runSetupChild?: (input: RunSetupChildInput) => Promise<RunSetupChildResult>
  writeLog?: (text: string) => void
}

/** Per stream: a setup report is a few KB, so anything past this is a child gone wrong, not a report. */
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024

/** How long after the child's own exit its pipes may still deliver output before the run is settled. */
const PIPE_DRAIN_GRACE_MS = 2_000

export interface GroupChildInput {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

/**
 * Run a child in its OWN process group (`detached`), so a timeout kills the group: SIGKILL to the child
 * alone would orphan the probes it spawned (`gh`, `aws`, `portless`), and an orphan holding the stdout
 * pipe would keep the run open past its timeout. The verdict never waits for such an orphan, and the
 * promise always resolves.
 */
export const runInProcessGroup = (input: GroupChildInput): Promise<RunSetupChildResult> => {
  return new Promise((resolve) => {
    const chunks = { stdout: '', stderr: '' }
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined

    const settle = (status: number | null, error: string | null): void => {
      if (settled) return

      settled = true
      clearTimeout(timer)
      resolve({ status, stdout: chunks.stdout, stderr: chunks.stderr, error })
    }

    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    })

    timer = setTimeout(() => {
      timedOut = true

      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }

      settle(null, `timed out after ${Math.round(input.timeoutMs / 1000)}s`)
    }, input.timeoutMs)

    const collect = (stream: 'stdout' | 'stderr') => {
      return (data: Buffer): void => {
        if (chunks[stream].length < MAX_CHILD_OUTPUT_BYTES) chunks[stream] += data.toString('utf8')
      }
    }

    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.on('error', (error) => {
      settle(null, error.message)
    })
    const verdict = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(code, timedOut || signal === null ? null : `killed by ${signal}`)
    }

    // `close` is the normal end: the child exited AND its pipes drained. It also waits for any escaped
    // grandchild still holding a pipe, so `exit` arms a short grace instead of trusting `close` alone.
    child.on('close', verdict)
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        verdict(code, signal)
      }, PIPE_DRAIN_GRACE_MS).unref()
    })
  })
}

const defaultRunSetupChild = ({ cwd, timeoutMs }: RunSetupChildInput): Promise<RunSetupChildResult> => {
  // `process.argv[1]` is the `cli.js` this pass is running, so every child is the same version.
  return runInProcessGroup({
    command: process.execPath,
    args: [process.argv[1] ?? '', 'setup', '--unattended', '--json'],
    cwd,
    env: unattendedChildEnv(process.env),
    timeoutMs,
  })
}

const defaultWriteLog = (text: string): void => {
  fs.writeFileSync(autoSetupLogPath(), text, { mode: 0o600 })
}

/** The slice of `setup --json`'s payload the verdict reads; anything else in it is ignored. */
interface SetupPayload {
  init: { step: string; outcome: string; message: string }[]
  tools: { id: string; action: string; before: { present: boolean }; detail: string }[]
  portlessService: { link: string; node: string; command: string | null }
}

const parsePayload = (stdout: string): SetupPayload | null => {
  try {
    const parsed = JSON.parse(stdout) as Partial<SetupPayload> | null

    if (!Array.isArray(parsed?.init) || !Array.isArray(parsed.tools) || typeof parsed.portlessService !== 'object') {
      return null
    }

    return parsed as SetupPayload
  } catch {
    return null
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * Why a child left no report, in one line: the `--json` error document when it printed one, else the
 * last line of its stderr (where the report table and the logger write).
 */
export const failureReason = (result: RunSetupChildResult): string => {
  if (result.error !== null) return result.error

  try {
    const parsed = JSON.parse(result.stdout) as { error?: unknown; message?: unknown } | null
    const message = parsed?.message ?? parsed?.error

    if (typeof message === 'string' && message !== '') return message
  } catch {
    // Not a JSON document; fall through to stderr.
  }

  const lastLine = result.stderr
    .replace(ANSI, '')
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter(Boolean)
    .at(-1)

  const summary = `no setup report (exit ${String(result.status)})`

  return lastLine ? `${summary}: ${lastLine.slice(0, 300)}` : summary
}

/**
 * One run's verdict from its payload. A present tool's pending update is NOT attention: under the probe
 * every installed tool reports the upgrade it would run, and a notice for each would fire on every
 * update. Only a missing tool is something infra-kit cannot work without.
 */
export const verdictFromPayload = (payload: SetupPayload, exitStatus: number | null): Omit<AutoSetupRun, 'root'> => {
  const failures: string[] = []
  const attention: string[] = []

  for (const entry of payload.init) {
    if (entry.outcome === 'failed') failures.push(entry.message)
    else if (entry.outcome === 'manual' || entry.outcome === 'warned') attention.push(entry.message)
  }

  for (const tool of payload.tools) {
    if (tool.action === 'failed') failures.push(`${tool.id}: ${tool.detail}`)
    else if (!tool.before.present)
      attention.push(`${tool.id} is not installed — run: infra-kit setup --tools ${tool.id}`)
  }

  const { link, node, command } = payload.portlessService

  if (link === 'failed' || node === 'failed') failures.push(`portless: link ${link}, node ${node}`)
  if (command !== null) attention.push(command)

  if (failures.length === 0 && exitStatus !== 0) failures.push(`setup exited ${String(exitStatus)}`)

  if (failures.length > 0) return { status: 'failed', notes: [...failures, ...attention] }

  return { status: attention.length > 0 ? 'attention' : 'ok', notes: attention }
}

const runOne = async (
  root: string | null,
  cwd: string,
  deps: Required<AutoSetupDeps>,
  deadlineMs: number,
): Promise<AutoSetupRun> => {
  const remainingMs = deadlineMs - deps.clock()
  const rerun = root === null ? 'infra-kit setup' : rerunSetupCommand(root)

  if (remainingMs <= 0) return { root, status: 'failed', notes: [`out of time budget — run: ${rerun}`] }

  try {
    const result = await deps.runSetupChild({ cwd, timeoutMs: Math.min(AUTO_SETUP_RUN_TIMEOUT_MS, remainingMs) })
    const payload = result.error === null ? parsePayload(result.stdout) : null

    if (payload === null) return { root, status: 'failed', notes: [`${failureReason(result)} — run: ${rerun}`] }

    return { root, ...verdictFromPayload(payload, result.status) }
  } catch (err) {
    return { root, status: 'failed', notes: [`${err instanceof Error ? err.message : String(err)} — run: ${rerun}`] }
  }
}

/**
 * Machine-level lines repeat in every project run; each is kept on the machine run only. A failed run
 * keeps its notes whole — emptied, the log would say `failed` with no reason.
 */
const dropMachineNotes = (runs: AutoSetupRun[]): AutoSetupRun[] => {
  const machineRun = runs.find((run) => {
    return run.root === null
  })

  const machineNotes = new Set(machineRun?.notes ?? [])

  return runs.map((run) => {
    if (run.root === null || run.status === 'failed') return run

    const notes = run.notes.filter((note) => {
      return !machineNotes.has(note)
    })

    return { ...run, notes, status: run.status === 'attention' && notes.length === 0 ? 'ok' : run.status }
  })
}

const formatLog = (record: AutoSetupRecord): string => {
  const lines = [
    `infra-kit ${record.version} unattended setup — ${new Date(record.finishedMs ?? record.startedMs).toISOString()} (attempt ${record.attempts})`,
  ]

  for (const run of record.runs) {
    lines.push('', `${run.status.padEnd(9)} ${run.root ?? 'machine'}`)

    for (const note of run.notes) lines.push(`  ${note}`)
  }

  return `${lines.join('\n')}\n`
}

const resolveDeps = (deps: AutoSetupDeps): Required<AutoSetupDeps> => {
  return {
    version: deps.version ?? packageJson.version,
    home: deps.home ?? homedir(),
    clock: deps.clock ?? Date.now,
    acquireLock:
      deps.acquireLock ??
      (() => {
        return acquireUpdateLock({ lockPath: autoSetupLockPath() })
      }),
    readRecord: deps.readRecord ?? readAutoSetupRecord,
    writeRecord: deps.writeRecord ?? writeAutoSetupRecord,
    discoverProjects:
      deps.discoverProjects ??
      (() => {
        return discoverInfraKitProjects()
      }),
    runSetupChild: deps.runSetupChild ?? defaultRunSetupChild,
    writeLog: deps.writeLog ?? defaultWriteLog,
  }
}

/** A project list that cannot be read fails the machine run (and so is retried), never the pass. */
const listProjects = (deps: Required<AutoSetupDeps>): { projects: string[]; error: string | null } => {
  try {
    return { projects: deps.discoverProjects(), error: null }
  } catch (err) {
    return { projects: [], error: err instanceof Error ? err.message : String(err) }
  }
}

const autoSetupLocked = async (deps: Required<AutoSetupDeps>): Promise<AutoSetupOutcome> => {
  const previous = deps.readRecord()
  const startedMs = deps.clock()

  if (!autoSetupDue(previous, deps.version, startedMs)) return 'not-due'

  const attempts = previous?.version === deps.version ? previous.attempts + 1 : 1

  // Before any child: a pass that is killed, or whose final write fails, has still spent its attempt
  // and started its cooldown. A failure HERE aborts the pass — without it there is no retry bound.
  deps.writeRecord({ version: deps.version, attempts, startedMs, finishedMs: null, runs: [] })

  const deadlineMs = startedMs + AUTO_SETUP_BUDGET_MS
  const machine = await runOne(null, deps.home, deps, deadlineMs)
  const listed = listProjects(deps)

  const runs: AutoSetupRun[] = [
    listed.error === null
      ? machine
      : { root: null, status: 'failed', notes: [...machine.notes, `could not list projects: ${listed.error}`] },
  ]

  for (const root of listed.projects) runs.push(await runOne(root, root, deps, deadlineMs))

  const record: AutoSetupRecord = {
    version: deps.version,
    attempts,
    startedMs,
    finishedMs: deps.clock(),
    runs: dropMachineNotes(runs),
  }

  deps.writeRecord(record)

  try {
    deps.writeLog(formatLog(record))
  } catch {
    // The record is the state; the log is a convenience for the human the notice points at.
  }

  return 'ran'
}

/**
 * Run the unattended pass when one is owed for this version. NEVER rejects.
 *
 * @example
 * await autoSetup() // => 'ran' | 'not-due' | 'already-running'
 */
export const autoSetup = async (deps: AutoSetupDeps = {}): Promise<AutoSetupOutcome> => {
  try {
    const resolved = resolveDeps(deps)
    const release = resolved.acquireLock()

    if (release === null) return 'already-running'

    try {
      return await autoSetupLocked(resolved)
    } finally {
      release()
    }
  } catch {
    // The provisional record already spent this attempt; the next window decides whether to retry.
    return 'not-due'
  }
}

/** `setup --auto` as a command result, for the `--json` payload a test or a human reads. */
export const autoSetupCommand = async (deps: AutoSetupDeps = {}) => {
  const outcome = await autoSetup(deps)

  return { content: textContent(JSON.stringify({ outcome })), structuredContent: { outcome } }
}
