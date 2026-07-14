import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useMemo, useState } from 'react'

import type { PaletteItem } from '../types'
import { listLayout, paletteWindow } from './palette-window'

interface CommandPaletteProps {
  items: PaletteItem[]
  /** Called with the chosen command name; the app then exits. */
  onSelect: (name: string) => void
  /** Called when the user cancels (Esc / Ctrl-C); the app then exits. */
  onCancel: () => void
  /**
   * Stop the foreground job (Ctrl-Z). ABSENT means suspend is impossible on this platform — the
   * palette stays pure presentation and never inspects `process`; boot.tsx is the platform authority.
   */
  onSuspend?: () => void
}

/**
 * Fuzzy-ish command picker rendered with Ink. Pure presentation: it receives a
 * flat list of commands (already grouped/ordered by the catalog) and returns the
 * selected name. It never executes anything — the caller runs the command via
 * the existing Commander path.
 *
 * NOTE: this component sits at exactly the sonarjs cognitive-complexity ceiling (15). Any `if` or
 * `?:` added to its BODY breaks `pnpm run qa` — which is why the hint is picked by the module-scope
 * `hintFor` below and the control keys by `handleCtrlKey`, rather than inline.
 */
export const CommandPalette = (props: CommandPaletteProps) => {
  const { items, onSelect, onCancel, onSuspend } = props

  const T = {
    hint: hintFor(Boolean(onSuspend)),
    prompt: '❯ ',
    empty: 'No matching commands',
    tiny: 'terminal too short — resize to pick a command',
    more: '…',
  }
  const nameWidth = 24

  const { exit, suspendTerminal } = useApp()
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

  // The slice that fits this terminal, and how much chrome we may spend around it. A frame taller than
  // the viewport corrupts the cursor (see palette-window.ts) — every row here is budgeted, and every
  // row below is `wrap="truncate"` so one command is always exactly one row.
  const layout = listLayout(rows)
  const view = paletteWindow(filtered, windowStart, activeIndex, rows, {
    chromeRows: layout.chromeRows,
    // A compact frame drops group headers, so they must not be budgeted for either.
    groupOf: layout.groups
      ? (item) => {
          return item.group
        }
      : undefined,
  })

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

  // Hand the terminal back to the user's shell until they `fg`.
  //
  // Ink does all the terminal work for us, in the right order and synchronously: `beginSuspend`
  // settles pending frames, erases the list, restores the cursor and drops raw mode BEFORE our
  // callback runs, and on resume `endSuspend` re-arms raw mode and force-redraws THIS SAME LIVE
  // COMPONENT — so the typed filter survives the suspend. That is why we must NOT set `submitted`
  // here: unmounting would throw the query away and give us a blank palette on return.
  //
  // The `.catch` is the PRIMARY guard, not a backstop — never simplify it to `void`. Two 0x1a bytes
  // in one read chunk (a double-tap) are both already queued in Ink's input loop, and `pauseInput`
  // only detaches the stdin listener, so the second one still fires — into a `beginSuspend` that is
  // already suspended, which throws. Harmless (it throws before flipping its own state, and the first
  // suspension still unwinds), but the rejection must be caught: `void` would make it an unhandled
  // rejection that kills the process mid terminal-restore.
  const suspend = () => {
    if (!onSuspend) {
      return
    }

    suspendTerminal(onSuspend).catch(() => {
      // See above: a double Ctrl-Z is a no-op, not a crash.
    })
  }

  /**
   * Ctrl-C / Ctrl-Z, hoisted OUT of the `useInput` body. Mandatory, not tidiness: that handler sits at
   * cognitive complexity 14, and an inline `if (key.ctrl && input === 'z' && onSuspend)` costs +2 —
   * 16, over the sonarjs ceiling of 15, and `pnpm run qa` goes red.
   *
   * The palette's Ctrl-Z is a BYTE (0x1a), not a signal: Ink holds stdin in raw mode, which clears
   * termios ISIG, so the tty never generates SIGTSTP here at all. We therefore stop the process GROUP
   * ourselves (kill(0), see ../suspend.ts). The session shell's SIGTSTP handler does the opposite —
   * it self-stops with raise('SIGSTOP') (lib/session/run-session.ts) — and that is CORRECT there,
   * because while a child command holds the foreground the tty is cooked and has already TSTP'd the
   * whole group, leaving only us to follow. DO NOT UNIFY THE TWO.
   */
  const handleCtrlKey = (input: string): boolean => {
    if (input === 'c') {
      quit()

      return true
    }

    if (input === 'z') {
      suspend()

      return true
    }

    return false
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

    // Ctrl-C quits, Ctrl-Z suspends (see handleCtrlKey). Esc clears a non-empty filter first, and
    // only quits on an empty filter — the standard REPL/palette split, so the session shell keeps
    // running while the user narrows.
    if (key.ctrl && handleCtrlKey(input)) {
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

  // Too short for even one command row plus a prompt. One truncated line always fits.
  if (layout.mode === 'tiny') {
    return (
      <Text dimColor wrap="truncate">
        {T.tiny}
      </Text>
    )
  }

  let lastGroup = ''

  return (
    <Box flexDirection="column">
      {layout.mode === 'full' ? (
        <Text dimColor wrap="truncate">
          {T.hint}
        </Text>
      ) : null}
      <Box>
        <Text color="cyan">{T.prompt}</Text>
        {/* truncate-START on the input: overflow must eat the head of the filter, never the character
            being typed. */}
        <Text wrap="truncate-start">{query}</Text>
      </Box>
      <Box flexDirection="column" marginTop={layout.mode === 'full' ? 1 : 0}>
        {filtered.length === 0 ? (
          <Text dimColor wrap="truncate">
            {T.empty}
          </Text>
        ) : null}
        {view.hiddenBefore > 0 ? <Text dimColor wrap="truncate">{`${T.more} ${view.hiddenBefore} above`}</Text> : null}
        {view.visible.map((item, position) => {
          const isActive = view.start + position === activeIndex
          const showGroup = layout.groups && item.group !== lastGroup

          lastGroup = item.group

          return (
            <Box flexDirection="column" key={item.name}>
              {/* Blank line between groups (not before the first row of the window). */}
              {showGroup && position > 0 ? <Text> </Text> : null}
              {showGroup ? <Text color="yellow" wrap="truncate">{`— ${item.group} —`}</Text> : null}
              {/* `wrap="truncate"` is load-bearing, not cosmetic: it is what makes "one command = one
                  row" true at any width, which is what keeps the frame shorter than the viewport. Ink
                  reads the wrap style off the OUTER <Text> only — it squashes the nested <Text> into
                  this one's string — so it must live here. */}
              <Text color={isActive ? 'green' : undefined} wrap="truncate">
                {isActive ? '› ' : '  '}
                {item.name.padEnd(nameWidth)} <Text dimColor>{item.description}</Text>
              </Text>
            </Box>
          )
        })}
        {view.hiddenAfter > 0 ? <Text dimColor wrap="truncate">{`${T.more} ${view.hiddenAfter} below`}</Text> : null}
      </Box>
    </Box>
  )
}

/** Footer copy. Kept out of the component's `T` because picking between the two is a conditional. */
const HINTS = {
  suspend: 'type to filter · ↑↓ move · Enter run · Ctrl-Z suspend · Esc cancel',
  plain: 'type to filter · ↑↓ move · Enter run · Esc cancel',
}

/**
 * The footer hint, which advertises Ctrl-Z only where suspending is possible.
 *
 * Module scope for two reasons, both load-bearing. It cannot live in the component: a `?:` in
 * `CommandPalette`'s body pushes it from 15 to 16, over the sonarjs cognitive-complexity ceiling. And
 * it cannot sit above the component either: `@wl/component-file-order` pins this file to
 * imports → props interface → component with nothing in between. Below is the only legal home.
 *
 * Both strings are SHORTER than the hint they replace, on purpose — the footer renders with
 * `wrap="truncate"`, so anything longer silently loses its tail on a narrow terminal, and the tail is
 * exactly where a newly-added key would land.
 *
 * @example
 * hintFor(true).includes('Ctrl-Z') // => true
 */
const hintFor = (canSuspend: boolean): string => {
  return canSuspend ? HINTS.suspend : HINTS.plain
}
