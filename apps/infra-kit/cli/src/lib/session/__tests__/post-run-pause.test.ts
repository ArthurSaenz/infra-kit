import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PauseContext, PauseKey, PauseStdin, PostRunPauseDeps } from '../post-run-pause'
import { awaitPostRunKey, classifyPauseKey } from '../post-run-pause'

/**
 * The post-run pause, asserted through injected seams: a recording fake stdin, a recording `write`,
 * and a counting stand-in for the stdin refcount. What these can prove is ORDER, BALANCE and
 * OWNERSHIP — that the ref is taken before raw mode and given back last, that every hint write is
 * matched by exactly one erase, and that the arm and suspend blocks contain no `await`. What they
 * cannot prove is that the erase actually cleared a row on a screen; that is the tmux gate
 * (scripts/qa/post-run-pause-pty.sh), and the liveness half is the pty suite.
 */

/**
 * Shared recorder for every observable operation, tagged with a logical tick so a test can prove two
 * operations happened without an event-loop turn between them. Hoisted because the `vi.mock` factory
 * below runs before the module body.
 */
const rec = vi.hoisted(() => {
  const ops: Array<{ op: string; tick: number }> = []
  const clock = { tick: 0 }
  const refs = { count: 0 }

  return {
    ops,
    clock,
    refs,
    push: (op: string) => {
      ops.push({ op, tick: clock.tick })
    },
    names: (): string[] => {
      return ops.map((entry) => {
        return entry.op
      })
    },
  }
})

/**
 * The real refcount is process-global and its effect (`process.stdin.ref`) is not observable from a
 * test, so the counter is faked here: acquire/release land in the same ordered log as raw mode and
 * the listener, which is the only way to assert "released LAST".
 */
vi.mock('src/lib/prompts/stdin-ref', () => {
  return {
    acquireStdin: () => {
      rec.refs.count += 1
      rec.push('acquire')
    },
    releaseStdin: () => {
      rec.refs.count -= 1
      rec.push('release')
    },
    stdinReaderCount: () => {
      return rec.refs.count
    },
  }
})

const ERASE = '\r\u001B[2K'
const FRESH_ROW = '\r\n'

/** Label a write by what it is, so the ordered log reads as terminal operations rather than strings. */
const labelWrite = (text: string): string => {
  if (text === ERASE) return 'erase'

  return text.startsWith(FRESH_ROW) ? 'hint:fresh-row' : 'hint'
}

/** A `PauseStdin` that records every call and can deliver bytes to whatever listener is attached. */
const makeStdin = (opts: { isTTY?: boolean } = {}) => {
  const listeners = new Set<(chunk: Uint8Array) => void>()
  const state = { isTTY: opts.isTTY ?? true, isRaw: false, paused: true }

  const fake = {
    get isTTY(): boolean {
      return state.isTTY
    },
    get isRaw(): boolean {
      return state.isRaw
    },
    setRawMode: (mode: boolean) => {
      state.isRaw = mode
      rec.push(`setRawMode:${String(mode)}`)
    },
    resume: () => {
      state.paused = false
      rec.push('resume')
    },
    pause: () => {
      state.paused = true
      rec.push('pause')
    },
    isPaused: () => {
      return state.paused
    },
    on: (_event: 'data', listener: (chunk: Uint8Array) => void) => {
      listeners.add(listener)
      rec.push('attach')
    },
    off: (_event: 'data', listener: (chunk: Uint8Array) => void) => {
      listeners.delete(listener)
      rec.push('detach')
    },
    /** Deliver one raw chunk, exactly as node would. */
    press: (bytes: number[]) => {
      for (const listener of [...listeners]) listener(Uint8Array.from(bytes))
    },
    attached: () => {
      return listeners.size
    },
  }

  return fake
}

interface HarnessOpts {
  isTTY?: boolean
  quitRequested?: boolean
  suspend?: () => void
  columns?: () => number | undefined
  onWrite?: (text: string) => void
  drainMs?: number
}

