import { useEffect, useRef } from 'react'

import { isSSR } from '../ssr'

/**
 * Custom hook that sets the document meta description.
 * @param {string} metaDescription - The meta description to set.
 * @param {boolean} prevailOnUnmount - Whether to keep the meta description after unmounting the component (enabled by default).
 *
 * @example
 * ```tsx
 * useDocumentTitle('My new title');
 * ```
 */
export function useDocumentMetaDescription(metaDescription: string, prevailOnUnmount = false) {
  const defaultTitle = useRef(
    isSSR ? metaDescription : document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
  )

  useEffect(() => {
    setMetaDescription(metaDescription)
  }, [metaDescription])

  useEffect(() => {
    return () => {
      if (!prevailOnUnmount) {
        setMetaDescription(defaultTitle.current || '')
      }
    }
  }, [])
}

const setMetaDescription = (metaDescription: string) => {
  const metaDescriptionElement = document.querySelector<HTMLMetaElement>('meta[name="description"]')

  if (metaDescriptionElement) {
    metaDescriptionElement.setAttribute('content', metaDescription)
  }
}
