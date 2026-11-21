import { useAtomValue } from 'jotai'
import { useEffect } from 'react'

import { RouteMapContainer } from '../features/route-map'
import { RunSummaryContainer } from '../features/run-summary'
import { ConnectionBannerContainer, runnerConnectionService } from '../features/runner-connection'

/** The composition root: features meet only here, and the connection's snapshot reaches the others as props. */
export const AtlasPage = () => {
  const connection = useAtomValue(runnerConnectionService.$connection)

  const { snapshot, status, lastUpdate } = connection

  const viewer = snapshot?.sites.find((site) => {
    return site.id === snapshot.viewer.siteId
  })

  useEffect(() => {
    document.title = viewer === undefined ? 'atlas' : `atlas · ${viewer.app}`
  }, [viewer])

  return (
    <div className="atlas-shell">
      <RunSummaryContainer snapshot={snapshot} lastUpdate={lastUpdate} />
      <ConnectionBannerContainer />
      <main className="atlas-main">
        <RouteMapContainer snapshot={snapshot} isDisconnected={status === 'disconnected'} isStale={status !== 'live'} />
      </main>
    </div>
  )
}
