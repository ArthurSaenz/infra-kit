import { useEffect } from 'react'

declare global {
  interface Window {
    _app?: Record<string, any>
  }
}

export const E2EHydrationComp = () => {
  useEffect(() => {
    /**
     * @see E2E
     * @description e2e data for suites
     */
    window._app = window._app || {}
    window._app.e2eData = {
      isReadyAfterHydration: true,
    }
  }, [])

  return null
}
