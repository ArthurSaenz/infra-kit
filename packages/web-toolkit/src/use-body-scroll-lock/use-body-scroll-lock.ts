import {
  disablePageScroll as _disablePageScroll,
  enablePageScroll as _enablePageScroll,
  markScrollable,
  unmarkScrollable,
} from '@fluejs/noscroll'
import { useEffect } from 'react'

const SCROLLABLE_SELECTOR = '[data-noscroll-scrollable]'

const markScrollableElements = () => {
  document.querySelectorAll<HTMLElement>(SCROLLABLE_SELECTOR).forEach((el) => {
    markScrollable(el)
  })
}

const unmarkScrollableElements = () => {
  document.querySelectorAll<HTMLElement>(SCROLLABLE_SELECTOR).forEach((el) => {
    unmarkScrollable(el)
  })
}

export const disablePageScroll = () => {
  markScrollableElements()
  _disablePageScroll()
}

export const enablePageScroll = () => {
  unmarkScrollableElements()
  _enablePageScroll()
}

interface Options {
  locked?: boolean
}

export const useBodyScrollLock = (
  scrollLockTarget: React.RefObject<HTMLElement | null>,
  options: Options = {},
): void => {
  useEffect(() => {
    if (!scrollLockTarget.current) {
      return (): void => {
        return undefined
      }
    }

    const { locked } = options
    const element = scrollLockTarget.current

    if (typeof locked === 'undefined' || locked) {
      markScrollable(element)
      disablePageScroll()
    } else if (!locked) {
      unmarkScrollable(element)
      enablePageScroll()
    }

    return (): void => {
      unmarkScrollable(element)
      enablePageScroll()
    }
  }, [scrollLockTarget.current, options])
}
