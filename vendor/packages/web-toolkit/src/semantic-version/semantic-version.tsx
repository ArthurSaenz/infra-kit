import { useEffect } from 'react'

interface SemanticVersionProps {
  version: string
  env: string
  release: string
  commitHash: string
}

/**
 * React component that injects semantic version and build metadata into the window object.
 *
 * @example
 *     <SemanticVersion version="1.0.0" env="production" release="v1.0.0" commitHash="abc123" />
 *
 */
export const SemanticVersion = (props: SemanticVersionProps) => {
  const { version, env, release, commitHash } = props

  useEffect(() => {
    window._app = window._app || {}

    window._app.info = window._app.info || ({} as any)

    window._app.info.version = version
    window._app.info.env = env
    window._app.info.release = release
    window._app.info.commitHash = commitHash
  }, [])

  return null
}

declare global {
  interface Window {
    _app?: Record<string, any>
  }
}
