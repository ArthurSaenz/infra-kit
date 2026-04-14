import { useEffect } from 'react'

declare global {
  interface Window {
    _app?: Record<string, any>
  }
}

interface SemanticVersionProps {
  version: string
  env: string
  release: string
  commitHash: string
}

/**
 * @description Semantic version of application and other dev metadata with injected from build to window object
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
