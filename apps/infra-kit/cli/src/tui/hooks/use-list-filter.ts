import type { Key } from 'ink'
import { useMemo, useState } from 'react'

interface ListFilter<T> {
  /** Items matching the current query (all items when the query is empty). */
  filtered: T[]
  /** Active row index, always clamped into `filtered`'s bounds. */
  activeIndex: number
  /** Current filter query. */
  query: string
  /**
   * Handle the shared navigation/filter keys (↑↓ wrap-around, backspace/delete,
   * printable chars). Returns true when the key was consumed so the caller can
   * `return` early; false leaves the key for the component's own handlers.
   */
  handleNavigation: (input: string, key: Key) => boolean
  /**
   * Stage 1 of the Esc ladder: clears a non-empty query (back to the first row) and
   * returns true. Returns false when the query is already empty — the boolean IS the
   * ladder, and a false tells the caller there is nothing left to cancel but the screen.
   *
   * Deliberately NOT folded into `handleNavigation`: the two pickers want different
   * stage-2 actions, so the escape branch belongs to each screen, not to the shared handler.
   */
  clearQuery: () => boolean
}

/**
 * Shared list-filter state for the branch pickers: substring filtering,
 * wrap-around ↑↓ movement, and query editing. Extracted so each `useInput`
 * handler stays under the sonarjs cognitive-complexity ≤15 gate.
 */
export const useListFilter = <T>(items: T[], toText: (item: T) => string): ListFilter<T> => {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    if (!q) {
      return items
    }

    return items.filter((item) => {
      return toText(item).toLowerCase().includes(q)
    })
  }, [items, query, toText])

  const activeIndex = Math.min(index, Math.max(0, filtered.length - 1))

  const handleNavigation = (input: string, key: Key): boolean => {
    const n = filtered.length

    if (key.upArrow) {
      // `+ n` sidesteps JS negative modulo (e.g. -1 % 5 === -1, not 4).
      if (n > 0) {
        setIndex((activeIndex - 1 + n) % n)
      }

      return true
    }

    if (key.downArrow) {
      if (n > 0) {
        setIndex((activeIndex + 1) % n)
      }

      return true
    }

    if (key.backspace || key.delete) {
      setQuery(query.slice(0, -1))
      setIndex(0)

      return true
    }

    // Printable character: append to the filter and reset to the first row.
    if (input && !key.ctrl && !key.meta) {
      setQuery(query + input)
      setIndex(0)

      return true
    }

    return false
  }

  const clearQuery = (): boolean => {
    if (!query) {
      return false
    }

    setQuery('')
    setIndex(0)

    return true
  }

  return { filtered, activeIndex, query, handleNavigation, clearQuery }
}
