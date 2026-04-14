import { useEffect, useRef } from 'react'

import { isSSR } from '../ssr'

/**
 * Custom hook that sets the document title.
 * @param {string} title - The title to set.
 * @param {boolean} prevailOnUnmount - Whether to keep the title after unmounting the component (enabled by default).
 *
 * @example
 * ```tsx
 * useDocumentTitle('My new title');
 * ```
 */
export function useDocumentTitle(title: string, prevailOnUnmount = false) {
  const defaultTitle = useRef(isSSR ? title : document.title)

  useEffect(() => {
    if (title) {
      document.title = title
    }
  }, [title])

  useEffect(() => {
    return () => {
      if (!prevailOnUnmount) {
        document.title = defaultTitle.current
      }
    }
  }, [])
}