const harness = (opts: HarnessOpts = {}) => {
  const stdin = makeStdin({ isTTY: opts.isTTY })
  const writes: string[] = []
  const armed = { count: 0 }

  const deps: PostRunPauseDeps = {
    write: (text: string) => {
      // Before the log, so a write that throws records nothing — nothing landed on the terminal.
      opts.onWrite?.(text)
      rec.push(labelWrite(text))
      writes.push(text)
    },
    columns:
      opts.columns ??
      (() => {
        return 80
      }),
    ascii: true,
    color: false,
    suspend: opts.suspend,
    stdin: stdin satisfies PauseStdin,
    drainMs: opts.drainMs ?? 5,
  }

  const ctx: PauseContext = {
    armed: () => {
      armed.count += 1
      rec.push('armed')
    },
    quitRequested: () => {
      return opts.quitRequested === true
    },
  }

  /** Just the hint writes, in order — `writes` also holds the erases they are balanced against. */
  const hints = (): string[] => {
    return writes.filter((text) => {
      return text !== ERASE
    })
  }

  return { armed, ctx, deps, hints, stdin, writes }
}

/** Let real timers run: the drain is a `setTimeout`, kept short by the injected `drainMs`. */
const after = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Count how many of the given ops the log holds. */
const countOf = (op: string): number => {
  return rec.names().filter((name) => {
    return name === op
  }).length
}

beforeEach(() => {
  rec.ops.length = 0
  rec.clock.tick = 0
  rec.refs.count = 0
})

const CLASSIFIER_TABLE: Array<{ name: string; bytes: number[]; key: PauseKey }> = [
  { name: 'Ctrl-C', bytes: [0x03], key: 'quit' },
  { name: 'Ctrl-D', bytes: [0x04], key: 'quit' },
  { name: 'a lone Esc', bytes: [0x1b], key: 'quit' },
  { name: 'Ctrl-Z', bytes: [0x1a], key: 'suspend' },
  { name: 'space', bytes: [0x20], key: 'continue' },
  { name: 'Enter', bytes: [0x0d], key: 'continue' },
  { name: 'an up arrow', bytes: [0x1b, 0x5b, 0x41], key: 'continue' },
  { name: 'a coalesced Esc+x', bytes: [0x1b, 0x78], key: 'continue' },
  { name: 'a 4-byte emoji', bytes: [0xf0, 0x9f, 0x92, 0xa9], key: 'continue' },
  { name: 'an empty chunk', bytes: [], key: 'continue' },
]

describe('classifyPauseKey', () => {
  it.each(CLASSIFIER_TABLE)('reads $name as $key', ({ bytes, key }) => {
    expect(classifyPauseKey(Uint8Array.from(bytes))).toBe(key)
  })

  // THE PRODUCTION SHAPE. Ink calls `stdin.setEncoding('utf8')` on every raw-mode arm and never
  // clears it, so from the first palette on, `process.stdin` emits STRINGS. Classified as bytes only,
  // `chunk[0]` was a one-character string, the lookup missed, and every key at the pause — Esc,
  // Ctrl-C, Ctrl-D, Ctrl-Z — read as 'continue': Esc redrew the palette instead of quitting and
  // Ctrl-Z never suspended. A Uint8Array-only table is green against a shell that answers no key.
  it.each(CLASSIFIER_TABLE)('reads $name as $key when stdin is in utf8 string mode', ({ bytes, key }) => {
    expect(classifyPauseKey(String.fromCharCode(...bytes))).toBe(key)
  })

  it('agrees on both chunk representations for every row of the table', () => {
    const disagreeing = CLASSIFIER_TABLE.filter((entry) => {
      return classifyPauseKey(Uint8Array.from(entry.bytes)) !== classifyPauseKey(String.fromCharCode(...entry.bytes))
    })

    expect(disagreeing).toEqual([])
  })

  it('never quits on a multi-byte chunk, so an escape sequence fails toward the palette', () => {
    const multiByte = CLASSIFIER_TABLE.filter((entry) => {
      return entry.bytes.length !== 1
    })

    expect(
      multiByte.map((entry) => {
        return entry.key
      }),
    ).toEqual(
      multiByte.map(() => {
        return 'continue'
      }),
    )
  })
})

