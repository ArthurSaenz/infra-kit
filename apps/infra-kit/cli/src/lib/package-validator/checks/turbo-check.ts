import fs from 'node:fs/promises'
import path from 'node:path'

import type { PackageCheck } from '../types'

const TURBO_FILE = 'turbo.json'

/**
 * Check that every required turbo task is defined in turbo.json `tasks`. A root
 * task may be keyed as either `name` or `//#name`, so both forms count as present.
 * Runs only when the resolved rules ask for turbo tasks (the monorepo root).
 *
 * Reports a single clear diagnostic when turbo.json is unreadable or carries no
 * `tasks` object, rather than emitting one identical "missing task" line per
 * required task.
 */
export const checkTurbo = async (packageDir: string, requiredTasks: string[]): Promise<PackageCheck[]> => {
  if (requiredTasks.length === 0) {
    return []
  }

  let parsed: { tasks?: Record<string, unknown> }

  try {
    const raw = await fs.readFile(path.join(packageDir, TURBO_FILE), 'utf-8')

    parsed = JSON.parse(raw) as { tasks?: Record<string, unknown> }
  } catch (err) {
    return [{ name: TURBO_FILE, status: 'fail', message: `cannot read/parse ${TURBO_FILE}: ${(err as Error).message}` }]
  }

  const tasks = parsed.tasks

  if (tasks === null || typeof tasks !== 'object') {
    return [{ name: TURBO_FILE, status: 'fail', message: `no "tasks" object defined in ${TURBO_FILE}` }]
  }

  return requiredTasks.map((task) => {
    const defined = task in tasks || `//#${task}` in tasks

    return {
      name: `turbo:${task}`,
      status: defined ? 'pass' : 'fail',
      message: defined ? 'defined' : `missing turbo task "${task}" in ${TURBO_FILE}`,
    }
  })
}
