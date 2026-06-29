import { Suspense, lazy, useEffect, useState } from 'react'

import { isSSR } from '../ssr'

/**
 * Wraps a component to render it only on the client side, suppressing SSR output and hydration mismatches.
 *
 * @see https://vike.dev/ClientOnly
 *
 * @example
 *     const ClientMap = clientOnly(() => import('./Map'))
 *
 */
export const clientOnly = <T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T } | T>,
): React.ComponentType<React.ComponentProps<T> & { fallback?: React.ReactNode }> => {
  if (isSSR) {
    return (props) => {
      return <>{props.fallback}</>
    }
  }
  const Component = lazy(() => {
    return load()
      .then((LoadedComponent) => {
        return 'default' in LoadedComponent ? LoadedComponent : { default: LoadedComponent }
      })
      .catch((error) => {
        console.error('Component loading failed:', error)

        return {
          default: (() => {
            return <p>Error loading component.</p>
          }) as any,
        }
      })
  })

  return (props: any & { ref?: React.RefObject<any | null> }) => {
    const { ref, fallback, ...rest } = props

    const [mounted, setMounted] = useState(false)

    useEffect(() => {
      setMounted(true)
    }, [])

    if (!mounted) {
      return <>{fallback}</>
    }

    return (
      <Suspense fallback={<>{fallback}</>}>
        <Component {...rest} ref={ref} />
      </Suspense>
    )
  }
}
