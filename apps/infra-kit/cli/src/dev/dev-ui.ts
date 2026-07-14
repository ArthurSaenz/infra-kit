/**
 * The terminal-UI contract for `infra-kit dev`. Both the plain-print {@link DevRenderer} (non-TTY,
 * `--json`, MCP) and the persistent Ink status panel (`PersistentInkDevUi`, under `src/tui/dev-ui/`)
 * implement it, so the runner drives either through the same seams and never learns which is live.
 *
 * The seams mirror {@link DevRenderer} exactly, plus one extra: `dispose()`. Ink needs it to unmount
 * and release the terminal; the plain renderer implements it as an idempotent no-op.
 */
import type { LogLevel, ReadySummary } from './render.js'

export type { EndpointRow, LogLevel, ReadySummary, UiRef } from './render.js'

/** A renderer the {@link DevServerRunner} can drive: the calm-print {@link DevRenderer} or the Ink boot UI. */
export interface DevUi {
  /** Boot narration: file-tee always; terminal only when the renderer's own policy allows (verbose / live region). */
  narrate: (message: string) => void
  /** A general message routed by level (terminal + file tee). */
  log: (message: string, level?: LogLevel) => void
  /** `LogFn`-shaped adapter for the build runner seam (which passes `(msg, level)`). */
  readonly logFn: (message: string, level?: LogLevel) => void
  /** Advance the boot phase (drives a spinner / live region). */
  bootStep: (phase: string) => void
  /** Stop + clear any live boot spinner (idempotent). */
  stopSpinner: () => void
  /** Paint the final ready header in one shot (health pre-probed by the caller). */
  ready: (summary: ReadySummary) => void
  /** One tagged, timestamped tail line, strictly after {@link ready}. */
  event: (input: { tag: string; text: string }) => void
  /**
   * Repaint the persistent live footer (health dots, watch) in place from a fresh {@link ReadySummary},
   * WITHOUT reprinting the committed `<Static>` header. Optional: only the persistent Ink UI implements
   * it; the plain renderer and the boot Ink UI omit it (they have no live footer to refresh), so callers
   * invoke it as `renderer.refresh?.(summary)`.
   */
  refresh?: (summary: ReadySummary) => void
  /**
   * Release the terminal: unmount Ink, erase any transient region, and restore the cursor. Idempotent
   * and safe if never mounted or already unmounted at {@link ready}. A no-op for the plain renderer.
   */
  dispose: () => void
}
