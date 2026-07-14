import { render } from 'ink-testing-library'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ReadySummary } from 'src/dev/dev-ui'

import { PersistentInkDevUi } from '../persistent-ink-dev-ui'
import type { PersistentInkDevUiDeps } from '../persistent-ink-dev-ui'

/**
 * PersistentInkDevUi mounts a live status panel at `ready` and stays mounted — for EVERY session shape,
 * since the UI-session handoff to a scroll-region UI was deleted along with the log tail that justified
 * it. Tests inject `ink-testing-library`'s `render` (so frames are captured) and a fake `stdout`.
 * Committed `<Static>` content lives in the frame history; the last frame is the live region below it.
 *
 * These frames prove REACT TREE shape, never terminal behavior: `ink-testing-library` renders into a
 * string buffer and knows nothing about the cursor, or about the `ESC[3J` that an overflowing Ink frame
 * emits to wipe a user's scrollback. Anything about what the terminal actually does has to be proven
 * against a real pty.
 */
const frozen = new Date('2026-07-08T14:02:11.000Z')

const settle = (): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, 60)
  })
}

const baseSummary = (over: Partial<ReadySummary> = {}): ReadySummary => {
  return {
    target: 'client',
    watch: true,

    release: 'feat-x',
    elapsedMs: 2400,
    endpoints: [{ tag: 'client/api', url: 'http://localhost:57076/api/v1', healthy: true }],
    uiRefs: [],
    watchSummary: '1 app · 5 packages',
    logPath: '~/.cache/infra-kit/ab12cd34/logs.txt',
    logHref: '/home/u/.cache/infra-kit/ab12cd34/logs.txt',
    ...over,
  }
}

type InkInstance = ReturnType<typeof render>

/** Count non-overlapping occurrences of `needle` in `haystack` (for the no-duplicate-header assertions). */
const countOf = (haystack: string, needle: string): number => {
  return haystack.split(needle).length - 1
}

const makeUi = (over: { verbose?: boolean } = {}) => {
  const appendLog: string[] = []
  const stdoutWrites: string[] = []
  const fakeStdout = {
    write: (text: string): boolean => {
      stdoutWrites.push(text)

      return true
    },
  } as unknown as NodeJS.WriteStream
  let instance: InkInstance | null = null
  const renderSeam = (tree: ReactElement): InkInstance => {
    instance = render(tree)

    return instance
  }
  const ui = new PersistentInkDevUi({
    appendLog: (text) => {
      appendLog.push(text)
    },
    verbose: over.verbose ?? false,
    now: () => {
      return frozen
    },
    render: renderSeam as unknown as PersistentInkDevUiDeps['render'],
    stdout: fakeStdout,
  })

  return {
    ui,
    appendLog,
    stdoutWrites,
    frame: (): string => {
      return instance?.lastFrame() ?? ''
    },
    frames: (): string => {
      return (instance?.frames ?? []).join('\n')
    },
  }
}

describe('persistentInkDevUi — backend-only persistent mode', () => {
  it('commits the header URL (no inline dot) and shows the live health dot in the footer', () => {
    const t = makeUi()

    t.ui.ready(baseSummary())

    // The header endpoint URL is committed to scrollback (frame history)…
    expect(t.frames()).toContain('http://localhost:57076/api/v1')
    // …with NO inline health dot on the URL row (the dot lives in the footer, on its own line).
    expect(t.frames()).not.toMatch(/http:\/\/localhost:57076\/api\/v1[^\n]*●/)
    // …and the live footer carries the health dot.
    expect(t.frame()).toContain('● ok')
  })

  it('refresh() flips the footer health to down WITHOUT reprinting the committed header', () => {
    const t = makeUi()

    t.ui.ready(baseSummary())
    t.ui.refresh(
      baseSummary({ endpoints: [{ tag: 'client/api', url: 'http://localhost:57076/api/v1', healthy: false }] }),
    )

    // The footer now shows down…
    expect(t.frame()).toContain('● down')
    expect(t.frame()).not.toContain('● ok')
    // …and the header URL is committed exactly once (Static never re-emits it on a footer repaint).
    expect(countOf(t.frame(), 'http://localhost:57076/api/v1')).toBe(1)
  })

  it('a log in persistent mode appears above the footer and tees, without reprinting the header', () => {
    const t = makeUi()

    t.ui.ready(baseSummary())
    t.ui.log('hello', 'info')

    expect(t.frames()).toContain('hello')
    expect(t.appendLog.join('')).toContain('[INFO] hello')
    // The footer still carries live health, and the header is committed exactly once (not reprinted).
    expect(t.frame()).toContain('● ok')
    expect(countOf(t.frame(), 'http://localhost:57076/api/v1')).toBe(1)
  })

  it('an event in persistent mode appends a timestamped tail line above the footer', () => {
    const t = makeUi()

    t.ui.ready(baseSummary())
    t.ui.event({ tag: 'client/api', text: 'GET /api/v1/ping 200 12ms' })

    expect(t.frames()).toContain('GET /api/v1/ping 200 12ms')
    expect(t.appendLog.join('')).toContain('client/api GET /api/v1/ping 200 12ms')
  })
})

