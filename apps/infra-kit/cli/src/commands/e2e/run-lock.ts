import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * Two local runs of one e2e package share its dev server: the second reuses the server the first one's
 * Playwright started, and loses it mid-run when the first one finishes and stops it. Kept under
 * `node_modules/.cache` because a plain `playwright test` empties `test-results/`.
 */
export const runLockPath = (testsDir: string): string => {
  return path.join(testsDir, 'node_modules', '.cache', 'infra-kit-e2e.lock')
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM: alive, owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface RunLockHolder {
  pid: number
  startedAt?: number
  command?: string
}

const tryCreate = (lockPath: string, command: string): boolean => {
  try {
    // Line 1 stays the bare pid: older CLIs in other worktrees read the file with `Number.parseInt`, which
    // stops at the newline, so they still see the live pid and refuse instead of deleting this lock.
    fs.writeFileSync(lockPath, `${process.pid}\n${JSON.stringify({ startedAt: Date.now(), command })}`, {
      flag: 'wx',
    })

    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

const parseDetails = (line: string | undefined): Omit<RunLockHolder, 'pid'> => {
  try {
    const parsed = JSON.parse(line ?? '') as { startedAt?: unknown; command?: unknown } | null

    return {
      ...(typeof parsed?.startedAt === 'number' && { startedAt: parsed.startedAt }),
      ...(typeof parsed?.command === 'string' && { command: parsed.command }),
    }
  } catch {
    return {}
  }
}

const holderOf = (lockPath: string): RunLockHolder | null => {
  try {
    const [pidLine, detailsLine] = fs.readFileSync(lockPath, 'utf8').split('\n')
    const pid = Number.parseInt(pidLine!, 10)

    return Number.isInteger(pid) && pid > 0 ? { pid, ...parseDetails(detailsLine) } : null
  } catch {
    return null
  }
}

/**
 * Take the package's run lock, or name the live process holding it. A lock left by a killed run is
 * taken over: its pid no longer answers.
 */
export const acquireRunLock = (
  testsDir: string,
  command: string,
): { release: () => void } | { holder: RunLockHolder } => {
  const lockPath = runLockPath(testsDir)

  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  if (!tryCreate(lockPath, command)) {
    const holder = holderOf(lockPath)

    if (holder !== null && holder.pid !== process.pid && isAlive(holder.pid)) return { holder }

    fs.rmSync(lockPath, { force: true })
    // Lost to another run taking the same stale lock in the same instant.
    if (!tryCreate(lockPath, command)) return { holder: holderOf(lockPath) ?? { pid: 0 } }
  }

  return {
    release: () => {
      if (holderOf(lockPath)?.pid === process.pid) fs.rmSync(lockPath, { force: true })
    },
  }
}
