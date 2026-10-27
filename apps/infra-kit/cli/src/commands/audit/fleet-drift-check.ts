import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'

import type { PackageCheck } from 'src/lib/package-validator'
import { discoverPackages } from 'src/lib/package-validator/loader'

import packageJson from '../../../package.json' with { type: 'json' }

const DRIFT_CHECK = 'dependency-drift'

const KIT_SCOPE = '@slip-stream-kit/'
const CLI_NAME = 'infra-kit'

/** Peer ranges are a compatibility window, not a pin, so they are left out on purpose. */
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

type Section = (typeof SECTIONS)[number]

/** One `name: spec` entry in one `package.json`. */
export interface DependencySite {
  /** Repo-relative path of the `package.json`. */
  file: string
  section: Section
  name: string
  spec: string
}

/** `pnpm-workspace.yaml`'s `catalog` (default) and `catalogs` (named). */
export interface Catalogs {
  default: Record<string, string>
  named: Record<string, Record<string, string>>
}

/** A workspace-internal spec is the CLI's own monorepo linking itself — never drift. */
const isLocalSpec = (spec: string): boolean => {
  return spec.startsWith('workspace:') || spec.startsWith('link:') || spec.startsWith('file:')
}

const isCatalogSpec = (spec: string): boolean => {
  return spec.startsWith('catalog:')
}

/** The range a spec means: a `catalog:` reference resolved, anything else as written. */
const resolveSpec = (spec: string, catalogs: Catalogs, name: string): string | undefined => {
  if (!isCatalogSpec(spec)) return spec

  const catalogName = spec.slice('catalog:'.length)

  return catalogName === '' || catalogName === 'default' ? catalogs.default[name] : catalogs.named[catalogName]?.[name]
}

/** `[major, minor]` of the lowest version a range admits, or `null` for `*`, a tag, or a URL. */
const floorMinor = (range: string): [number, number] | null => {
  const match = range.slice(Math.max(range.search(/\d/), 0)).match(/^(\d+)\.(\d+)\.\d/)

  return match ? [Number(match[1]), Number(match[2])] : null
}

const isMinorBehind = (range: string, current: string): boolean => {
  const floor = floorMinor(range)
  const cli = floorMinor(current)

  if (!floor || !cli) return false

  return floor[0] < cli[0] || (floor[0] === cli[0] && floor[1] < cli[1])
}

const groupByName = (sites: DependencySite[]): Map<string, DependencySite[]> => {
  const groups = new Map<string, DependencySite[]>()

  for (const site of sites) {
    const group = groups.get(site.name)

    if (group) group.push(site)
    else groups.set(site.name, [site])
  }

  return groups
}

const describeSites = (sites: DependencySite[]): string => {
  return sites
    .map((site) => {
      return `${site.file} "${site.spec}"`
    })
    .join(', ')
}

/** (a) a kit package not on its catalog entry, or pinned at more than one range. The only `--fix`able kind. */
const catalogDrift = (kitSites: DependencySite[], catalogs: Catalogs): PackageCheck[] => {
  return [...groupByName(kitSites)].flatMap(([name, sites]): PackageCheck[] => {
    if (catalogs.default[name] !== undefined) {
      const offCatalog = sites.filter((site) => {
        return !isCatalogSpec(site.spec)
      })

      if (offCatalog.length === 0) return []

      return [
        {
          name: `${DRIFT_CHECK}:catalog`,
          status: 'warn',
          message: `${name} has a catalog entry (${catalogs.default[name]}) but ${describeSites(offCatalog)} bypass it — run \`ik audit --fix --root\` to rewrite them to "catalog:", then pnpm install`,
        },
      ]
    }

    if (
      new Set(
        sites.map((site) => {
          return site.spec
        }),
      ).size <= 1
    )
      return []

    return [
      {
        name: `${DRIFT_CHECK}:catalog`,
        status: 'warn',
        message: `${name} is pinned at more than one range: ${describeSites(sites)} — add one entry to the pnpm-workspace.yaml catalog, then run \`ik audit --fix --root\``,
      },
    ]
  })
}

/** (b) a kit package whose range floor is a minor (or more) behind the CLI's lockstep version. */
const lockstepDrift = (kitSites: DependencySite[], catalogs: Catalogs, current: string): PackageCheck[] => {
  const behind = new Map<string, string>()

  for (const site of kitSites) {
    const range = resolveSpec(site.spec, catalogs, site.name)

    if (range !== undefined && isMinorBehind(range, current)) behind.set(`${site.name}@${range}`, site.name)
  }

  return [...behind.keys()].map((key): PackageCheck => {
    return {
      name: `${DRIFT_CHECK}:lockstep`,
      status: 'warn',
      message: `${key} is behind the infra-kit ${current} lockstep release — bump it to ^${current}`,
    }
  })
}

