import { formatClock } from '../../../lib/format-clock'
import { runLogLinks } from '../../../lib/log-links'
import { RunSummaryComponent } from '../components/run-summary-component'
import type { RunSummaryContainerProps } from '../types'

export const RunSummaryContainer = (props: RunSummaryContainerProps) => {
  const { snapshot, lastUpdate } = props

  // Before the first answer there is no run to describe, only the page's own chrome.
  if (snapshot === null) return <RunSummaryComponent facts={null} logLinks={[]} />

  return (
    <RunSummaryComponent
      facts={{
        pid: snapshot.run.pid,
        siteCount: snapshot.sites.length,
        backendCount: snapshot.backends.length,
        checkedAt: lastUpdate === null ? null : formatClock(lastUpdate),
      }}
      logLinks={runLogLinks(snapshot)}
    />
  )
}
