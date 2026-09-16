import type { Buffer } from 'node:buffer'
import process from 'node:process'

import { agentMode, isHeadless } from 'src/lib/agent-mode'
import type { AgentModeSource } from 'src/lib/agent-mode'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'

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

/**
 * What this call site does when there is no human: refuse, refuse NAMING the argument that would have
 * answered the prompt, or answer with a fixed value.
 *
 * - `'refuse'` — throw `{ status: 'refused' }`: the site has no single argument to name.
 * - `{ refuse: 'version' }` — throw `{ status: 'argument_required', argument: 'version' }`: the
 *   agent is told exactly what to pass on the re-run. The name is the CLI flag / tool field without
 *   its dashes; G8 (`headless-policy-guards`) checks it exists on every owning tool's schema.
 * - `{ value: T }` — answer with `value`, no throw.
 *
 * There is no `'unreachable'` any more: that was a claim about the retired server's schema making a
 * field required, and no schema stands between a Bash-driven agent and this prompt.
 */
export type HeadlessPolicy<T> = 'refuse' | { refuse: string } | { value: T }

/** {@link withEscape}'s options: the prompt context, plus this site's headless policy. */
export type EscapeOptions<T> = PromptContext & { whenHeadless?: HeadlessPolicy<T> }

const ESC_BYTE = 0x1b

// Widening the existing options object rather than adding a third parameter: six call sites already
// pass a `PromptContext` (`entry/cli.ts`, `env-load`, `env-token-set`, and the wizard's shared
// context used by three prompts), all of them `{ output: process.stderr }` for documented reasons —
// `env-token-set.ts:64-68` notes that some env commands run inside `$(…)`, where a prompt on stdout
// would leave the user typing a credential into a captured stream. A third parameter would have
// forced every one of them to grow a positional `undefined`.
//
// Optional, and the default is `'refuse'`. That default is safe for the same reason the guard exists
// at all: under `isAgentMode()` nobody is at the keyboard, so no prompt at any site can return a
// usable answer, and refusing removes no
// capability that exists. It is what CLI-only sites (the palette, the dev wizard, `env-token-set`)
// keep, because they face a real human.
//
// It is NOT what an agent-reachable site may keep. There, omitting `whenHeadless` is indistinguishable
// from never having considered the question, so G7 (`every-inquirer-site-is-escapable`) requires the
// answer to be written out — `'refuse'` included.
//
// What the default is NOT is *correct* everywhere — that distinction is the whole point of the
// parameter. `worktrees-add` documents a `false` fallback for agents in its own schema, so a refusal
// there is right-outcome-by-accident at best and a regression at worst. The type cannot tell those
// apart; G6 (description-to-policy) and G8 (argument-to-schema) are what check the answers,
// because a wrong answer here compiles and can never fail a test on its own.
const headlessExcerpt = (source: AgentModeSource): string => {
  if (source === null) return 'an interactive prompt was reached under --json, which never prompts'

  return `an interactive prompt was reached in agent mode (${source === 'flag' ? '--agent' : 'INFRA_KIT_AGENT / CLAUDECODE'}), where there is no human to answer it`
}

const headlessRemediation = (argument: string | undefined): string => {
  const passIt =
    argument === undefined ? 'pass the value explicitly instead of relying on the prompt' : `pass --${argument}`

  return `${passIt} on the re-run`
}

const resolveHeadless = <T>(policy: HeadlessPolicy<T>): T => {
  if (typeof policy === 'object' && 'value' in policy) return policy.value

  const argument = typeof policy === 'object' ? policy.refuse : undefined
  const { source } = agentMode

  throw new StructuredRefusalError(
    argument === undefined
      ? { status: 'refused', agentMode: source }
      : { status: 'argument_required', argument, agentMode: source },
    2,
    {
      operation: 'interactive prompt',
      remediation: headlessRemediation(argument),
      stderrExcerpt: headlessExcerpt(source),
    },
  )
}

/**
 * Run an `@inquirer/*` prompt with Esc bound to cancellation. On Esc the prompt rejects with an
 * `AbortPromptError`, which `entry/cli.ts` already catches at the top level -> "Operation
 * cancelled." -> exit 0.
 *
 * The listener attaches only on a real interactive terminal. `isTTY` alone is NOT a sufficient
 * guard — see lib/agent-mode for why `stdio: 'inherit'` defeats it.
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
export const withEscape = async <T>(
  run: (context: PromptContext) => Promise<T>,
  base?: EscapeOptions<T>,
): Promise<T> => {
  const controller = new AbortController()
  // `whenHeadless` is ours, not inquirer's — split it off so it never reaches a prompt's context.
  const { whenHeadless = 'refuse', ...promptBase } = base ?? {}
  const context: PromptContext = { ...promptBase, signal: controller.signal }

  // Keyed on `isHeadless()`. `!isTTY` deliberately does NOT ride along: a piped-but-human
  // run (`infra-kit worktrees add > log.txt`) has no TTY and still deserves its prompt, and the two
  // conditions were only ever collapsed here because both merely skipped the Esc listener. Now that
  // this branch decides an ANSWER rather than just a listener, conflating them would refuse prompts
  // no agent is waiting on. `release-picker.ts` keeps its own `!isTTY` clause for its own reason.
  //
  // `--json` joins because a prompt is stdout traffic on a stream a machine is parsing, and because
  // `release-picker`/`source-picker` already treat `--json` as never-prompt — this makes the 20 sites
  // agree with those two.
  if (isHeadless()) return resolveHeadless(whenHeadless)

  if (!process.stdin.isTTY) return run(context)

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
