import { useEffect } from 'react'

/**
 * Calls a callback when a click occurs outside the given element.
 *
 * @example
 *     const ref = useRef<HTMLElement>(null)
 *     useOutsideClick(ref, () => { setOpen(false) })
 *
 */
export const useOutsideClick = (ref: React.RefObject<HTMLElement>, callback: () => void) => {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Element)) {
        callback()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [ref, callback])
}
