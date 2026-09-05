import { describe, expect, it } from 'vitest'

import { buildManagedBlock } from 'src/lib/managed-block'

import { buildPackageBody } from '../bodies/package-body'
import { buildRootBody } from '../bodies/root-body'
import { inspectPackageGuidance } from '../inspect'
import { PACKAGE_MARKER_END, PACKAGE_MARKER_START, ROOT_MARKER_END, ROOT_MARKER_START } from '../markers'
import { PACKAGE_TYPES } from '../package-type'

const packageFile = (bodyText: string): string => {
  return `# hand-authored\n\n${buildManagedBlock(PACKAGE_MARKER_START, bodyText, PACKAGE_MARKER_END)}\n`
}

const wellFormed = packageFile(
  buildPackageBody({
    version: '0.4.0',
    type: 'frontend',
    packageName: '@hulyo/client-ui',
    relDir: 'apps/client/ui',
    hasReadme: true,
    hasDesign: false,
  }),
)

describe('inspectPackageGuidance', () => {
  it('reports missing when the file does not exist', () => {
    expect(inspectPackageGuidance(null)).toEqual({ state: 'missing' })
  })

  it('reports no-block for a file with no infra-kit markers', () => {
    expect(inspectPackageGuidance('# just prose\n')).toEqual({ state: 'no-block' })
  })

  it('reports no-block for an empty file', () => {
    expect(inspectPackageGuidance('')).toEqual({ state: 'no-block' })
  })

  it('reports ok with the version and type of a well-formed block', () => {
    expect(inspectPackageGuidance(wellFormed)).toEqual({ state: 'ok', version: '0.4.0', type: 'frontend' })
  })

  it('preserves the hand-authored text around the block it accepts', () => {
    expect(wellFormed).toContain('# hand-authored')
  })

  it('reports ok but omits the type when the block names one this CLI does not know', () => {
    expect(inspectPackageGuidance(packageFile('<!-- infra-kit:package:version 9.9.9 quantum -->\n\n# x'))).toEqual({
      state: 'ok',
      version: '9.9.9',
    })
  })

  // The version line ends in `-->`, so an unvalidated capture reads the marker terminator as the
  // type and every block written without one reports `type --`.
  it('reports ok but omits the type when the version line carries no type token', () => {
    expect(inspectPackageGuidance(packageFile('<!-- infra-kit:package:version 0.4.0 -->\n\n# x'))).toEqual({
      state: 'ok',
      version: '0.4.0',
    })
  })

  it.each([...PACKAGE_TYPES])('accepts %s as a version-line type token', (type) => {
    expect(inspectPackageGuidance(packageFile(`<!-- infra-kit:package:version 0.4.0 ${type} -->\n\n# x`))).toEqual({
      state: 'ok',
      version: '0.4.0',
      type,
    })
  })

  it('reports ok without a version when the block carries no version line', () => {
    expect(inspectPackageGuidance(packageFile('# hand-written block'))).toEqual({ state: 'ok' })
  })

  it('reports malformed for reversed markers', () => {
    const reversed = `${PACKAGE_MARKER_END}\nbody\n${PACKAGE_MARKER_START}\n`

    expect(inspectPackageGuidance(reversed)).toEqual({ state: 'malformed' })
  })

  it('reports malformed for an empty body', () => {
    expect(inspectPackageGuidance(packageFile(''))).toEqual({ state: 'malformed' })
  })

  it('reports malformed for a whitespace-only body', () => {
    expect(inspectPackageGuidance(packageFile('   \n\t'))).toEqual({ state: 'malformed' })
  })

  it.each([
    ['start', `${PACKAGE_MARKER_START}\nbody\n`],
    ['end', `body\n${PACKAGE_MARKER_END}\n`],
  ])('reports malformed when only the %s marker is present', (_which, content) => {
    expect(inspectPackageGuidance(content)).toEqual({ state: 'malformed' })
  })

  it('reports foreign-block when the root block was pasted into a package file', () => {
    const rootPasted = buildManagedBlock(ROOT_MARKER_START, buildRootBody('0.4.0'), ROOT_MARKER_END)

    expect(inspectPackageGuidance(rootPasted)).toEqual({ state: 'foreign-block' })
  })

  it('prefers the package block when a file carries both pairs', () => {
    const both = `${buildManagedBlock(ROOT_MARKER_START, buildRootBody('0.4.0'), ROOT_MARKER_END)}\n\n${wellFormed}`

    expect(inspectPackageGuidance(both)).toEqual({ state: 'ok', version: '0.4.0', type: 'frontend' })
  })
})
