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

const tryCreate = (lockPath: string): boolean => {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' })

    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

const holderOf = (lockPath: string): number | null => {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10)

    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Take the package's run lock, or name the live process holding it. A lock left by a killed run is
 * taken over: its pid no longer answers.
 */
export const acquireRunLock = (testsDir: string): { release: () => void } | { holder: number } => {
  const lockPath = runLockPath(testsDir)

  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  if (!tryCreate(lockPath)) {
    const holder = holderOf(lockPath)

    if (holder !== null && holder !== process.pid && isAlive(holder)) return { holder }

    fs.rmSync(lockPath, { force: true })
    // Lost to another run taking the same stale lock in the same instant.
    if (!tryCreate(lockPath)) return { holder: holderOf(lockPath) ?? 0 }
  }

  return {
    release: () => {
      if (holderOf(lockPath) === process.pid) fs.rmSync(lockPath, { force: true })
    },
  }
}
