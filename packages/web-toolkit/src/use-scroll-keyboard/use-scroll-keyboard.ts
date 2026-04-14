import throttle from 'lodash/throttle'
import type { RefObject } from 'react'
import { useEffect } from 'react'

interface UseStickyProps {
  scrollRef?: RefObject<HTMLDivElement>
}

/**
 * This is a custom hook for sticky component.
 *
 * @example
 *     useScrollKeyboard({ scrollRef: scrollRef })
 *
 */
export const useScrollKeyboard = ({ scrollRef }: UseStickyProps) => {
  useEffect(() => {
    if (scrollRef?.current) {
      const inputElement = document.querySelector<HTMLInputElement>('[data-mobile-input="true"]')

      const handleScroll = () => {
        requestAnimationFrame(() => {
          if (document.activeElement === inputElement) {
            inputElement?.blur()
          }
        })
      }

      const throttledFn = throttle(handleScroll, 50)

      scrollRef.current.addEventListener('scroll', throttledFn)

      return () => {
        if (scrollRef.current) {
          scrollRef.current.removeEventListener('scroll', throttledFn)
        }
      }
    }
  }, [])
}