/** (c) a repo-local `infra-kit` dependency: consumers run the global CLI, so a pin is a second, skewing copy. */
const cliPinDrift = (sites: DependencySite[]): PackageCheck[] => {
  const pins = sites.filter((site) => {
    return site.name === CLI_NAME
  })

  if (pins.length === 0) return []

  return [
    {
      name: `${DRIFT_CHECK}:infra-kit-pin`,
      status: 'warn',
      message: `${describeSites(pins)} — the repo runs the global infra-kit CLI; a local dependency is a second copy that can skew from it`,
    },
  ]
}

/**
 * Every drift row for the repo, or one `pass` row so a `--json` reader can tell "checked, clean"
 * from "not checked". All rows are `warn` until the fleet is converged (plan P1-promote).
 *
 * @example
 * findFleetDrift([{ file: 'package.json', section: 'devDependencies', name: 'infra-kit', spec: '0.13.0' }], { default: {}, named: {} }, '0.34.0')
 * // => [{ name: 'dependency-drift:infra-kit-pin', status: 'warn', message: 'package.json "0.13.0" — …' }]
 */
export const findFleetDrift = (sites: DependencySite[], catalogs: Catalogs, current: string): PackageCheck[] => {
  const external = sites.filter((site) => {
    return !isLocalSpec(site.spec)
  })

  const kitSites = external.filter((site) => {
    return site.name.startsWith(KIT_SCOPE)
  })

  const checks = [
    ...catalogDrift(kitSites, catalogs),
    ...lockstepDrift(kitSites, catalogs, current),
    ...cliPinDrift(external),
  ]

  return checks.length > 0
    ? checks
    : [{ name: DRIFT_CHECK, status: 'pass', message: `no ${KIT_SCOPE}* or infra-kit dependency drift` }]
}

const readJson = async (filePath: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const readCatalogs = async (root: string): Promise<Catalogs> => {
  try {
    const parsed = (yaml.parse(await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf-8')) ?? {}) as {
      catalog?: Record<string, string>
      catalogs?: Record<string, Record<string, string>>
    }

    return { default: parsed.catalog ?? {}, named: parsed.catalogs ?? {} }
  } catch {
    return { default: {}, named: {} }
  }
}

/** The root `package.json` plus every discovered workspace package's. */
const listManifests = async (root: string): Promise<string[]> => {
  const dirs = await discoverPackages(root).catch(() => {
    return [] as string[]
  })

  return [root, ...dirs].map((dir) => {
    return path.join(dir, 'package.json')
  })
}

const collectSites = async (root: string): Promise<DependencySite[]> => {
  const sites: DependencySite[] = []

  for (const manifest of await listManifests(root)) {
    const json = await readJson(manifest)

    if (!json) continue

    const file = path.relative(root, manifest)

    for (const section of SECTIONS) {
      const deps = (json[section] ?? {}) as Record<string, unknown>

      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === 'string') sites.push({ file, section, name, spec })
      }
    }
  }

  return sites
}

/**
 * Rewrite every off-catalog kit dependency that HAS a catalog entry to `catalog:`. The
 * multiple-ranges-without-a-catalog case is left alone: which range wins is a human call.
 * Returns the repo-relative files written.
 */
const rewriteToCatalog = async (root: string, sites: DependencySite[], catalogs: Catalogs): Promise<string[]> => {
  const targets = sites.filter((site) => {
    return (
      site.name.startsWith(KIT_SCOPE) &&
      !isLocalSpec(site.spec) &&
      !isCatalogSpec(site.spec) &&
      catalogs.default[site.name] !== undefined
    )
  })

  const files = [
    ...new Set(
      targets.map((site) => {
        return site.file
      }),
    ),
  ]

  for (const file of files) {
    const filePath = path.join(root, file)
    const raw = await fs.readFile(filePath, 'utf-8')
    const json = JSON.parse(raw) as Record<string, Record<string, string>>

    for (const site of targets) {
      if (site.file === file) json[site.section]![site.name] = 'catalog:'
    }

    // Keep the file's own indentation so the rewrite is a one-line diff per dependency.
    const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? '  '

    await fs.writeFile(filePath, `${JSON.stringify(json, null, indent)}\n`, 'utf-8')
  }

  return files
}

/**
 * Root-only `dependency drift` rows. With `fix`, kind (a) is rewritten first and the rows report
 * the post-fix state (the `eslint --fix` model the rest of `audit --fix` follows).
 */
export const checkFleetDrift = async (
  root: string,
  fix: boolean,
  current: string = packageJson.version,
): Promise<{ checks: PackageCheck[]; rewritten: string[] }> => {
  const catalogs = await readCatalogs(root)
  const before = await collectSites(root)
  const rewritten = fix ? await rewriteToCatalog(root, before, catalogs) : []
  const sites = rewritten.length > 0 ? await collectSites(root) : before

  return { checks: findFleetDrift(sites, catalogs, current), rewritten }
}
