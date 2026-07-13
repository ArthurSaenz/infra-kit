import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { HELPER_VERSION_FLOOR, assertHelperVersionFloor, isBelowVersion } from 'src/dev/dev-server'

import { createTempTracker } from './fixtures'

/**
 * The version floor is the ONE load-bearing guard against CLI/helper skew, and skew here is guaranteed
 * rather than hypothetical: the CLI is installed globally and self-updates silently, while `infra-kit/vite`
 * is PINNED in each consumer's node_modules. An old helper ignores the fragment's `origin`, rebuilds the
 * target from a `templates.local` that still says `http://`, and proxies plain HTTP at a TLS listener —
 * and portless answers :80 with a 302 rather than refusing, so nothing downstream catches it.
 *
 * A guard with no tests is a guard that rots. These pin all three branches.
 */
const temp = createTempTracker()

afterEach(() => {
  temp.cleanup()
})

/** A repo root with an optional root package.json and an optional installed `node_modules/infra-kit`. */
const makeRepo = (opts: { declares?: boolean; installedVersion?: string; linkTo?: string }): string => {
  const root = temp.register(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'floor-')))

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(opts.declares ? { name: 'consumer', devDependencies: { 'infra-kit': '^0.1.0' } } : { name: 'x' }),
  )

  const helperDir = path.join(root, 'node_modules', 'infra-kit')

  if (opts.linkTo != null) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.symlinkSync(opts.linkTo, helperDir, 'dir')
  } else if (opts.installedVersion != null) {
    fs.mkdirSync(helperDir, { recursive: true })
    fs.writeFileSync(path.join(helperDir, 'package.json'), JSON.stringify({ version: opts.installedVersion }))
  }

  return root
}

describe('isBelowVersion', () => {
  it('orders numerically, not lexically (0.1.9 < 0.1.132 — a string compare gets this backwards)', () => {
    expect(isBelowVersion('0.1.9', '0.1.132')).toBe(true)
    expect(isBelowVersion('0.1.131', '0.1.132')).toBe(true)
    expect(isBelowVersion('0.1.132', '0.1.132')).toBe(false)
    expect(isBelowVersion('0.1.133', '0.1.132')).toBe(false)
    expect(isBelowVersion('0.2.0', '0.1.132')).toBe(false)
    expect(isBelowVersion('1.0.0', '0.1.132')).toBe(false)
  })
})

describe('assertHelperVersionFloor', () => {
  it('throws when the pinned helper predates the HTTPS contract, naming the bump', () => {
    // The whole point: an older helper would proxy plain HTTP at a TLS listener, silently.
    const root = makeRepo({ declares: true, installedVersion: '0.1.131' })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).toThrow(new RegExp(`pins infra-kit 0\\.1\\.131[\\s\\S]*${HELPER_VERSION_FLOOR.replaceAll('.', '\\.')}`))
  })

  it('passes when the pinned helper is at or above the floor', () => {
    const root = makeRepo({ declares: true, installedVersion: HELPER_VERSION_FLOOR })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).not.toThrow()
  })

  it('fAILS CLOSED: a repo that declares infra-kit but has not installed it is refused, not waved through', () => {
    // "Cannot verify" must never mean "assume fine" — that is precisely how the silent case ships.
    const root = makeRepo({ declares: true })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).toThrow(/pnpm install/)
  })

  it('skips a repo that does not depend on infra-kit at all — there is no helper to be skewed against', () => {
    const root = makeRepo({ declares: false })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).not.toThrow()
  })

  it('skips a workspace-linked helper — otherwise the floor bricks dev on the repo that DEVELOPS infra-kit', () => {
    // In this repo `node_modules/infra-kit` symlinks to `apps/infra-kit/cli`, whose version is the
    // unreleased working tree and therefore always below the next floor.
    const root = makeRepo({ declares: true })
    const source = path.join(root, 'apps', 'infra-kit', 'cli')

    fs.mkdirSync(source, { recursive: true })
    // Deliberately BELOW the floor: only the workspace-link branch can save it.
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '0.0.1' }))
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.symlinkSync(source, path.join(root, 'node_modules', 'infra-kit'), 'dir')

    expect(() => {
      return assertHelperVersionFloor(root)
    }).not.toThrow()
  })
})
