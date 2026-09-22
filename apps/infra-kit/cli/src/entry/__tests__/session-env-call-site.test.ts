import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Raw-source guard, in the `lib/program/__tests__/program.test.ts` idiom: `entry/cli.ts` runs at
 * import time, so the placement of `applySessionEnv()` can only be pinned by reading the file.
 *
 * The placement IS the correctness: inside `runProgram`, every command process overlays itself from
 * the session files, while the session shell (`runSessionShell` never calls `runProgram`) hands its
 * children the pristine terminal env. Hoisted to module scope, the shell's own overlay would be
 * inherited by every child, and a name loaded at session boot would survive an in-session
 * `env-clear` + `env-load` of another config.
 */
const HOIST_HAZARD =
  'hoisting applySessionEnv() to module scope makes the session shell hand children an already-overlaid env; keep it inside runProgram'

const source = readFileSync(path.resolve(__dirname, '../cli.ts'), 'utf8')

// Statement-position matches only, so a comment that names the call cannot count as one. `[ \t]` rather
// than `\s`: the class must not cross a line, or `^` under `m` backtracks super-linearly.
const CALL_STATEMENT = /^[ \t]*applySessionEnv\(\)/gm

describe('entry/cli.ts — the session-env overlay call site', () => {
  it('calls applySessionEnv() exactly once, at statement position', () => {
    const calls = source.match(CALL_STATEMENT) ?? []

    expect(calls, HOIST_HAZARD).toHaveLength(1)
  })

  it('places the call inside runProgram, before Commander sees the argv', () => {
    const call = source.search(CALL_STATEMENT)
    const runProgramStart = source.indexOf('const runProgram = async')
    const parseStart = source.indexOf('setParsedArgv(argv)')

    expect(runProgramStart).toBeGreaterThan(-1)
    expect(parseStart).toBeGreaterThan(-1)
    expect(call, HOIST_HAZARD).toBeGreaterThan(runProgramStart)
    expect(call, HOIST_HAZARD).toBeLessThan(parseStart)
  })
})