describe('awaitPostRunKey arming', () => {
  it('arms in one synchronous block: acquire, raw mode, resume, listener, then the phase flip', async () => {
    const h = harness()

    const pending = awaitPostRunKey(h.ctx, h.deps)

    // Asserted with no interleaving await: an `await` anywhere in the arm block would leave a window
    // in which the phase says 'pause' while the tty is still cooked, or stdin armed but unref'd.
    expect(rec.names()).toEqual(['acquire', 'setRawMode:true', 'resume', 'attach', 'armed'])
    expect(h.writes).toEqual([])
    expect(h.armed.count).toBe(1)

    await after(20)
    h.stdin.press([0x20])

    await expect(pending).resolves.toBe('palette')
  })

  it('discards every byte delivered during the drain and stays open', async () => {
    const h = harness({ drainMs: 60 })
    let settled = false

    const pending = awaitPostRunKey(h.ctx, h.deps)

    void pending.then(() => {
      settled = true
    })

    // A stale Ctrl-C and Esc, aimed at the child that just died.
    h.stdin.press([0x03])
    h.stdin.press([0x1b])
    await after(15)

    expect(settled).toBe(false)
    expect(h.writes).toEqual([])

    await after(70)

    expect(h.writes).toHaveLength(1)

    h.stdin.press([0x20])

    await expect(pending).resolves.toBe('palette')
  })

  it('resolves "quit" with nothing armed and nothing written when a SIGTERM already asked to quit', async () => {
    const h = harness({ quitRequested: true })

    await expect(awaitPostRunKey(h.ctx, h.deps)).resolves.toBe('quit')
    expect(rec.names()).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.armed.count).toBe(0)
  })

  it('resolves "palette" on a non-TTY stdin without arming, writing, or flipping the phase', async () => {
    const h = harness({ isTTY: false })

    await expect(awaitPostRunKey(h.ctx, h.deps)).resolves.toBe('palette')
    expect(rec.names()).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.armed.count).toBe(0)
    expect(h.stdin.isRaw).toBe(false)
  })
})

describe('awaitPostRunKey exits', () => {
  it('quits on Esc and gives the terminal back in order, releasing the ref LAST', async () => {
    const h = harness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)
    h.stdin.press([0x1b])

    await expect(pending).resolves.toBe('quit')
    expect(rec.names().slice(-4)).toEqual(['erase', 'detach', 'setRawMode:false', 'release'])
    expect(rec.refs.count).toBe(0)
    expect(h.stdin.isRaw).toBe(false)
    expect(h.stdin.attached()).toBe(0)
  })

  // `stdin.pause()` reaches libuv and `readStop()`s the handle, and a STOPPED handle is inactive, so
  // it holds the event loop open for nobody however many times it is ref'd. The palette Ink mounts
  // next refs stdin and attaches a `readable` listener, which only restarts the read when the
  // stream's `reading` flag is false — and this pause reads in flowing `data` mode, where it is true.
  // Measured on a pty: the palette drew and node then exited 0 with the frame still on screen, once
  // per command. `tui/boot.tsx` still pauses on its own teardown, which is what keeps a `stdio:
  // 'inherit'` child from contending for bytes.
  it('never pauses stdin, so the palette Ink mounts next can restart the read', async () => {
    const h = harness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)
    h.stdin.press([0x20])

    await expect(pending).resolves.toBe('palette')
    expect(rec.names()).not.toContain('pause')
  })

  it('balances one hint write against one erase on the quit path', async () => {
    const h = harness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)
    h.stdin.press([0x03])
    await pending

    expect(countOf('hint')).toBe(1)
    expect(countOf('erase')).toBe(1)
  })

  it('balances one hint write against one erase on the palette path', async () => {
    const h = harness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)
    h.stdin.press([0x20])

    await expect(pending).resolves.toBe('palette')
    expect(countOf('hint')).toBe(1)
    expect(countOf('erase')).toBe(1)
  })

  it('restores the terminal and propagates when the hint write throws', async () => {
    const boom = new Error('lost the tty')
    const h = harness({
      onWrite: () => {
        throw boom
      },
    })

    const pending = awaitPostRunKey(h.ctx, h.deps)
    // Attached before the drain elapses: the rejection lands mid-`after`, and an unhandled rejection
    // there fails the run for a reason that has nothing to do with the assertion.
    const rejected = expect(pending).rejects.toThrow(boom)

    await after(20)

    await rejected
    expect(h.stdin.isRaw).toBe(false)
    expect(h.stdin.attached()).toBe(0)
    expect(rec.refs.count).toBe(0)
    // Nothing landed on screen, so nothing is owed an erase.
    expect(countOf('erase')).toBe(0)
  })
})

