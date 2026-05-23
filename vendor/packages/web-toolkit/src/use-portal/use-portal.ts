import { useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'

const isServer = typeof window === 'undefined'
const isBrowser = !isServer

export const usePortal = (id: string) => {
  const portalRef = useRef(getPortalNode(id))

  const Portal = useCallback(({ children }: { children: React.ReactNode }): React.ReactPortal | null => {
    if (portalRef.current) return createPortal(children, portalRef.current)

    return null
  }, [])

  return Object.assign([Portal, portalRef], {
    Portal,
    portalRef,
  })
}

const getPortalNode = (id: string): Element | null => {
  if (isBrowser) {
    let node = document.querySelector(`#${id}`)

    if (!node) {
      const element = document.createElement('div')

      element.setAttribute('id', id)
      document.body.appendChild(element)

      node = document.querySelector(`#${id}`)
    }

    return node
  }

  return null
}
