import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useMemo, useState } from 'react'

import type { PaletteItem } from '../types'
import { paletteWindow } from './palette-window'

interface CommandPaletteProps {
  items: PaletteItem[]
  /** Called with the chosen command name; the app then exits. */
  onSelect: (name: string) => void
  /** Called when the user cancels (Esc / Ctrl-C); the app then exits. */
  onCancel: () => void
}

/**
 * Fuzzy-ish command picker rendered with Ink. Pure presentation: it receives a
 * flat list of commands (already grouped/ordered by the catalog) and returns the
 * selected name. It never executes anything — the caller runs the command via
 * the existing Commander path.
 */
export const CommandPalette = (props: CommandPaletteProps) => {
  const { items, onSelect, onCancel } = props

  const T = {
    hint: 'Select a command — type to filter, ↑↓ to move, Enter to run, Esc to cancel',
    prompt: '❯ ',
    empty: 'No matching commands',
    more: '…',
  }
  const nameWidth = 24

  const { exit } = useApp()
  const { rows } = useWindowSize()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  // First command in the visible window. Kept in state so the list scrolls by the minimum needed
  // instead of jumping every time the cursor moves.
  const [windowStart, setWindowStart] = useState(0)
  // When set, the component renders `null` for one frame so Ink erases the list
  // before unmount commits its final frame (Ink's `log.done()` would otherwise
  // freeze the last drawn frame — the command list — into the scrollback).
  const [submitted, setSubmitted] = useState(false)

  // Exit only after the empty frame has committed, so the list is wiped first.
  useEffect(() => {
    if (submitted) {
      exit()
    }
  }, [submitted, exit])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    if (!q) {
      return items
    }

    return items.filter((item) => {
      return `${item.name} ${item.description}`.toLowerCase().includes(q)
    })
  }, [items, query])

  const activeIndex = Math.min(index, Math.max(0, filtered.length - 1))

  // The slice that fits this terminal. A 25-command list is 33 rows: taller than an 80x24 window or
  // any split pane, which would make the frame unreadable (and make Ink clear the screen on every
  // keystroke). `safe-stderr` is what makes an overflowing frame harmless; this is what avoids one.
  const view = paletteWindow(filtered, windowStart, activeIndex, rows)

  // Commit the scroll position once the frame that used it has rendered.
  useEffect(() => {
    if (view.start !== windowStart) {
      setWindowStart(view.start)
    }
  }, [view.start, windowStart])

  // Back out with nothing picked (Ctrl-C, or Esc on an empty filter).
  const quit = () => {
    onCancel()
    setSubmitted(true)
  }

  // Move the active row by `delta`, wrapping. The `+ n` sidesteps JS negative modulo
  // (e.g. -1 % 5 === -1, not 4). No-op on an empty list.
  const step = (delta: number) => {
    const n = filtered.length

    if (n > 0) {
      setIndex((activeIndex + delta + n) % n)
    }
  }

  useInput((input, key) => {
    if (submitted) {
      return
    }

    // Ctrl-C always quits; Esc clears a non-empty filter first, and only quits on an empty filter —
    // the standard REPL/palette split, so the session shell keeps running while the user narrows.
    if (key.ctrl && input === 'c') {
      quit()

      return
    }

    if (key.escape && query) {
      setQuery('')
      setIndex(0)

      return
    }

    if (key.escape) {
      quit()

      return
    }

    if (key.return) {
      const selected = filtered[activeIndex]

      if (selected) {
        onSelect(selected.name)
        setSubmitted(true)
      }

      return
    }

    if (key.upArrow) {
      step(-1)

      return
    }

    if (key.downArrow) {
      step(1)

      return
    }

    if (key.backspace || key.delete) {
      setQuery(query.slice(0, -1))
      setIndex(0)

      return
    }

    // Printable character: append to the filter.
    if (input && !key.ctrl && !key.meta) {
      setQuery(query + input)
      setIndex(0)
    }
  })

  // Final frame: render nothing so Ink erases the list on its way out.
  if (submitted) {
    return null
  }

  let lastGroup = ''

  return (
    <Box flexDirection="column">
      <Text dimColor>{T.hint}</Text>
      <Box>
        <Text color="cyan">{T.prompt}</Text>
        <Text>{query}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? <Text dimColor>{T.empty}</Text> : null}
        {view.hiddenBefore > 0 ? <Text dimColor>{`${T.more} ${view.hiddenBefore} above`}</Text> : null}
        {view.visible.map((item, position) => {
          const isActive = view.start + position === activeIndex
          const showGroup = item.group !== lastGroup

          lastGroup = item.group

          return (
            <Box flexDirection="column" key={item.name}>
              {/* Blank line between groups (not before the first row of the window). */}
              {showGroup && position > 0 ? <Text> </Text> : null}
              {showGroup ? <Text color="yellow">{`— ${item.group} —`}</Text> : null}
              <Text color={isActive ? 'green' : undefined}>
                {isActive ? '› ' : '  '}
                {item.name.padEnd(nameWidth)} <Text dimColor>{item.description}</Text>
              </Text>
            </Box>
          )
        })}
        {view.hiddenAfter > 0 ? <Text dimColor>{`${T.more} ${view.hiddenAfter} below`}</Text> : null}
      </Box>
    </Box>
  )
}
