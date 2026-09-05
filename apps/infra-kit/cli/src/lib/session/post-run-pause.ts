import process from 'node:process'

import { acquireStdin, releaseStdin } from 'src/lib/prompts/stdin-ref'

import { formatPauseHint } from './format-entry'

/**
 * @fileoverview
 * The one blocking keypress the session shell puts between a command's status footer and the next
 * palette draw, so the output the user just asked for stays on screen until they ask for the list
 * back. One dim hint row is written into the blank row the footer's trailing newline opened, one raw
 * key is read, the hint is erased, and control goes back to the loop. Esc / Ctrl-C / Ctrl-D quit the
 * session; Ctrl-Z suspends the job and comes back to the same pause; anything else reopens the
 * palette.
 *
 * **The stdin ref is what keeps node alive across the pause.** `acquireStdin` (lib/prompts/stdin-ref)
 * is the only sanctioned way to take it, and step 2 of the arm sequence is not optional: `resume()`
 * does not re-ref a handle that was explicitly unref'd, and the Ink teardown before us leaves stdin
 * unref'd and paused. Armed without the ref, a pause with a pending promise drains the event loop
 * and node EXITS WITH STATUS 0 about 150 ms into every command — measured on a pty, and status 0 is
 * the worst possible code because it is indistinguishable from a deliberate quit. `releaseStdin` is
 * therefore the LAST step of the disarm, symmetric with the acquire being the first of the arm.
 *
 * **The arm block and the suspend block each run with no `await` inside them.** Node dispatches
 * signal handlers and `data` events between event-loop turns, so a synchronous statement sequence has
 * no window at all: there is no instant at which the signal phase says `'pause'` while the tty is
 * still cooked, and none at which stdin is armed but unref'd. In the suspend block the same rule is
 * load-bearing for a second reason — the disarm releases the last reader and therefore unrefs the
 * handle, and only the re-acquire three statements later takes it back. Insert an `await` anywhere in
 * that window (a logging seam, a promise-returning "flush before suspend" write) and the loop drains
 * with nothing ref'd and node exits, which is the exit-0 defect above in a second location.
 *
 * **Resume from a suspend is `fg` only.** `bg` or a bare `kill -CONT` leaves us in a background
 * process group, where re-arming raw mode is a `tcsetattr` that raises SIGTTOU and stops the job
 * again, silently. Same as vim, same as Ink. Inherited from `suspendForeground`, whose preconditions
 * this module satisfies: raw mode dropped before the stop, cursor visible, cursor at column 0.
 *
 * **Non-goals, all of which fail toward the palette rather than toward quitting.** A coalesced
 * `Esc`+key chunk reads as one "continue", and so does a bracketed paste: the classifier's rule is
 * chunk length, the same rule `withEscape` uses (lib/prompts/escapable-context), and a lone `0x1b` is
 * the only Esc it recognises. And a resize while the hint is on screen is accepted damage: the
 * emulator reflows the row into two, the erase clears one, and the other survives as a dim corpse
 * once per resize. No fixed width is safe against an arbitrary narrowing, and a SIGWINCH redraw has
 * the defect `src/tui/safe-stderr.ts` records one layer down — it reasons about the new viewport with
 * the previous frame's geometry. The `fg` case is different and IS handled, because there the hint is
 * being rewritten anyway — one ioctl (`stderrColumns` in run-session refreshes the size, because a
 * stopped job never receives the resize) and the fresh `columns()` read is right.
 */

/** What a raw chunk read at the pause means. */
export type PauseKey = 'quit' | 'suspend' | 'continue'

/**
 * The only chunks that mean anything other than "a key was pressed". Every one is a single control
 * byte, because chunk length is the whole disambiguation rule: `\x1b[A` (an arrow) and `\x1bx`
 * (a coalesced Esc) are longer and therefore ordinary keys.
 */
const SINGLE_BYTE: Record<number, PauseKey> = {
  0x03: 'quit',
  0x04: 'quit',
  0x1a: 'suspend',
  0x1b: 'quit',
}

/**
 * Classify one raw stdin chunk. Total and platform-free: where suspending is impossible the CALLER
 * maps `'suspend'` to `'continue'`, mirroring how the palette takes its `onSuspend` as the platform
 * authority's verdict rather than inspecting `process`.
 *
 * Accepts a string OR a `Uint8Array`; both are production shapes.
 *
 * @example
 * classifyPauseKey(Uint8Array.from([0x1b])) // => 'quit'
 * classifyPauseKey('\x1b') // => 'quit'  (the production shape: Ink left stdin in utf8 mode)
 * classifyPauseKey(Uint8Array.from([0x1b, 0x5b, 0x41])) // => 'continue'  (an arrow key)
 */
