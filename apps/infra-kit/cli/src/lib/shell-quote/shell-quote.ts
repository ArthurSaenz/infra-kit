/**
 * Render an argv array as a line a POSIX shell runs back verbatim.
 *
 * Every surface that PRINTS a command for a human to paste has the same obligation, and `join(' ')` does
 * not meet it. The load-bearing case is `lib/dependency-install`'s refusals: a recipe we decline to run
 * is printed precisely so the human can run it, and joining
 * `['/bin/bash', '-c', 'curl -fsSL … | bash']` on spaces yields
 * `/bin/bash -c curl -fsSL … | bash` — which loses the argument boundary and runs `curl` with `-fsSL`
 * as `$0`, no URL, and the rest piped into a second shell. It fails, and it fails in a way that reads
 * like the tool's fault rather than the transcription's.
 *
 * The implementation began inside `dev/proxy/portless-driver`, which needed it first and is still a
 * caller; a second copy beside the recipes would drift from it.
 */

/**
 * Characters that survive a POSIX shell unquoted. Anything outside this set — a space, a pipe, a paren,
 * all of which appear in real recipes and real install paths — gets single-quoted.
 */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/

/** A literal `'` inside single quotes: close, emit an escaped quote, reopen — the only way a shell allows it. */
const SINGLE_QUOTE_ESCAPE = "'\\''"

/** Single-quote `value` for a POSIX shell unless it is already inert. */
export const shellQuote = (value: string): string => {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", SINGLE_QUOTE_ESCAPE)}'`
}

/** One pasteable shell line from an argv array, each word quoted only when it needs to be. */
export const shellLine = (argv: readonly string[]): string => {
  return argv.map(shellQuote).join(' ')
}
