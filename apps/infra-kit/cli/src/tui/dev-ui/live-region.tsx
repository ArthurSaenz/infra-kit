import { Box, Static, Text } from 'ink'

/**
 * The persistent Ink live region for `infra-kit dev` (backend-only sessions): the committed header +
 * growing log scrollback above, and a live health footer re-rendered in place below.
 *
 * HARD INVARIANT — this component (and every component under `src/tui/dev-ui/`) is OUTPUT-ONLY. It
 * MUST NEVER call `useInput`. `useInput` arms Ink's raw mode + Ctrl-C interception, which would steal
 * SIGINT from the process signal handler that owns dev-server shutdown. There is no keyboard input in
 * the live region — it is props only, with no state, no effects, no input. Do not add `useInput` here.
 */

export interface LiveRegionProps {
  /** Reference header, committed once to scrollback via `<Static>` (from `formatHeaderLines`). */
  headerLines: string[]
  /** Log lines committed above the footer as they arrive (also via the SAME `<Static>`). */
  logLines: string[]
  /** Live footer, re-rendered in place on every health change (from `formatFooterLines`). */
  footerLines: string[]
  /**
   * Cap on rendered footer rows so a many-backend session never eats a short viewport (the footer is a
   * live region — it cannot scroll). Overflow collapses into a trailing dim `… +N more` line. Omit for
   * no cap. The pinned footer must stay short; the full health picture is always in the log file.
   */
  maxFooterLines?: number
}

/**
 * A SINGLE `<Static>` streams the header then the growing logs (Ink writes only newly-appended items
 * each commit, so the header lands first and logs accrete beneath it — one block, never two). The
 * footer is an ordinary `<Box>`, so it repaints in place on each rerender without touching scrollback.
 */
export const LiveRegion = (props: LiveRegionProps) => {
  const { headerLines, logLines, footerLines } = props

  const staticItems = [...headerLines, ...logLines]
  const footer = clampFooter(footerLines, props.maxFooterLines)

  return (
    <>
      <Static items={staticItems}>
        {(line, index) => {
          return <Text key={index}>{line}</Text>
        }}
      </Static>
      <Box flexDirection="column">
        {footer.map((line, index) => {
          return <Text key={index}>{line}</Text>
        })}
      </Box>
    </>
  )
}

/** Cap the footer to `max` rows, collapsing the overflow into one trailing `  … +N more` line. */
export const clampFooter = (lines: string[], max?: number): string[] => {
  if (max == null || max < 1 || lines.length <= max) {
    return lines
  }

  const shown = lines.slice(0, max - 1)

  return [...shown, `  … +${lines.length - shown.length} more`]
}