// A CHUNK IS A STRING IN PRODUCTION, NOT A `Uint8Array`. Ink calls `stdin.setEncoding('utf8')` on
// every `handleSetRawMode` (ink 7.1.1 `App.js:217`) and never clears it, so from the moment the
// first palette mounts, `process.stdin` emits strings for the rest of the process. Typed as
// `Uint8Array` only, this function read `chunk[0]` as the CHARACTER `'\x1a'`, `SINGLE_BYTE` missed
// on it, and every key at the pause — Esc, Ctrl-C, Ctrl-D, Ctrl-Z alike — classified as
// `'continue'`: Esc redrew the palette instead of quitting and Ctrl-Z never suspended. Measured on
// a pty under tmux (`scripts/qa/post-run-pause-pty.sh`, and directly: `setEncoding('utf8')` then
// Ctrl-Z reports `typeof=string chunk[0]="\x1a"`). Both representations carry the same code for
// every byte in `SINGLE_BYTE` — each is ASCII, so its UTF-8 encoding is one byte and its UTF-16
// unit is that same number — which is why one lookup table serves both.
export const classifyPauseKey = (chunk: Uint8Array | string): PauseKey => {
  if (chunk.length !== 1) return 'continue'

  const code = typeof chunk === 'string' ? chunk.charCodeAt(0) : chunk[0]

  if (code === undefined || Number.isNaN(code)) return 'continue'

  return SINGLE_BYTE[code] ?? 'continue'
}

/**
 * How long every byte arriving at a freshly armed pause is discarded.
 *
 * A user stopping `dev` mashes Ctrl-C, and the kernel tty buffer can still hold those `0x03` bytes
 * when the pause arms microseconds after the child dies. Read naively, the first one would quit the
 * session — a regression on the most common flow in the shell.
 *
 * What it costs when wrong, in the style of `PNPM_RELAY_WINDOW_MS`: too short and a stale Ctrl-C
 * quits the session; too long and a deliberate keypress is swallowed and the user presses again. The
 * mild direction is LONGER. 150 ms sits below the threshold at which a delay reads as unresponsive,
 * which is why the hint is written after the drain rather than before it — a hint on screen means
 * keys are live, and a provisional hint would cost an extra write and an extra erase on the hottest
 * path in the shell.
 */
export const PAUSE_DRAIN_MS = 150

/** `\r` then erase-in-line: put the cursor at column 0 and wipe the hint row it opened. */
const ERASE_HINT = '\r\u001B[2K'

/** The row break that guarantees a post-`fg` hint lands on a row the pause itself opened. */
const FRESH_ROW = '\r\n'

/**
 * The stdin surface the pause needs, declared structurally so tests inject a fake instead of a real
 * tty. `process.stdin` satisfies it; the shape mirrors `ResetTerminalDeps.stdin`, one seam wider.
 */
export interface PauseStdin {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode: (mode: boolean) => void
  resume: () => void
  pause: () => void
  isPaused: () => boolean
  on: (event: 'data', listener: (chunk: PauseChunk) => void) => void
  off: (event: 'data', listener: (chunk: PauseChunk) => void) => void
}

/**
 * What a `data` listener actually receives. A STRING once anything has called
 * `stdin.setEncoding('utf8')` — which Ink does on every raw-mode arm and never undoes — and a
 * `Uint8Array` before that. See {@link classifyPauseKey} for what mistaking one for the other cost.
 */
export type PauseChunk = Uint8Array | string

/**
 * What `runSession` hands the pause so the signal owner and the pause agree on who holds the
 * terminal. Built by the loop and passed to EVERY implementation of the seam, default or injected —
 * closing the signal window is a loop invariant, not a property of one implementation.
 */
export interface PauseContext {
  /**
   * Flip the signal phase to `'pause'`. Idempotent. An implementation that BLOCKS on input MUST call
   * this; one that returns synchronously must not. Blocking without it runs the whole pause with the
   * phase still `'child'`: every SIGINT swallowed, and every SIGTERM deferred into a `quitRequested`
   * flag nobody reads until after a keypress a `kill` cannot supply — an unkillable shell.
   */
  armed: () => void
  /** A SIGTERM that landed during the child, deferred. Read once, before anything is armed. */
  quitRequested: () => boolean
}

