import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useState } from 'react'

import type { BranchPickerItem } from '../../lib/prompts/types'
import { useListFilter } from '../hooks/use-list-filter'
import { listLayout, paletteWindow } from './palette-window'

interface BranchMultiPickerProps {
  items: BranchPickerItem[]
  /** Called with the selected item values; the app then exits. */
  onSubmit: (values: string[]) => void
  /** Called when the user cancels (Esc / Ctrl-C); the app then exits. */
  onCancel: () => void
  /** When true (default), Enter with an empty selection is ignored. */
  required?: boolean
  /** When true (default), Ctrl-A toggles select-all across all items. */
  allowSelectAll?: boolean
}

/**
 * Searchable multi-select branch picker rendered with Ink. Same filter/move/cancel
 * behaviour as `BranchPicker`, plus a selection `Set` keyed by item *value* so the
 * selection survives filter changes. Space toggles the active row; Ctrl-A toggles
 * select-all across all items; Enter submits the selected values.
 *
 * The list is WINDOWED to the terminal height for the same safety reason as the
 * palette and the single picker: an overflowing Ink frame corrupts the cursor and
 * welds later output onto the transcript. See `palette-window.ts`.
 */
export const BranchMultiPicker = (props: BranchMultiPickerProps) => {
  const { items, onSubmit, onCancel, required = true, allowSelectAll = true } = props

  const T = BRANCH_MULTI_PICKER_TEXT
  const labelWidth = items.reduce((max, item) => {
    return Math.max(max, item.label.length)
  }, 0)

  const { exit } = useApp()
  const { rows } = useWindowSize()
  const { filtered, activeIndex, query, handleNavigation, clearQuery } = useListFilter(items, filterText)
  // Selection keyed by value so it persists across filter changes.
  const [selected, setSelected] = useState<Set<string>>(() => {
    return new Set()
  })
  const [showRequiredHint, setShowRequiredHint] = useState(false)
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

  // The extra chrome row is this screen's `select at least one` hint: counted unconditionally, because
  // it appears on a keystroke and a budget that shrinks mid-frame is a budget that overflows.
  const layout = listLayout(rows, 1)
  // No `groupOf`: a branch list has no headers, so every branch costs exactly one row.
  const view = paletteWindow(filtered, windowStart, activeIndex, rows, { chromeRows: layout.chromeRows })

  // Commit the scroll position once the frame that used it has rendered.
  useEffect(() => {
    if (view.start !== windowStart) {
      setWindowStart(view.start)
    }
  }, [view.start, windowStart])

  const toggleValue = (value: string) => {
    setSelected((prev) => {
      const next = new Set(prev)

      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }

      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected((prev) => {
      // Clear only when every item (all, not just filtered) is already selected.
      const allSelected = items.every((item) => {
        return prev.has(item.value)
      })

      if (allSelected) {
        return new Set()
      }

      return new Set(
        items.map((item) => {
          return item.value
        }),
      )
    })
  }

  const cancel = () => {
    onCancel()
    setSubmitted(true)
  }

  const submit = () => {
    if (required && selected.size === 0) {
      setShowRequiredHint(true)

      return
    }

    onSubmit([...selected])
    setSubmitted(true)
  }

  useInput((input, key) => {
    if (submitted) {
      return
    }

    if (key.ctrl && input === 'c') {
      cancel()

      return
    }

    // Esc pops the innermost stateful thing: the typed filter first, the picker only once
    // there is no filter left to clear. It never touches `selected` — a filter keystroke is
    // not a selection, so clearing one must not discard the other. Stage 2 discards it, as before.
    if (key.escape) {
      if (!clearQuery()) {
        cancel()
      }

      return
    }

    if (key.ctrl && input === 'a') {
      if (allowSelectAll) {
        toggleSelectAll()
      }

      return
    }

    if (input === ' ') {
      const active = filtered[activeIndex]

      if (active) {
        toggleValue(active.value)
      }

      return
    }

    if (key.return) {
      submit()

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
          const isChecked = selected.has(item.value)

          // `wrap="truncate"` keeps one branch = one row at any width. Ink reads the wrap style off the
          // OUTER <Text> only, so it must live here, not on the nested description.
          return (
            <Text color={isActive ? 'green' : undefined} key={item.value} wrap="truncate">
              {isActive ? '› ' : '  '}
              {isChecked ? '[x] ' : '[ ] '}
              {item.label.padEnd(labelWidth)} <Text dimColor>{item.description ?? ''}</Text>
            </Text>
          )
        })}
        {view.hiddenAfter > 0 ? <Text dimColor wrap="truncate">{`${T.more} ${view.hiddenAfter} below`}</Text> : null}
      </Box>
      {showRequiredHint ? (
        <Text dimColor wrap="truncate">
          {T.requiredHint}
        </Text>
      ) : null}
    </Box>
  )
}

function filterText(item: BranchPickerItem): string {
  return `${item.label} ${item.description ?? ''}`
}

/**
 * Static screen copy. Module-scoped and exported so the hint-width guard can measure it:
 * these strings render under `wrap="truncate"`, so a hint of ≥80 columns silently loses
 * its tail at the common terminal width — and the tail is where the Esc hint lives.
 */
export const BRANCH_MULTI_PICKER_TEXT = {
  hint: 'filter · ↑↓ move · Space toggle · Ctrl-A all · Enter submit · Esc clear/cancel',
  prompt: '❯ ',
  empty: 'No matching branches',
  tiny: 'terminal too short — resize to pick branches',
  requiredHint: 'select at least one',
  more: '…',
}
