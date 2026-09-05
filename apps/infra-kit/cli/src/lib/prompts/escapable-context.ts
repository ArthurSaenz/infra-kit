import type { Buffer } from 'node:buffer'
import process from 'node:process'

import { isMcpMode } from 'src/lib/mcp-mode'

import { acquireStdin, releaseStdin } from './stdin-ref'

/**
 * Structural mirror of `@inquirer/type`'s `Context` — the second argument every
 * `@inquirer/*` prompt takes. Declared here rather than imported because
 * `@inquirer/core` and `@inquirer/type` are transitive dependencies of this
 * package, not direct ones (only the four prompt packages are).
 */
export interface PromptContext {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  clearPromptOnDone?: boolean
  signal?: AbortSignal
}

const ESC_BYTE = 0x1b

/**
 * Run an `@inquirer/*` prompt with Esc bound to cancellation. On Esc the prompt rejects with an
 * `AbortPromptError`, which `entry/cli.ts` already catches at the top level -> "Operation
 * cancelled." -> exit 0.
 *
 * The listener attaches only on a real interactive terminal. `isTTY` alone is NOT a sufficient
 * guard — see lib/mcp-mode for why `stdio: 'inherit'` defeats it.
 */
// The cancel path is entirely pre-existing plumbing: an `AbortController`'s signal goes into the
// prompt context, `@inquirer/core` rejects with an `AbortPromptError` when it fires, and that name
// is already in `CANCELLATION_ERROR_NAMES` (lib/errors/is-prompt-cancellation). All this adds is
// the thing that calls `abort()`.
//
// DETECTION — a raw `data` listener that aborts iff the chunk is exactly one `0x1b` byte.
// Deliberately NOT readline `keypress`: that delivers a lone Esc only after its escape-sequence
// timeout (~523ms measured), and the `escapeCodeTimeout` dial that would shorten it is
// process-global and first-armer-wins — a second `emitKeypressEvents` call on `process.stdin` is
// SILENTLY IGNORED, so the dial degrades to a no-op with no error and no failing test. The raw
// listener costs ~24ms and touches no global state. Arrow keys (`\x1b[B`, 3 bytes) and Alt combos
// (`\x1bb`, 2 bytes) are ignored because they are LONGER — no parsed key field is involved. Node
// `data` listeners broadcast, so this one does not steal bytes from readline: arrows and Enter keep
// working while it is attached.
//
// FALSE POSITIVES are a non-issue: there is no routine source of a lone-`0x1b` chunk. Focus events
// (`\x1b[I`/`\x1b[O`), bracketed paste (`\x1b[200~`) and mouse reports (`\x1b[M…`) are all
// multi-byte, and inquirer enables none of them.
//
// FALSE NEGATIVE — measured and accepted: a COALESCED Esc (`"\x1bx"` arriving in ONE chunk, i.e.
// Esc immediately followed by another key) is silently dropped and the prompt stays open. The fix
// would be Ink's 20ms deferred abort — hold the lone Esc, cancel it if a follow-up chunk lands.
// That is a logged NON-GOAL; do not pre-build it.
export const withEscape = async <T>(run: (context: PromptContext) => Promise<T>, base?: PromptContext): Promise<T> => {
  const controller = new AbortController()
  const context: PromptContext = { ...base, signal: controller.signal }

  if (isMcpMode() || !process.stdin.isTTY) return run(context)

  const input = process.stdin

  const onData = (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === ESC_BYTE) controller.abort()
  }

  // STDIN OWNERSHIP — this is the seam that keeps stdin alive for inquirer, which refs
  // nothing itself. It must sit BELOW the early return above: a non-TTY run never reads
  // stdin, so acquiring there would ref a handle nobody reads and hang the process. See
  // lib/prompts/stdin-ref for why an unref'd stdin kills a prompt with exit 13.
  acquireStdin()

  try {
    // Attach after the prompt has built its readline interface. Cheap ordering defence
    // only — there is no race today: readline attaches its own consumer synchronously
    // and `data` events are async.
    //
    // INSIDE the `try`, both of them: `run` is caller-supplied and `@inquirer/core` runs
    // synchronously up to readline construction, so a SYNCHRONOUS throw here would skip a
    // `finally` placed any lower — leaking the ref and hanging the CLI, which is the exact
    // failure this module exists to prevent.
    const pending = run(context)

    // Explicit, because `on('data')` alone is NOT enough to start the flow: `Readable` resumes on a
    // new `data` listener only when `flowing !== false`, and the palette's teardown now pauses stdin
    // (tui/boot.tsx) so a prompt opened after an Ink screen inherits `flowing === false`. Esc would be
    // silently dead. It happens to work anyway today — `run()` above builds inquirer's readline, whose
    // constructor resumes the stream — but that is an undocumented side effect of a TRANSITIVE
    // dependency, and the ordering it relies on is the very thing the comment below reserves the right
    // to change. One idempotent call is cheaper than that coupling.
    if (input.isPaused()) input.resume()

    input.on('data', onData)

    return await pending
  } finally {
    // Non-negotiable: the dev wizard runs ~5 prompts back to back, so a leaked
    // listener would abort the next one.
    input.removeListener('data', onData)
    // Same `finally` as the listener teardown, and for the same reason: every exit path
    // (answer, Esc abort, throw) must give the ref back, or node never exits.
    releaseStdin()
  }
}
