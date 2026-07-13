import { Box, Static, Text } from 'ink'
import { useEffect, useState } from 'react'

/**
 * The Ink boot region for `infra-kit dev`: an animated spinner + phase line while the server boots,
 * then the ready header committed to scrollback via `<Static>`.
 *
 * HARD INVARIANT — this component (and every boot component under `src/tui/dev-ui/`) is OUTPUT-ONLY.
 * It MUST NEVER call `useInput`. `useInput` arms Ink's raw mode + Ctrl-C interception, which would
 * steal SIGINT from the process signal handler that owns dev-server shutdown. The spinner animates via
 * a self-contained interval only; there is no keyboard input during boot. Do not add `useInput` here.
 */

export interface BootRegionProps {
  /** Current boot phase, shown beside the spinner. */
  phase: string
  /** Latest narration detail (dim subtitle under the spinner); empty hides the line. */
  narration: string
  /**
   * When set, boot is done: the pre-formatted ready-header lines are committed to scrollback via
   * `<Static>` and the transient spinner region is gone. The renderer unmounts right after.
   */
  readyLines?: string[]
}

/** Animated boot spinner + phase/narration, or the committed ready header once `readyLines` is set. */
export const BootRegion = (props: BootRegionProps) => {
  const { phase, narration, readyLines } = props

  const [frame, setFrame] = useState(0)

  useEffect(() => {
    // No spinner once the ready header is committed.
    if (readyLines) {
      return
    }

    const timer = setInterval(() => {
      setFrame((f) => {
        return f + 1
      })
    }, SPINNER_INTERVAL_MS)

    return () => {
      clearInterval(timer)
    }
  }, [readyLines])

  if (readyLines) {
    // `<Static>` writes each line once, above the (now empty) live region, so the header persists in
    // scrollback after unmount. Lines are pre-formatted by DevRenderer.formatReadyLines.
    return (
      <Static items={readyLines}>
        {(line, index) => {
          return <Text key={index}>{line}</Text>
        }}
      </Static>
    )
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
        <Text dimColor>{` ${phase}`}</Text>
      </Box>
      {narration ? <Text dimColor>{narration}</Text> : null}
    </Box>
  )
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80
