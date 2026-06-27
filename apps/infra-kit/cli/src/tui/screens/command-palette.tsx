import { Box, Text, useApp, useInput } from 'ink'
import { useMemo, useState } from 'react'

import type { PaletteItem } from '../types'

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
  }
  const nameWidth = 24

  const { exit } = useApp()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

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

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      exit()

      return
    }

    if (key.return) {
      const selected = filtered[activeIndex]

      if (selected) {
        onSelect(selected.name)
        exit()
      }

      return
    }

    if (key.upArrow) {
      setIndex(Math.max(0, activeIndex - 1))

      return
    }

    if (key.downArrow) {
      setIndex(Math.min(filtered.length - 1, activeIndex + 1))

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

  let lastGroup = ''

  return (
    <Box flexDirection="column">
      <Text dimColor>{T.hint}</Text>
      <Box>
        <Text color="cyan">{T.prompt}</Text>
        <Text>{query}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text dimColor>{T.empty}</Text>
        ) : (
          filtered.map((item, position) => {
            const isActive = position === activeIndex
            const showGroup = item.group !== lastGroup

            lastGroup = item.group

            return (
              <Box flexDirection="column" key={item.name}>
                {showGroup ? <Text color="yellow">{`— ${item.group} —`}</Text> : null}
                <Text color={isActive ? 'green' : undefined}>
                  {isActive ? '› ' : '  '}
                  {item.name.padEnd(nameWidth)} <Text dimColor>{item.description}</Text>
                </Text>
              </Box>
            )
          })
        )}
      </Box>
    </Box>
  )
}
