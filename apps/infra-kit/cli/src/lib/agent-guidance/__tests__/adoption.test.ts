import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { findWorkspaceRoot, resetAdoptionCache, resolveAdoption } from '../adoption'
import { PACKAGE_MARKER_END, PACKAGE_MARKER_START, PACKAGE_VERSION_PREFIX } from '../markers'

const WORKSPACE_YAML = "packages:\n  - 'packages/*'\n"

const wellFormedBlock = `${PACKAGE_MARKER_START}\n${PACKAGE_VERSION_PREFIX}0.4.0 lib -->\n\n# @x/a\n${PACKAGE_MARKER_END}\n`
/** Half a marker pair — `inspectPackageGuidance` calls this `malformed`, which is not adoption. */
const malformedBlock = `${PACKAGE_MARKER_START}\n# @x/a\n`

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

/** A temp pnpm workspace with `packages/<name>` dirs, each holding a package.json. */
const makeWorkspace = (packages: string[], workspaceYaml = WORKSPACE_YAML): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-adoption-'))

  writeFile(path.join(root, 'pnpm-workspace.yaml'), workspaceYaml)

  for (const name of packages) {
    writeFile(path.join(root, 'packages', name, 'package.json'), `{ "name": "@x/${name}" }\n`)
  }

  return root
}

describe('findWorkspaceRoot', () => {
  it('walks up from a nested directory to the pnpm-workspace.yaml', () => {
    const root = makeWorkspace(['a'])

    expect(findWorkspaceRoot(path.join(root, 'packages', 'a'))).toBe(root)
    expect(findWorkspaceRoot(root)).toBe(root)
  })

  it('returns null when no pnpm-workspace.yaml exists above the start directory', () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-adoption-loose-'))

    expect(findWorkspaceRoot(loose)).toBeNull()
  })
})

describe('resolveAdoption', () => {
  beforeEach(() => {
    resetAdoptionCache()
  })

  it('is not adopted when no package carries a guidance block', async () => {
    const root = makeWorkspace(['a', 'b'])

    expect(await resolveAdoption(root)).toEqual({ adopted: false, workspaceRoot: root })
  })

  it('is adopted, and names the adopting CLAUDE.md, when one package carries a well-formed block', async () => {
    const root = makeWorkspace(['a', 'b'])
    const evidencePath = path.join(root, 'packages', 'b', 'CLAUDE.md')

    writeFile(evidencePath, wellFormedBlock)

    expect(await resolveAdoption(root)).toEqual({ adopted: true, workspaceRoot: root, evidencePath })
  })

  it('is not adopted when the only block is malformed', async () => {
    const root = makeWorkspace(['a'])

    writeFile(path.join(root, 'packages', 'a', 'CLAUDE.md'), malformedBlock)

    expect(await resolveAdoption(root)).toEqual({ adopted: false, workspaceRoot: root })
  })

  it('is not adopted when a CLAUDE.md exists but carries no infra-kit markers at all', async () => {
    const root = makeWorkspace(['a'])

    writeFile(path.join(root, 'packages', 'a', 'CLAUDE.md'), '# hand-written notes\n')

    expect(await resolveAdoption(root)).toEqual({ adopted: false, workspaceRoot: root })
  })

  it('is not adopted with a null workspace root (nothing to probe)', async () => {
    expect(await resolveAdoption(null)).toEqual({ adopted: false, workspaceRoot: null })
  })

  it('degrades to not-adopted, without throwing, on an unparseable pnpm-workspace.yaml', async () => {
    // `findWorkspaceRoot` proves the file EXISTS; only `discoverPackages` proves it parses.
    const root = makeWorkspace(['a'], 'packages: [ "unclosed\n')

    writeFile(path.join(root, 'packages', 'a', 'CLAUDE.md'), wellFormedBlock)

    expect(await resolveAdoption(root)).toEqual({ adopted: false, workspaceRoot: root })
  })

  it('memoizes per workspace root, and the memo does not leak across roots', async () => {
    const adoptedRoot = makeWorkspace(['a'])
    const bareRoot = makeWorkspace(['a'])
    const evidencePath = path.join(adoptedRoot, 'packages', 'a', 'CLAUDE.md')

    writeFile(evidencePath, wellFormedBlock)

    expect(await resolveAdoption(adoptedRoot)).toEqual({ adopted: true, workspaceRoot: adoptedRoot, evidencePath })
    // A different root is probed on its own, not served from the first root's entry.
    expect(await resolveAdoption(bareRoot)).toEqual({ adopted: false, workspaceRoot: bareRoot })

    // The memo really is a memo: deleting the evidence does not change the cached verdict…
    fs.rmSync(evidencePath)
    expect((await resolveAdoption(adoptedRoot)).adopted).toBe(true)

    // …until the cache is dropped.
    resetAdoptionCache()
    expect(await resolveAdoption(adoptedRoot)).toEqual({ adopted: false, workspaceRoot: adoptedRoot })
  })
})