/** Everything the pause needs from its caller. */
export interface PostRunPauseDeps {
  /** Where the hint and the erase go — the same stderr seam the transcript uses. */
  write: (text: string) => void
  /** Terminal width, read FRESH at every hint write; `undefined` leaves the hint untruncated. */
  columns: () => number | undefined
  /** Use ASCII glyphs instead of unicode. */
  ascii: boolean
  /** Emit ANSI colour. The caller owns TTY / `NO_COLOR` detection. */
  color: boolean
  /**
   * The platform authority's verdict on Ctrl-Z. Absent means suspending is impossible (win32), and
   * `0x1a` then reads as an ordinary key: the hint drops its suspend clause and the pause resolves.
   */
  suspend?: () => void
  /** Injectable stdin, defaulting to `process.stdin`. */
  stdin?: PauseStdin
  /** Drain window override; production uses {@link PAUSE_DRAIN_MS}. */
  drainMs?: number
}

/**
 * Everything one arming owns, in one object so the arm/disarm/settle helpers can live at module
 * scope — the technique `CommandPalette` uses to keep each function one flat run of guards.
 */
interface PauseState {
  deps: PostRunPauseDeps
  stdin: PauseStdin
  /** The currently attached `data` listener, or null when nothing is attached. */
  listener: ((chunk: PauseChunk) => void) | null
  /** Whether a hint write has landed and is therefore owed exactly one erase. */
  hintOnScreen: boolean
  /** The once-only guard for {@link settle}. Deliberately NOT shared with `disarmPause`. */
  settled: boolean
}

/** Swap in a `data` listener, detaching whatever was there. */
const attachListener = (state: PauseState, listener: (chunk: PauseChunk) => void): void => {
  detachListener(state)
  state.stdin.on('data', listener)
  state.listener = listener
}

/** Detach the current `data` listener, if any. Repeatable. */
const detachListener = (state: PauseState): void => {
  if (state.listener === null) return

  state.stdin.off('data', state.listener)
  state.listener = null
}

/**
 * Take the terminal: ref stdin, arm raw mode, start the flow, attach a listener. Raw mode is armed
 * BEFORE the resume so no cooked-mode line lands between the two.
 *
 * Synchronous by contract — see the module doc. The caller flips the signal phase immediately after,
 * in the same block.
 */
const armPause = (state: PauseState, listener: (chunk: PauseChunk) => void): void => {
  acquireStdin()
  state.stdin.setRawMode(true)

  if (state.stdin.isPaused()) state.stdin.resume()

  attachListener(state, listener)
}

/**
 * Give the terminal back: erase the hint, detach the listener, drop raw mode, release the ref LAST.
 *
 * REPEATABLE, and paired with {@link armPause} — the suspend path calls it once per Ctrl-Z. It must
 * NOT share {@link settle}'s once-only guard: a shared guard is spent at the first suspend, and every
 * later exit becomes a no-op that leaves raw mode armed, the listener attached and stdin ref'd. On a
 * quit that is a hang; on a return to the palette, Ink boots on top of a raw, ref'd, flowing stdin.
 */
const disarmPause = (state: PauseState): void => {
  if (state.hintOnScreen) {
    state.hintOnScreen = false
    state.deps.write(ERASE_HINT)
  }

  detachListener(state)

  // Guarded exactly like `reset-terminal`: a stream that never had a tty has no `isRaw` to drop.
  if (state.stdin.isTTY === true && state.stdin.isRaw === true) state.stdin.setRawMode(false)

  // NO `stdin.pause()` HERE, and the reason is measured, not stylistic.
  //
  // `pause()` on `process.stdin` reaches libuv: it calls `_handle.readStop()` (the chain is spelled
  // out in `tui/boot.tsx`). A STOPPED handle is INACTIVE, and an inactive handle does not hold the
  // event loop open no matter how many times it is `ref()`d. Ink's mount refs stdin and attaches a
  // `readable` listener (ink 7.1.1 `App.js:225`, `:206`) — and that listener only restarts the read
  // when `_readableState.reading` is false. This pause reads in FLOWING mode (`on('data')`), where
  // `reading` stays true, so the restart never fires: the palette drew and then node exited 0 with
  // the frame still on screen, once per command. Measured on a pty; the same sequence with a
  // `readable`-mode reader survives, which is why `boot.tsx` may pause and this may not.
  //
  // `boot.tsx` still pauses on ITS teardown, before the session spawns a `stdio: 'inherit'` child, so
  // the "parent must stop reading before the child starts" guarantee is unchanged — nothing between
  // this line and that one spawns anything. The cost is a window of a few milliseconds, from here to
  // Ink's mount, in which the stream is flowing with no listener and a keystroke would be dropped.
  // Closing it means reading in `readable` mode here too, which is the real fix and a wider change
  // than this file.
  releaseStdin()
}

