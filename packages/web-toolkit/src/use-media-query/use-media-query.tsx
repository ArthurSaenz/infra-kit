import { useEffect, useState } from 'react'

import { isSSR } from '../ssr'

export const useMediaQuery = (query: string) => {
  const [matches, setMatches] = useState(isSSR ? false : window.matchMedia(query).matches)

  useEffect(() => {
    const matchQueryList = window.matchMedia(query)

    const handleChange = (e: MediaQueryListEvent) => {
      setMatches(e.matches)
    }

    setMatches(matchQueryList.matches)

    // INFO: bugfix ios v13
    matchQueryList.addEventListener?.('change', handleChange)

    return () => {
      matchQueryList.removeEventListener?.('change', handleChange)
    }
  }, [query])

  return matches
}
