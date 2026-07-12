/**
 * The shared "equivalent line" shape — the replayable, non-interactive invocation
 * a session prints so the user can rerun the same selection without prompts. Kept
 * command-agnostic (dev, vendor, audit … all emit one) and structural so it never
 * has to import a specific command's wizard types. Pure data + a tiny constructor.
 */

/** One replayable invocation line, plus whether it reproduces the selection exactly. */
export interface EquivalentLine {
  /** The full replayable invocation, e.g. "infra-kit vendor check". */
  line: string
  /** True when the line reproduces the selection exactly (false ⇒ it would re-prompt). */
  reproducible: boolean
}

/**
 * Construct an {@link EquivalentLine}. Defaults to `reproducible: true` for the
 * common case where the printed line replays the selection verbatim.
 *
 * @example
 * equivalentLine('infra-kit vendor check')        // => { line: 'infra-kit vendor check', reproducible: true }
 * equivalentLine('infra-kit dev --app=client', false) // => { line: '…', reproducible: false }
 */
export const equivalentLine = (line: string, reproducible = true): EquivalentLine => {
  return { line, reproducible }
}
