import SearchDialog from '@/components/search'
import { appName } from '@/lib/shared'
import appCss from '@/styles/app.css?url'
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { RootProvider } from 'fumadocs-ui/provider/tanstack'

export const Route = createRootRoute({
  head: () => {
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: appName },
      ],
      links: [{ rel: 'stylesheet', href: appCss }],
    }
  },
  component: RootComponent,
})

/**
 * Root HTML shell: provides RootProvider (fumadocs), HeadContent, Scripts, and the Outlet.
 * Registered as the root route component via createRootRoute.
 *
 * @example
 *     createRootRoute({ component: RootComponent })
 *
 */
function RootComponent() {
  return (
    <html suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ SearchDialog }}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  )
}