describe('persistentInkDevUi — one session shape, no handoff', () => {
  /**
   * `ready` used to branch on `hasUiChild` and, for a UI session, unmount Ink and hand off to a DECSTBM
   * scroll-region UI. That existed for exactly one reason: the `turbo run dev` child's piped output
   * produced an unbounded tail, and a pinned footer can only survive a scrolling stream if the TERMINAL
   * is told to confine it.
   *
   * That tail is gone — framework and request lines go to their per-service log files and are never
   * printed. So the branch, the handoff, and the whole scroll-region machinery went with it. This pins
   * that a UI session now takes the SAME persistent-panel path as a backend-only one; a regression that
   * quietly reintroduced a second code path would show up here.
   */
  it('gives a UI session the same persistent panel as a backend-only one', async () => {
    const t = makeUi()

    t.ui.bootStep('starting servers')
    await settle()
    t.ui.ready(baseSummary({ uiRefs: [{ tag: 'client/ui' }] }))

    // Rendered by Ink into frames — NOT written straight to stdout, which is what the handoff used to do.
    expect(t.frames()).toContain('client/ui')
    expect(t.frames()).toContain('http://localhost:57076/api/v1')

    // And `refresh` repaints in place, on this path too: the panel's heartbeat is what tells the user a
    // silent session is alive rather than hung.
    t.ui.refresh(baseSummary({ uiRefs: [{ tag: 'client/ui' }] }))
    expect(() => {
      t.ui.dispose()
    }).not.toThrow()
  })
})

describe('persistentInkDevUi — dispose', () => {
  it('dispose is idempotent and safe when never mounted', () => {
    const t = makeUi()

    expect(() => {
      t.ui.dispose()
      t.ui.dispose()
    }).not.toThrow()
  })

  it('dispose after a persistent ready commits the final footer and unmounts without throwing', () => {
    const t = makeUi()

    t.ui.ready(baseSummary())

    expect(() => {
      t.ui.dispose()
      t.ui.dispose()
    }).not.toThrow()
  })
})

describe('live-region — output-only invariant', () => {
  it('live-region.tsx source never uses useInput (raw mode must stay off)', () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'live-region.tsx')
    const source = fs.readFileSync(file, 'utf-8')

    expect(/\buseInput\s*\(/.test(source)).toBe(false)
    expect(
      source.split('\n').some((line) => {
        return line.includes('useInput') && /from\s*['"]ink['"]/.test(line)
      }),
    ).toBe(false)
  })
})

/**
 * The DEFAULT stdout (no `stdout` dep — i.e. what production actually constructs) must be the
 * scrollback-safe stream, not raw `process.stdout`. Ink emits `ESC[3J` ("erase saved lines") whenever a
 * frame overflows the viewport, which wipes the terminal's scrollback: the user's history, and — when
 * `dev` runs as a session-shell child — every previous command's output in the transcript.
 *
 * This asserts the WIRING (the stream Ink is handed scrubs the escape), which is the only honest thing a
 * unit test can claim here: `ink-testing-library` never exercises the real `clearTerminal` path, so a
 * frame-content assertion would be a false green. The scrollback behaviour itself is PTY-only.
 */
describe('persistentInkDevUi — default stdout is scrollback-safe', () => {
  /** Mount with no `stdout` dep and return the stream the render seam was handed. */
  const captureInkStdout = (): NodeJS.WriteStream => {
    let captured: NodeJS.WriteStream | undefined

    const renderSeam = (_tree: ReactElement, options?: unknown): InkInstance => {
      captured = (options as { stdout: NodeJS.WriteStream }).stdout

      return {
        rerender: () => {
          return undefined
        },
        unmount: () => {
          return undefined
        },
      } as unknown as InkInstance
    }

    const ui = new PersistentInkDevUi({
      appendLog: () => {
        return undefined
      },
      now: () => {
        return frozen
      },
      render: renderSeam as unknown as PersistentInkDevUiDeps['render'],
      // deliberately NO `stdout` — exercise the production default
    })

    ui.bootStep('booting')

    if (!captured) throw new Error('render seam was never called')

    return captured
  }

  it('hands Ink a stream that strips the scrollback-erasing escape', () => {
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      written.push(String(chunk))

      return true
    })

    try {
      // Exactly what Ink's `clearTerminal` emits on POSIX: erase viewport, ERASE SCROLLBACK, home cursor.
      captureInkStdout().write('\u001B[2J\u001B[3J\u001B[H')
    } finally {
      spy.mockRestore()
    }

    // The scrollback-erasing escape is gone; Ink's actual intent (clear viewport + home) survives.
    expect(written.join('')).toBe('\u001B[2J\u001B[H')
    expect(written.join('')).not.toContain('\u001B[3J')
  })

  it('stays a live view of the real stream (Ink reads columns/rows afresh per frame)', () => {
    const stream = captureInkStdout()

    // A snapshot/copy would break Ink's resize handling; the proxy must forward through to the real tty.
    expect(stream.columns).toBe(process.stdout.columns)
    expect(typeof stream.on).toBe('function')
  })
})
