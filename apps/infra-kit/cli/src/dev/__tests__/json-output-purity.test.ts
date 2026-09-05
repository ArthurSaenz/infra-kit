import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DevServerRunner } from 'src/dev/dev-server'
import type { DevUi } from 'src/dev/dev-ui'

import { workingProxy } from './fixtures.js'

/**
 * @fileoverview
 *
 * `--json` promises a machine-readable stream. This guards the one path that can break that promise
 * without any existing test noticing.
 *
 * Two traps had to be designed around, and both would have produced a green test that proves nothing:
 *
 * 1. `DevRenderer` defaults `isTTY` to `process.stdout.isTTY`, which is `false` under vitest — so the
 *    defect is simply absent in the test environment. Every test here FORCES `isTTY = true` first,
 *    reproducing a real terminal, which is the only condition under which the bug appears.
 * 2. The stdout spy must be installed AFTER the runner is constructed. A run that owns the terminal
 *    installs `output-intercept` in the constructor, which patches `process.stdout.write` on top of any
 *    earlier spy — an earlier spy therefore captures the empty string, and `not.toContain(ESC)` passes
 *    vacuously. Hence {@link paintWith}, and hence the explicit non-emptiness assertion.
 *
 * What made the defect reachable: `selectDevUi` returns no renderer for `--json` precisely BECAUSE the
 * run does not own the terminal, so the constructor's fallback `DevRenderer` did the writing — and it
 * inherited a TTY it was never meant to treat as one.
 */
/** The private field under test — the renderer the constructor fell back to building. */
interface RunnerRenderer {
  renderer: DevUi
}

/** ESC. Its presence in a `--json` stream is the defect, whatever escape sequence follows it. */
const ESC = '\u001B'

describe('--json output carries no terminal escapes', () => {
  let realIsTTY: boolean | undefined
  let realWrite: typeof process.stdout.write

  beforeEach(() => {
    realIsTTY = process.stdout.isTTY
    realWrite = process.stdout.write.bind(process.stdout)
    // Reproduce a real terminal: without this the assertion cannot fail, bug or no bug.
    process.stdout.isTTY = true
  })

  afterEach(() => {
    // Restore by hand rather than via vi.restoreAllMocks: the runner's output-intercept patches
    // `process.stdout.write` too, and only the pristine reference captured above undoes both layers.
    process.stdout.write = realWrite
    process.stdout.isTTY = realIsTTY as boolean
  })

  /**
   * Construct a runner, THEN capture stdout, then paint one boot step. `bootStep` is the spinner's
   * entry point — the exact call that armed an ANSI frame timer on a `--json` run.
   */
  const paintWith = (options: { json?: boolean }): string => {
    const runner = new DevServerRunner(
      options,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )
    const out: string[] = []

    process.stdout.write = ((chunk: unknown): boolean => {
      out.push(String(chunk))

      return true
    }) as typeof process.stdout.write
    ;(runner as unknown as RunnerRenderer).renderer.bootStep('resolving apps')

    return out.join('')
  }

  it('writes the boot step as plain text, with no escape sequence, on a TTY', () => {
    const painted = paintWith({ json: true })

    // Non-emptiness first: without it `not.toContain` would pass on a renderer that wrote nothing,
    // which is the failure mode this whole file exists to avoid.
    expect(painted).toContain('resolving apps')
    expect(painted).not.toContain(ESC)
  })

  it('still paints escapes on a normal (non-json) TTY run, so the fix is not "no colour anywhere"', () => {
    // The discriminating case: same terminal, same call, opposite verdict from `ownsTerminal`.
    expect(paintWith({})).toContain(ESC)
  })
})
