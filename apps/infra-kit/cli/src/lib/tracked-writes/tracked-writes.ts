/**
 * @fileoverview
 * Whether this process may rewrite files a project tracks in git (`infra-kit.json`,
 * `.claude/settings.json`, `.mcp.json`).
 *
 * Two reasons to withhold, one predicate so the writers agree: a CI checkout, where a rewrite is lost
 * with the job, and `setup --unattended`, the run the update worker starts in every project after an
 * upgrade — nobody is there to commit the hunk, and it would land on whatever branch the checkout is on.
 * A withheld write is reported with the command a human runs, never dropped silently.
 */
import { isCI } from 'src/lib/agent-mode'

/**
 * Set by `setup --unattended`. `setup`'s own writers read this flag alone: an explicit setup in CI
 * keeps converging the tracked files, as it always has.
 *
 * Mutable holder (object so `prefer-const` holds while the flag toggles per run).
 */
export const trackedWrites = { withheld: false }

/** The loader's gate on its silent on-read rewrite, which CI withholds too. */
export const trackedWritesWithheld = (): boolean => {
  return trackedWrites.withheld || isCI()
}
