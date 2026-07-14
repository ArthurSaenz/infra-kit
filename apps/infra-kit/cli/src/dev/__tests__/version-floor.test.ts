import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { HELPER_PACKAGES, assertHelperVersionFloor, isBelowVersion } from 'src/dev/dev-server'

import { createTempTracker } from './fixtures'

/**
 * The version floor is the ONE load-bearing guard against CLI/helper skew, and skew here is guaranteed
 * rather than hypothetical: the CLI is installed globally and self-updates silently, while the helper is
 * PINNED in each consumer's node_modules. An old helper ignores the fragment's `origin`, rebuilds the
 * target from a `templates.local` that still says `http://`, and proxies plain HTTP at a TLS listener —
 * and portless answers :80 with a 302 rather than refusing, so nothing downstream catches it.
 *
 * A guard with no tests is a guard that rots. These pin every branch, INCLUDING the two failure modes
 * the `infra-kit` → `@slip-stream-kit/config` split introduced: a re-keyed guard that stops checking
 * un-migrated consumers, and a guard that only checks the first helper it finds.
 */
const temp = createTempTracker()

afterEach(() => {
  temp.cleanup()
})

const LEGACY = 'infra-kit'
const CURRENT = '@slip-stream-kit/config'
const PLUGIN = '@slip-stream-kit/vite'

const floorOf = (name: string): string => {
  const entry = HELPER_PACKAGES.find((helper) => {
    return helper.name === name
  })

  if (!entry) throw new Error(`no floor registered for ${name}`)

  return entry.floor
}

interface HelperSpec {
  /** Declared in the ROOT package.json's devDependencies. */
  declares?: string[]
  /** Physically present under the ROOT node_modules at this version. */
  installed?: Record<string, string>
  /** Physically present as a workspace symlink to an in-repo dir carrying this version. */
  linked?: Record<string, string>
  /**
   * A workspace package at `apps/client/ui` that DECLARES a helper and has it installed in its OWN
   * node_modules — the layout pnpm actually produces, and the one the root-only probe used to miss.
   * This is where a consumer's `vite.config.ts` lives, so it is the natural place to declare the helper.
   */
  nested?: { declares: string[]; installed?: Record<string, string> }
}

/** Write `<dir>/node_modules/<name>/package.json` with `version`. */
const installAt = (dir: string, name: string, version: string): void => {
  const helperDir = path.join(dir, 'node_modules', ...name.split('/'))

  fs.mkdirSync(helperDir, { recursive: true })
  fs.writeFileSync(path.join(helperDir, 'package.json'), JSON.stringify({ version }))
}

