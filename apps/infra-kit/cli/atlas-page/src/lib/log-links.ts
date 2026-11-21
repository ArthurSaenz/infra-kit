import { ATLAS_RUN_FOLDER_ID } from './atlas-contract'
import type { AtlasLog, AtlasSnapshot } from './atlas-contract'

export interface LogLink {
  label: string
  /** `null` when there is nothing to open yet; the page renders the label disabled, never a dead link. */
  href: string | null
  /** What the runner is asked to open on a click; `href` is where the click goes when it cannot. */
  openId: string | null
  /** The file system path, shown as the tooltip so the viewer can find the file without VS Code. */
  title: string
}

const NOT_WRITTEN = 'not written yet'

/** One service's log; a backend another runner owns has no log here, so it gets a disabled entry. */
export const serviceLogLink = (log: AtlasLog | null, label = 'log'): LogLink => {
  if (log === null) return { label, href: null, openId: null, title: 'this runner keeps no log for it' }

  if (!log.exists) return { label, href: null, openId: null, title: `${log.path} (${NOT_WRITTEN})` }

  return { label, href: log.href, openId: log.service, title: log.path }
}

export const runFolderLink = (run: AtlasSnapshot['run']): LogLink => {
  return { label: 'run folder', href: run.logDirHref, openId: ATLAS_RUN_FOLDER_ID, title: run.logDir }
}

/** The runner-wide logs (runner, turbo, watch), labelled by service, then the folder holding them. */
export const runLogLinks = (snapshot: AtlasSnapshot): LogLink[] => {
  const services = snapshot.logs.map((log) => {
    return serviceLogLink(log, log.service)
  })

  return [...services, runFolderLink(snapshot.run)]
}