describe('awaitPostRunKey suspend', () => {
  const suspendHarness = (over: HarnessOpts = {}) => {
    const stops = { count: 0 }
    const h = harness({
      ...over,
      suspend: () => {
        stops.count += 1
        rec.push('stop')
      },
    })

    return { ...h, stops }
  }

  it('calls the suspend seam, does not resolve, and re-arms with a fresh-row hint', async () => {
    const h = suspendHarness()
    let settled = false

    const pending = awaitPostRunKey(h.ctx, h.deps)

    void pending.then(() => {
      settled = true
    })

    await after(20)
    h.stdin.press([0x1a])
    await after(10)

    expect(h.stops.count).toBe(1)
    expect(settled).toBe(false)
    expect(h.hints()).toHaveLength(2)
    expect(h.hints()[1]?.startsWith(FRESH_ROW)).toBe(true)
    expect(rec.refs.count).toBe(1)
    expect(h.stdin.isRaw).toBe(true)

    h.stdin.press([0x20])

    await expect(pending).resolves.toBe('palette')
  })

  it('runs disarm, stop and re-arm in one tick, so nothing is unref’d across an event-loop turn', async () => {
    const h = suspendHarness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)

    const mark = rec.ops.length

    // Fires only if the suspend block yields; every op before it is in the same tick.
    queueMicrotask(() => {
      rec.clock.tick = 1
    })
    h.stdin.press([0x1a])

    const block = rec.ops.slice(mark)

    expect(
      block.map((entry) => {
        return entry.op
      }),
    ).toEqual([
      'erase',
      'detach',
      'setRawMode:false',
      'release',
      'stop',
      'acquire',
      'setRawMode:true',
      'attach',
      'hint:fresh-row',
    ])
    expect(
      block.map((entry) => {
        return entry.tick
      }),
    ).toEqual(
      block.map(() => {
        return 0
      }),
    )

    h.stdin.press([0x03])
    await pending
  })

  it('re-formats the hint from a fresh columns() read, so a resize while stopped shortens it', async () => {
    const width = { value: 80 }
    const h = suspendHarness({
      columns: () => {
        return width.value
      },
    })
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)
    width.value = 30
    h.stdin.press([0x1a])
    await after(10)

    const first = h.hints()[0] ?? ''
    const second = (h.hints()[1] ?? '').slice(FRESH_ROW.length)

    expect(second.length).toBeLessThan(first.length)
    expect(second).toHaveLength(29)

    h.stdin.press([0x20])
    await pending
  })

  it('balances two hint writes against two erases across suspend then a key', async () => {
    const h = suspendHarness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)
    h.stdin.press([0x1a])
    h.stdin.press([0x20])

    await expect(pending).resolves.toBe('palette')
    expect(countOf('hint') + countOf('hint:fresh-row')).toBe(2)
    expect(countOf('erase')).toBe(2)
  })

  it('ends a suspend, resume, then quit with raw mode off and the ref released', async () => {
    // The sequence a shared once-only guard between disarmPause and settle silently breaks: the
    // guard would be spent by the suspend, and the quit would leave raw mode armed and stdin ref'd.
    const h = suspendHarness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)
    h.stdin.press([0x1a])
    h.stdin.press([0x1b])

    await expect(pending).resolves.toBe('quit')
    expect(h.stdin.isRaw).toBe(false)
    expect(h.stdin.attached()).toBe(0)
    expect(rec.refs.count).toBe(0)
    expect(rec.names().slice(-4)).toEqual(['erase', 'detach', 'setRawMode:false', 'release'])
  })

  it('treats Ctrl-Z as an ordinary key where suspending is impossible (win32)', async () => {
    const h = harness()
    const pending = awaitPostRunKey(h.ctx, h.deps)

    await after(20)

    expect(h.hints()[0]).not.toContain('Ctrl-Z')

    h.stdin.press([0x1a])

    await expect(pending).resolves.toBe('palette')
    expect(countOf('hint')).toBe(1)
    expect(countOf('erase')).toBe(1)
  })
})
