import type { MouseEvent } from 'react'

import type { LogLink as LogLinkModel } from '../lib/log-links'
import { openInRunner } from '../lib/open-in-runner'

interface LogLinkProps {
  link: LogLinkModel
}

/** `nodrag` keeps a click on the link from starting a node drag inside the canvas. */
export const LogLink = (props: LogLinkProps) => {
  const { link } = props

  if (link.href === null) {
    return (
      <span className="log-link nodrag is-disabled" aria-disabled="true" title={link.title}>
        {link.label}
      </span>
    )
  }

  const { href, openId } = link

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (openId === null) return

    event.preventDefault()
    openInRunner(openId)
      .then((opened) => {
        // eslint-disable-next-line no-restricted-syntax -- an editor URL scheme (`vscode://`) hands off to another app; there is no route to go to
        if (!opened) window.location.assign(href)
      })
      .catch(() => {})
  }

  return (
    <a className="log-link nodrag" href={href} title={link.title} onClick={onClick}>
      {link.label}
      <span className="log-link__arrow" aria-hidden="true">
        ↗
      </span>
    </a>
  )
}
