import throttle from 'lodash/throttle'
import { useEffect, useRef, useState } from 'react'

interface UseStickyProps {
  defaultSticky?: boolean
  headerStickyHeightPx?: number
}

/**
 * This is a custom hook for sticky component.
 *
 * @example
 *     const [ref, isSticky, isScrolledTop] = useSticky({ defaultSticky: false })
 *
 */
export const useSticky = (props: UseStickyProps): [React.RefObject<HTMLDivElement | null>, boolean, boolean] => {
  const { defaultSticky, headerStickyHeightPx = 50 } = props

  const [isSticky, setIsSticky] = useState(defaultSticky || false)
  const [isScrolledTop, setScrolledTop] = useState(false)

  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handleScroll = () => {
      if (ref.current) {
        const st = window.scrollY

        setScrolledTop(st > headerStickyHeightPx)

        const isShowSticky = st > ref.current.getBoundingClientRect().height + ref.current.getBoundingClientRect().top

        setIsSticky(isShowSticky)
      }
    }

    const throttledFn = throttle(handleScroll, 100)

    window.addEventListener('scroll', throttledFn)

    return () => {
      window.removeEventListener('scroll', throttledFn)
    }
  }, [])

  return [ref, isSticky, isScrolledTop] as const
}
