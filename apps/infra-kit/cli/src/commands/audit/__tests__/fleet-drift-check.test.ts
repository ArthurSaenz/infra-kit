import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkFleetDrift, findFleetDrift } from '../fleet-drift-check'
import type { Catalogs, DependencySite } from '../fleet-drift-check'

const CURRENT = '0.34.0'
const NO_CATALOG: Catalogs = { default: {}, named: {} }

const site = (file: string, name: string, spec: string): DependencySite => {
  return { file, section: 'devDependencies', name, spec }
}

const names = (checks: ReturnType<typeof findFleetDrift>): string[] => {
  return checks.map((check) => {
    return check.name
  })
}

describe('findFleetDrift', () => {
  it('passes a repo with no kit or CLI dependencies', () => {
    expect(findFleetDrift([site('package.json', 'zod', '^4.0.0')], NO_CATALOG, CURRENT)).toEqual([
      { name: 'dependency-drift', status: 'pass', message: 'no @slip-stream-kit/* or infra-kit dependency drift' },
    ])
  })

  it('(a) warns on a kit package pinned at more than one range', () => {
    const checks = findFleetDrift(
      [
        site('apps/a/package.json', '@slip-stream-kit/config', '^0.34.0'),
        site('apps/b/package.json', '@slip-stream-kit/config', '^0.34.1'),
      ],
      NO_CATALOG,
      CURRENT,
    )

    expect(names(checks)).toEqual(['dependency-drift:catalog'])
    expect(checks[0]!.status).toBe('warn')
    expect(checks[0]!.message).toContain('pinned at more than one range')
  })

  it('(a) warns on a kit package that bypasses its catalog entry', () => {
    const checks = findFleetDrift(
      [
        site('apps/a/package.json', '@slip-stream-kit/vite', 'catalog:'),
        site('apps/b/package.json', '@slip-stream-kit/vite', '^0.34.0'),
      ],
      { default: { '@slip-stream-kit/vite': '^0.34.0' }, named: {} },
      CURRENT,
    )

    expect(names(checks)).toEqual(['dependency-drift:catalog'])
    expect(checks[0]!.message).toContain('apps/b/package.json "^0.34.0" bypass it')
  })

  it('(b) warns on a range a minor behind the lockstep version, resolving catalog: references', () => {
    const checks = findFleetDrift(
      [site('apps/a/package.json', '@slip-stream-kit/config', 'catalog:')],
      { default: { '@slip-stream-kit/config': '^0.33.2' }, named: {} },
      CURRENT,
    )

    expect(checks).toEqual([
      {
        name: 'dependency-drift:lockstep',
        status: 'warn',
        message: '@slip-stream-kit/config@^0.33.2 is behind the infra-kit 0.34.0 lockstep release — bump it to ^0.34.0',
      },
    ])
  })

  it('(b) does not warn on a patch behind, or on an unparseable range', () => {
    const sites = [
      site('apps/a/package.json', '@slip-stream-kit/config', '^0.34.0'),
      site('apps/a/package.json', '@slip-stream-kit/vite', 'latest'),
    ]

    expect(names(findFleetDrift(sites, NO_CATALOG, '0.34.5'))).toEqual(['dependency-drift'])
  })

  it('(c) warns on any infra-kit dependency', () => {
    const checks = findFleetDrift([site('package.json', 'infra-kit', '0.13.0')], NO_CATALOG, CURRENT)

    expect(names(checks)).toEqual(['dependency-drift:infra-kit-pin'])
    expect(checks[0]!.message).toContain('package.json "0.13.0"')
  })

  it('ignores workspace: specs — the CLI monorepo linking its own packages', () => {
    const sites = [
      site('apps/x/package.json', '@slip-stream-kit/config', 'workspace:^'),
      site('apps/y/package.json', 'infra-kit', 'workspace:*'),
    ]

    expect(names(findFleetDrift(sites, NO_CATALOG, CURRENT))).toEqual(['dependency-drift'])
  })
})

describe('checkFleetDrift --fix', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  })

  const writeJson = (filePath: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
  }

  const makeRepo = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-drift-'))

    tmpDirs.push(root)
    fs.writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - apps/*\ncatalog:\n  '@slip-stream-kit/config': ^0.34.0\n",
    )
    writeJson(path.join(root, 'package.json'), { name: 'root', devDependencies: { 'infra-kit': '0.13.0' } })
    writeJson(path.join(root, 'apps/a/package.json'), {
      name: 'a',
      dependencies: { '@slip-stream-kit/config': '^0.34.0', zod: '^4.0.0' },
    })

    return root
  }

  it('reports without writing when fix is off', async () => {
    const root = makeRepo()
    const before = fs.readFileSync(path.join(root, 'apps/a/package.json'), 'utf-8')

    const { checks, rewritten } = await checkFleetDrift(root, false, CURRENT)

    expect(rewritten).toEqual([])
    expect(names(checks)).toEqual(['dependency-drift:catalog', 'dependency-drift:infra-kit-pin'])
    expect(fs.readFileSync(path.join(root, 'apps/a/package.json'), 'utf-8')).toBe(before)
  })

  it('rewrites (a) to catalog: and leaves (c) alone', async () => {
    const root = makeRepo()

    const { checks, rewritten } = await checkFleetDrift(root, true, CURRENT)

    expect(rewritten).toEqual([path.join('apps', 'a', 'package.json')])
    expect(names(checks)).toEqual(['dependency-drift:infra-kit-pin'])
    expect(JSON.parse(fs.readFileSync(path.join(root, 'apps/a/package.json'), 'utf-8'))).toEqual({
      name: 'a',
      dependencies: { '@slip-stream-kit/config': 'catalog:', zod: '^4.0.0' },
    })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).devDependencies).toEqual({
      'infra-kit': '0.13.0',
    })
  })
})