const makeRepo = (spec: HelperSpec): string => {
  const root = temp.register(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'floor-')))
  const devDependencies = Object.fromEntries(
    (spec.declares ?? []).map((name) => {
      return [name, '^0.1.0']
    }),
  )

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'consumer', devDependencies }))

  for (const [name, version] of Object.entries(spec.installed ?? {})) installAt(root, name, version)

  for (const [name, version] of Object.entries(spec.linked ?? {})) {
    const source = path.join(root, 'apps', 'infra-kit', name.split('/').pop() ?? 'pkg')
    const linkPath = path.join(root, 'node_modules', ...name.split('/'))

    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version }))
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.symlinkSync(source, linkPath, 'dir')
  }

  if (spec.nested) {
    const uiDir = path.join(root, 'apps', 'client', 'ui')
    const nestedDeps = Object.fromEntries(
      spec.nested.declares.map((name) => {
        return [name, '^0.1.0']
      }),
    )

    fs.mkdirSync(uiDir, { recursive: true })
    fs.writeFileSync(
      path.join(uiDir, 'package.json'),
      JSON.stringify({ name: 'client-ui', devDependencies: nestedDeps }),
    )

    for (const [name, version] of Object.entries(spec.nested.installed ?? {})) installAt(uiDir, name, version)
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

/** Every helper package name, so the tables below cannot silently miss one that was added. */
const HELPER_NAMES = HELPER_PACKAGES.map((helper) => {
  return helper.name
})

describe('assertHelperVersionFloor', () => {
  it.each(HELPER_NAMES)('throws when the pinned %s helper predates the HTTPS contract, naming the bump', (name) => {
    // The whole point: an older helper would proxy plain HTTP at a TLS listener, silently.
    const floor = floorOf(name)
    const root = makeRepo({ declares: [name], installed: { [name]: '0.0.1' } })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).toThrow(new RegExp(`pins ${name.replaceAll('/', '\\/')} 0\\.0\\.1[\\s\\S]*${floor.replaceAll('.', '\\.')}`))
  })

  it.each(HELPER_NAMES)('passes when the pinned %s helper is at the floor', (name) => {
    const root = makeRepo({ declares: [name], installed: { [name]: floorOf(name) } })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).not.toThrow()
  })

  it('still enforces the LEGACY floor when the new package is also installed and passing', () => {
    // The migration's sharpest trap. A repo mid-migration has BOTH: `@slip-stream-kit/config` added, and
    // `infra-kit` not yet dropped — and its vite configs may still import `infra-kit/vite`. A guard that
    // checked only the first helper it found (or that was RE-keyed to the new package rather than
    // extended) would wave this exact repo through to a silent plain-HTTP-into-TLS proxy.
    const root = makeRepo({
      declares: [LEGACY, CURRENT],
      installed: { [LEGACY]: '0.1.131', [CURRENT]: floorOf(CURRENT) },
    })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).toThrow(/pins infra-kit 0\.1\.131/)
  })

  it('enforces the floor on a helper installed in a NESTED package, not just at the repo root', () => {
    // pnpm does not hoist a workspace package's dep to the root: `@slip-stream-kit/config` declared in
    // apps/client/ui lands in apps/client/ui/node_modules and the root has NO trace of it. That is also the
    // natural place to declare it — right next to the vite.config.ts that imports it. A root-only probe
    // would never version-check the helper that vite actually loads, which is the silent skip this guard
    // exists to prevent.
    const root = makeRepo({
      declares: [],
      nested: { declares: [CURRENT], installed: { [CURRENT]: '0.0.1' } },
    })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).toThrow(/pins @slip-stream-kit\/config 0\.0\.1/)
  })

  it('accepts a nested install that is at the floor, without demanding a root one', () => {
    // The counterpart, and the migration's END STATE: root `infra-kit` is gone (the CLI is global) and the
    // helper is declared where it is used. A root-only probe would call this "missing" and tell the user to
    // run `pnpm install` — advice that can never fix it, because pnpm will not move the package to the root.
    const root = makeRepo({
      declares: [],
      nested: { declares: [CURRENT], installed: { [CURRENT]: floorOf(CURRENT) } },
    })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).not.toThrow()
  })

  it('enforces the floor on a plugin-only consumer, whose config package is merely transitive', () => {
    // Why `@slip-stream-kit/vite` needs its own HELPER_PACKAGES entry rather than riding on the config
    // package it wraps. A consumer on the plugin declares ONLY the plugin, so under pnpm the config
    // package lives in the virtual store — resolvable from neither the app dir nor the root. Without the
    // plugin's own entry this repo declares no known helper, and the guard skips it entirely: the exact
    // population running an old helper, waved through to a silent plain-HTTP-into-TLS proxy.
    const root = makeRepo({
      declares: [],
      nested: { declares: [PLUGIN], installed: { [PLUGIN]: '0.0.1' } },
    })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).toThrow(/pins @slip-stream-kit\/vite 0\.0\.1/)
  })

  it('fails closed: a repo that declares a helper but has not installed it is refused, not waved through', () => {
    // "Cannot verify" must never mean "assume fine" — that is precisely how the silent case ships.
    const root = makeRepo({ declares: [CURRENT] })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).toThrow(/pnpm install/)
  })

  it('skips a repo that depends on no helper at all — there is nothing to be skewed against', () => {
    const root = makeRepo({ declares: [] })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).not.toThrow()
  })

  it('skips a workspace-linked helper — otherwise the floor bricks dev on the repo that DEVELOPS it', () => {
    // In this repo `node_modules/@slip-stream-kit/config` symlinks to `apps/infra-kit/config`, whose
    // version is the unreleased working tree and therefore always below the next floor. The linked
    // version is deliberately BELOW the floor: only the workspace-link branch can save it.
    const root = makeRepo({ declares: [CURRENT], linked: { [CURRENT]: '0.0.1' } })

    expect(() => {
      return assertHelperVersionFloor(root)
    }).not.toThrow()
  })
})
