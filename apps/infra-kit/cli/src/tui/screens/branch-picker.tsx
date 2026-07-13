import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useState } from 'react'

import type { BranchPickerItem } from '../../lib/prompts/types'
import { useListFilter } from '../hooks/use-list-filter'
import { listLayout, paletteWindow } from './palette-window'

interface BranchPickerProps {
  items: BranchPickerItem[]
  /** Called with the chosen item's value; the app then exits. */
  onSelect: (value: string) => void
  /** Called when the user cancels (Esc / Ctrl-C); the app then exits. */
  onCancel: () => void
}

/**
 * Searchable single-select branch picker rendered with Ink. Mirrors
 * `CommandPalette` minus the group headers: type-to-filter over label +
 * description, ↑↓ wrap-around, Enter selects the active item's *value*.
 *
 * Like the palette, the list is WINDOWED to the terminal height. That is a safety
 * requirement, not a nicety: a repo with ~20 open releases produced a frame taller
 * than an 80x24 window, and an overflowing Ink frame corrupts the cursor and welds
 * the next frame onto the command's own output. See `palette-window.ts`.
 */
export const BranchPicker = (props: BranchPickerProps) => {
  const { items, onSelect, onCancel } = props

  const T = {
    hint: 'Select a branch — type to filter, ↑↓ to move, Enter to select, Esc to cancel',
    prompt: '❯ ',
    empty: 'No matching branches',
    tiny: 'terminal too short — resize to pick a branch',
    more: '…',
  }
  const labelWidth = items.reduce((max, item) => {
    return Math.max(max, item.label.length)
  }, 0)

  const { exit } = useApp()
  const { rows } = useWindowSize()
  const { filtered, activeIndex, query, handleNavigation } = useListFilter(items, filterText)
  // First branch in the visible window; kept in state so the list scrolls by the minimum needed.
  const [windowStart, setWindowStart] = useState(0)
  // When set, the component renders `null` for one frame so Ink erases the list
  // before unmount commits its final frame.
  const [submitted, setSubmitted] = useState(false)

  // Exit only after the empty frame has committed, so the list is wiped first.
  useEffect(() => {
    if (submitted) {
      exit()
    }
  }, [submitted, exit])

  const layout = listLayout(rows)
  // No `groupOf`: a branch list has no headers, so every branch costs exactly one row.
  const view = paletteWindow(filtered, windowStart, activeIndex, rows, { chromeRows: layout.chromeRows })

  // Commit the scroll position once the frame that used it has rendered.
  useEffect(() => {
    if (view.start !== windowStart) {
      setWindowStart(view.start)
    }
  }, [view.start, windowStart])

  useInput((input, key) => {
    if (submitted) {
      return
    }

    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      setSubmitted(true)

      return
    }

    if (key.return) {
      const selected = filtered[activeIndex]

      if (selected) {
        onSelect(selected.value)
        setSubmitted(true)
      }

      return
    }

    handleNavigation(input, key)
  })

  // Final frame: render nothing so Ink erases the list on its way out.
  if (submitted) {
    return null
  }

  // Too short for even one branch row plus a prompt. One truncated line always fits.
  if (layout.mode === 'tiny') {
    return (
      <Text dimColor wrap="truncate">
        {T.tiny}
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      {layout.mode === 'full' ? (
        <Text dimColor wrap="truncate">
          {T.hint}
        </Text>
      ) : null}
      <Box>
        <Text color="cyan">{T.prompt}</Text>
        {/* truncate-START: overflow must eat the head of the filter, never the character being typed. */}
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

          // `wrap="truncate"` keeps one branch = one row at any width (a long branch name would
          // otherwise wrap and make the frame taller than this component believes). Ink reads the wrap
          // style off the OUTER <Text> only, so it must live here, not on the nested description.
          return (
            <Text color={labelColor(item.type, isActive)} key={item.value} wrap="truncate">
              {isActive ? '› ' : '  '}
              {item.label.padEnd(labelWidth)} <Text dimColor>{item.description ?? ''}</Text>
            </Text>
          )
        })}
        {view.hiddenAfter > 0 ? <Text dimColor wrap="truncate">{`${T.more} ${view.hiddenAfter} below`}</Text> : null}
      </Box>
    </Box>
  )
}

/**
 * Colour for a row's label, derived from the release type. Kept a plain lookup so
 * an unknown/absent type simply falls through to the default (green when active).
 */
function labelColor(type: string | undefined, isActive: boolean): string | undefined {
  if (type === 'hotfix') {
    return 'red'
  }

  return isActive ? 'green' : undefined
}

function filterText(item: BranchPickerItem): string {
  return `${item.label} ${item.description ?? ''}`
}
