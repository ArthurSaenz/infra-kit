import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'

/**
 * The Ink boot region for `infra-kit dev`: an animated spinner + phase line while the server boots.
 *
 * The ready header is NOT painted here. `PersistentInkDevUi.ready()` commits it through the persistent
 * panel instead, so this component only ever renders the transient spinner.
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
}

/** Animated boot spinner with a phase line and an optional narration subtitle. */
export const BootRegion = (props: BootRegionProps) => {
  const { phase, narration } = props

  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => {
        return f + 1
      })
    }, SPINNER_INTERVAL_MS)

    return () => {
      clearInterval(timer)
    }
  }, [])

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
