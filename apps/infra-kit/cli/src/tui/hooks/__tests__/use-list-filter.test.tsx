import { Text, useInput } from 'ink'
import { render } from 'ink-testing-library'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { useListFilter } from '../use-list-filter'

const items = ['alpha', 'beta', 'gamma']

const identity = (item: string) => {
  return item
}

const settle = () => {
  return new Promise((resolve) => {
    setTimeout(resolve, 50)
  })
}

/**
 * `useListFilter` is a hook and this package ships no react-hooks renderer — only
 * ink-testing-library. So drive it through a probe screen: `!` invokes `clearQuery()`
 * and the frame reports the query, the active index, and what the call returned, which
 * is the hook's whole Esc-ladder contract. `!` is intercepted before `handleNavigation`,
 * so it never lands in the query itself.
 */
const Probe = () => {
  const { query, activeIndex, handleNavigation, clearQuery } = useListFilter(items, identity)
  const [cleared, setCleared] = useState('none')

  useInput((input, key) => {
    if (input === '!') {
      setCleared(String(clearQuery()))

      return
    }

    handleNavigation(input, key)
  })

  return <Text>{`query=[${query}] index=${activeIndex} cleared=${cleared}`}</Text>
}

describe('useListFilter', () => {
  it('clearQuery returns true and clears a non-empty query, resetting to the first row', async () => {
    const { lastFrame, stdin } = render(<Probe />)

    stdin.write('a')
    await settle()
    stdin.write('\x1B[B') // arrow down: index moves off the first row
    await settle()

    expect(lastFrame() ?? '').toContain('query=[a] index=1')

    stdin.write('!')
    await settle()

    expect(lastFrame() ?? '').toContain('query=[] index=0 cleared=true')
  })

  it('clearQuery returns false and is a no-op on an already-empty query', async () => {
    const { lastFrame, stdin } = render(<Probe />)

    // Move off the first row WITHOUT typing a filter. A false return must leave the hook
    // untouched — including the index, which the clearing path would have reset to 0.
    stdin.write('\x1B[B')
    await settle()

    expect(lastFrame() ?? '').toContain('query=[] index=1')

    stdin.write('!')
    await settle()

    expect(lastFrame() ?? '').toContain('query=[] index=1 cleared=false')
  })
})