/**
 * The once-only exit. Runs from a `finally` around everything after the acquire, so a throw anywhere
 * — `setRawMode` on a stream that lost its tty, the `write` seam, a formatter bug — restores the
 * terminal before it propagates instead of leaving a session that eats keystrokes and never exits.
 */
const settle = (state: PauseState): void => {
  if (state.settled) return

  state.settled = true
  disarmPause(state)
}

/**
 * Format and write the hint from a FRESH `columns()` read, and record that one erase is now owed.
 *
 * The width is never snapshotted: the user may have resized while the job was stopped, and a stale
 * string on a narrowed terminal wraps to two rows of which the next erase clears only one. The flag
 * is set only after the write returns, so a write that throws owes no erase.
 */
const writeHint = (state: PauseState, prefix: string): void => {
  const hint = formatPauseHint({
    canSuspend: state.deps.suspend !== undefined,
    ascii: state.deps.ascii,
    color: state.deps.color,
    width: state.deps.columns(),
  })

  state.deps.write(prefix + hint)
  state.hintOnScreen = true
}

/** Discard everything for the drain window, then resolve. A timer, deliberately not an iteration. */
const drain = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Ctrl-Z: hand the terminal back, stop the whole foreground group, and take the terminal again on
 * `fg`. One synchronous statement sequence — `process.kill` is synchronous and no event-loop turn
 * happens while the process is stopped, so nothing is ref'd only for as long as the CPU takes to
 * reach the re-acquire.
 *
 * The leading `\r\n` on the post-resume hint is load-bearing. Between the stop and the `fg` the user
 * was in their own shell, so the cursor is at an unknown column on a row the SHELL owns; writing a
 * bare hint there overwrites their output and the next erase would wipe a row the pause never
 * created. The `\r` is explicit because raw mode clears ONLCR, so a bare `\n` keeps the column.
 */
const suspendAndRearm = (state: PauseState, suspend: () => void, listener: (chunk: PauseChunk) => void): void => {
  disarmPause(state)
  suspend()
  armPause(state, listener)
  writeHint(state, FRESH_ROW)
}

/**
 * Write the hint and block on one classified key. Ctrl-Z does not resolve — the same pause is still
 * there on return, exactly as the palette redraws itself with its filter intact.
 */
const readPauseKey = async (state: PauseState): Promise<'palette' | 'quit'> => {
  return new Promise<'palette' | 'quit'>((resolve) => {
    const onData = (chunk: PauseChunk): void => {
      const key = classifyPauseKey(chunk)
      const suspend = state.deps.suspend

      if (key === 'quit') {
        resolve('quit')

        return
      }

      if (key === 'suspend' && suspend !== undefined) {
        suspendAndRearm(state, suspend, onData)

        return
      }

      resolve('palette')
    }

    attachListener(state, onData)
    writeHint(state, '')
  })
}

/**
 * Hold the session shell at one keypress after a command finishes, and report where the loop goes
 * next. Resolves `'palette'` to redraw the command list, `'quit'` to leave the session.
 *
 * The sequence is fixed and every other doc in this module cites it rather than re-describing it:
 * read `quitRequested()`; ref stdin; arm raw mode; resume; attach a DISCARD listener; flip the signal
 * phase; drain for {@link PAUSE_DRAIN_MS}; swap in the classifying listener and write the hint; wait
 * for a key. Steps one through six are one synchronous block, and flipping the phase inside it rather
 * than after the drain is what makes the drain window signal-correct: SIGINT swallowed, SIGTSTP
 * ignored rather than self-stopping, SIGTERM answered.
 *
 * @example
 * const ctx = { armed: () => {}, quitRequested: () => true }
 * await awaitPostRunKey(ctx, deps) // => 'quit'  (nothing armed, nothing written)
 */
export const awaitPostRunKey = async (ctx: PauseContext, deps: PostRunPauseDeps): Promise<'palette' | 'quit'> => {
  if (ctx.quitRequested()) return 'quit'

  const stdin = deps.stdin ?? process.stdin

  // No tty, no keypress to wait for. Matches `sessionGateEnabled`, which already refuses a non-TTY
  // session; arming here would ref a handle nobody can type into and hang the process.
  if (stdin.isTTY !== true) return 'palette'

  const state: PauseState = { deps, stdin, listener: null, hintOnScreen: false, settled: false }

  try {
    // ONE synchronous block, no `await` — see the module doc.
    armPause(state, () => {
      // The drain's listener: every byte aimed at the child that just died is discarded.
    })
    ctx.armed()

    await drain(deps.drainMs ?? PAUSE_DRAIN_MS)

    return await readPauseKey(state)
  } finally {
    settle(state)
  }
}
