import process from 'node:process'

/**
 * @fileoverview
 * Who is holding `process.stdin` open, and therefore whether node may exit.
 *
 * THE PROBLEM THIS SOLVES — Ink `unref()`s stdin when it drops raw mode on teardown
 * (ink/build/components/App.js:137), and `ref()`s it again when it arms raw mode
 * (App.js:225). That is correct and self-balancing FOR INK. But an `@inquirer/*` prompt
 * refs nothing: opened after an Ink screen has torn down, it reads a stdin that is still
 * unref'd, so once the command's other work settles the event loop drains MID-PROMPT and
 * node exits 13 with the question still on screen. (Verified: an Ink teardown followed by
 * a bare `confirm()` exits 13; the same flow with a `ref()` before the prompt completes
 * normally.) The old fix re-ref'd stdin after EVERY Ink render (tui/boot.tsx), which
 * bought the prompt its handle and cost the session shell its exit — a ref'd tty
 * ReadStream holds the loop open whether or not anything is listening to it.
 *
 * THE RULE — stdin is ref'd exactly while an in-process reader intends to read it. Ink
 * asserts that for itself; `withEscape` asserts it for every inquirer prompt by acquiring
 * here. Nobody else may touch `process.stdin.ref` / `.unref`.
 *
 * WHY A COUNTER AND NOT A BOOLEAN — `ref()`/`unref()` on a tty `ReadStream` is a sticky
 * flag, not a counter: last writer wins, process-wide. So nested readers (the dev wizard
 * runs ~5 prompts back to back, and `release-create` nests) need us to remember how many
 * are live, or the FIRST one to finish would unref a handle the outer one is still
 * reading from.
 *
 * BOUNDARY — no Ink render may happen inside a `withEscape` callback. Ink's teardown
 * `unref()`s unconditionally, clobbering an outer reader's ref while this counter still
 * says someone is reading; the counter cannot stop it, because `unref` is not a hook
 * point. Nothing STRUCTURALLY enforces this today (the sweep in
 * `__tests__/every-inquirer-site-is-escapable.test.ts` proves prompts sit inside
 * `withEscape` — a different claim, and it would not catch an Ink screen rendered there).
 * It holds by construction: every `withEscape` callback in the tree contains an
 * `@inquirer/*` call and nothing else. `tui/boot.tsx` re-asserts the ref whenever this
 * counter reports a live reader, which makes a future violation survivable rather than a
 * silent exit 13 — but it is a net, not a fence.
 *
 * Process-wide state is correct here and is NOT shared across the session shell's spawn
 * boundary: the parent and each spawned child are separate processes with separate
 * counters (lib/session/run-session.ts:152).
 */
let readers = 0

/**
 * Register a reader and ref stdin if it is the first. Pair with {@link releaseStdin} in a
 * `finally`, or node will never exit.
 *
 * @example
 * acquireStdin() // => stdin ref'd on 0 -> 1
 */
export const acquireStdin = (): void => {
  readers += 1

  if (readers === 1) process.stdin.ref()
}

/**
 * Drop a reader and unref stdin once the last one leaves, letting node exit naturally.
 *
 * Clamped at zero rather than trusting callers: a release without a matching acquire
 * would otherwise drive the count negative and silently disarm the next `acquireStdin`
 * (`readers === 1` would never hold again), turning this guard into the bug it prevents.
 *
 * @example
 * releaseStdin() // => stdin unref'd on 1 -> 0
 */
export const releaseStdin = (): void => {
  if (readers === 0) return

  readers -= 1

  if (readers === 0) process.stdin.unref()
}

/**
 * How many in-process readers currently intend to read stdin. Consulted by `tui/boot.tsx`
 * to decide whether Ink's teardown `unref()` just clobbered somebody.
 *
 * @example
 * stdinReaderCount() // => 0 when no prompt is open
 */
export const stdinReaderCount = (): number => {
  return readers
}
