import { describe, expect, it } from 'vitest'

import { buildDesignSkeleton } from '../bodies/design-skeleton'
import { buildPackageBody } from '../bodies/package-body'
import { buildRootBody } from '../bodies/root-body'
import { PACKAGE_TYPES } from '../package-type'
import type { PackageType } from '../package-type'

/**
 * Characterization snapshot of every string the guidance builders render — the
 * behaviour-preservation baseline for the move of this prose out of TypeScript
 * and into `resources/**\/*.md`.
 *
 * Twelve strings: the root body, both README variants of all five package types,
 * and the design skeleton. A fixed `0.0.0` keeps the version line from making
 * every release bump a snapshot diff.
 *
 * This is a snapshot rather than hand-maintained literals on purpose. The point
 * of moving the prose into markdown is to make a text edit a one-file diff, and a
 * golden fixture would make every prose PR a two-file one. Updating with
 * `pnpm exec vitest -u` is the intended workflow, and the snapshot diff *is* the
 * prose review — so read it rather than reflexively accepting it.
 */
const VERSION = '0.0.0'
const PACKAGE_NAME = '@x/y'
const REL_DIR = 'a/b'

const body = (type: PackageType, hasReadme: boolean): string => {
  return buildPackageBody({
    version: VERSION,
    type,
    packageName: PACKAGE_NAME,
    relDir: REL_DIR,
    hasReadme,
    hasDesign: false,
  })
}

describe('guidance bodies — characterization snapshot', () => {
  it('renders the root body', () => {
    expect(buildRootBody(VERSION)).toMatchSnapshot()
  })

  it.each([...PACKAGE_TYPES])('renders the %s body with a README', (type) => {
    expect(body(type, true)).toMatchSnapshot()
  })

  it.each([...PACKAGE_TYPES])('renders the %s body without a README', (type) => {
    expect(body(type, false)).toMatchSnapshot()
  })

  it('renders the design skeleton', () => {
    expect(buildDesignSkeleton(PACKAGE_NAME)).toMatchSnapshot()
  })
})
