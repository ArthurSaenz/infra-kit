import { NotFound } from '@/components/not-found'
import { baseOptions } from '@/lib/layout-shared'
import { appName } from '@/lib/shared'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultNotFoundComponent: () => {
      return <NotFound baseOptions={baseOptions(appName)} />
    },
  })
}
