/**
 * What the five external tools are, how to recognise an existing install, and the exact argv that
 * installs or updates each one. Pure data and pure predicates: no `fs`, no `spawn`, no `process.env`
 * read, matching `lib/install-manager`'s discipline, so the whole matrix is table-testable.
 *
 * Nothing here executes anything. `lib/dependency-install` is the only module that spawns, and it
 * decides what may run from {@link Recipe.needsSudo} and {@link Recipe.fetchesNetworkScript} — the two
 * literals declared below and derived from nothing.
 */
import { hasSegment, isBrewKegOf, npmPrefixOfPackage } from 'src/lib/install-manager'
import type { InstallManager } from 'src/lib/install-manager'

export type DependencyId = 'brew' | 'aws' | 'gh' | 'doppler' | 'portless'

/**
 * `install-manager`'s classification plus `script`, which it has no reason to know about: the
 * AWS-documented installer unpacks into `~/.local/share/aws-cli` and is owned by no package manager at
 * all. Without this it would classify as `unknown`, and `unknown` means "print, never execute" — which
 * would make `aws update`, a safe no-sudo no-network-script recipe, permanently unreachable.
 */
export type DependencyManager = InstallManager | 'script'

/**
 * One executable step list, plus the two static risk literals.
 *
 * `needsSudo` and `fetchesNetworkScript` are properties of the RECIPE, set here and never derived from
 * a probe. That is what makes the risk predicate non-circular: both dangerous recipes fail on these two
 * conjuncts, so refusing them never depends on detection having been right. See the plan's §5.2.
 */
export interface Recipe {
  /** Run in order. Two steps only for doppler, whose signature verification needs `gnupg` first. */
  steps: string[][]
  needsSudo: boolean
  fetchesNetworkScript: boolean
}

/**
 * FIVE separate name fields, because for these tools the identifiers diverge and one `packageName`
 * would generate the very bug the registry exists to prevent: aws's binary is `aws` but its formula is
 * `awscli`, so a conflated name emits `brew upgrade aws` — a formula that does not exist.
 */
export interface DependencySpec {
  id: DependencyId
  /** The executable on `PATH`. */
  binName: string
  /** The Homebrew formula, when brew can own it. Absent for `brew` itself and for `portless`. */
  brewFormula?: string
  /** What `brew install` is given — differs from the formula when the formula lives in a tap. */
  brewInstallSpec?: string
  /** The directory under `Cellar/`. Equals the formula, NOT the tap: `Cellar/doppler`, not `dopplerhq`. */
  kegName?: string
  /** The npm package name, when npm can own it. */
  npmPackage?: string
  probeArgv: string[]
  versionFrom: (stdout: string) => string | null
  platforms: NodeJS.Platform[]
  /** Ids that must be present first. `gnupg` is NOT one — it has no spec of its own (see below). */
  prerequisites: DependencyId[]
  /** How to install when the tool is ABSENT. Distinct from `recipesFor`, which answers for an existing install. */
  bootstrapInstall: Recipe
  /** Which manager owns this binary, read from its resolved path alone. */
  identify: (binRealPath: string) => DependencyManager
  /** The update recipe for an existing install, or null when this manager must not be updated by us. */
  updateFor: (manager: DependencyManager) => Recipe | null
}

/** A recipe that runs a package manager already on the box: no privilege escalation, no piped script. */
const managed = (...steps: string[][]): Recipe => {
  return { steps, needsSudo: false, fetchesNetworkScript: false }
}

/**
 * First dotted version in the tool's `--version` output.
 *
 * Quantifiers are BOUNDED rather than `+`: this runs over whatever a third-party binary printed, and an
 * unbounded `\d+\.\d+\.\d+` backtracks super-linearly on a long digit run.
 */
const firstVersion = (stdout: string): string | null => {
  return /\d{1,10}\.\d{1,10}\.\d{1,10}/.exec(stdout)?.[0] ?? null
}

const UNIX: NodeJS.Platform[] = ['darwin', 'linux']

/**
 * Classify by keg, reading the spec's OWN `kegName`.
 *
 * A helper rather than a literal per row: with the names restated inline, editing `kegName` changed no
 * behaviour and the test pinning it guarded nothing.
 */
const brewKegIdentify = (kegName: string): DependencySpec['identify'] => {
  return (binRealPath) => {
    return isBrewKegOf(binRealPath, kegName) ? 'homebrew' : 'unknown'
  }
}

/** `brew upgrade <formula>` — the FORMULA, never the binary and never the tap-qualified install spec. */
const brewUpgradeFor = (brewFormula: string): DependencySpec['updateFor'] => {
  return (manager) => {
    return manager === 'homebrew' ? managed(['brew', 'upgrade', brewFormula]) : null
  }
}

const BREW: DependencySpec = {
  id: 'brew',
  binName: 'brew',
  probeArgv: ['brew', '--version'],
  versionFrom: firstVersion,
  platforms: UNIX,
  prerequisites: [],
  // The one recipe that can never run from here. It pipes a script fetched over the network into bash
  // AND needs sudo on macOS, so it fails BOTH static conjuncts — refused by computation, not by prose.
  // Homebrew's own install.sh sets NONINTERACTIVE=1 when stdin is not a TTY and then probes sudo with
  // `sudo -n`, which never prompts: off a TTY it aborts or succeeds depending on whether an unrelated
  // earlier command left a sudo timestamp cached. We never set NONINTERACTIVE ourselves.
  bootstrapInstall: {
    steps: [['/bin/bash', '-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)']],
    needsSudo: true,
    fetchesNetworkScript: true,
  },
  identify: (binRealPath) => {
    return hasSegment(binRealPath, 'Homebrew') || hasSegment(binRealPath, 'homebrew') ? 'homebrew' : 'unknown'
  },
  updateFor: (manager) => {
    return manager === 'homebrew' ? managed(['brew', 'update']) : null
  },
}

// aws is the row that proves the fields must stay separate: the BINARY is `aws`, the FORMULA `awscli`.
// One conflated name emits `brew upgrade aws`, a formula that does not exist.
const AWS_NAMES = { brewFormula: 'awscli', brewInstallSpec: 'awscli', kegName: 'awscli' } as const

const AWS: DependencySpec = {
  id: 'aws',
  binName: 'aws',
  ...AWS_NAMES,
  probeArgv: ['aws', '--version'],
  versionFrom: firstVersion,
  platforms: UNIX,
  prerequisites: [],
  // The AWS-documented path for macOS and Linux alike. It needs NO sudo (user scope, `$HOME/.local`),
  // but it is still a script fetched over the network, so it fails that conjunct and is printed.
  // We never pass `--system`, which is the sudo variant.
  bootstrapInstall: {
    steps: [['/bin/bash', '-c', 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash']],
    needsSudo: false,
    fetchesNetworkScript: true,
  },
  identify: (binRealPath) => {
    if (isBrewKegOf(binRealPath, AWS_NAMES.kegName)) return 'homebrew'
    // `~/.local/share/aws-cli/...` — the installer's own layout, owned by no package manager.
    if (hasSegment(binRealPath, 'aws-cli')) return 'script'

    return 'unknown'
  },
  updateFor: (manager) => {
    if (manager === 'homebrew') return managed(['brew', 'upgrade', AWS_NAMES.brewFormula])
    // The vendor's own updater, correct ONLY for a script install. Running it against a keg is the
    // split-brain `install-manager` already refuses for infra-kit itself.
    if (manager === 'script') return managed(['aws', 'update'])

    return null
  },
}

const GH_NAMES = { brewFormula: 'gh', brewInstallSpec: 'gh', kegName: 'gh' } as const

const GH: DependencySpec = {
  id: 'gh',
  binName: 'gh',
  ...GH_NAMES,
  probeArgv: ['gh', '--version'],
  versionFrom: firstVersion,
  platforms: UNIX,
  prerequisites: ['brew'],
  bootstrapInstall: managed(['brew', 'install', GH_NAMES.brewInstallSpec]),
  identify: brewKegIdentify(GH_NAMES.kegName),
  updateFor: brewUpgradeFor(GH_NAMES.brewFormula),
}

// The tap-qualified spec `brew install` is given. The KEG it lands in is `Cellar/doppler` — asking
// `isBrewKegOf(path, 'dopplerhq')` would miss every real install, which is why these are three fields
// and not one, and why the helpers below read them rather than restating literals.
const DOPPLER_NAMES = { brewFormula: 'doppler', brewInstallSpec: 'dopplerhq/cli/doppler', kegName: 'doppler' } as const

const DOPPLER: DependencySpec = {
  id: 'doppler',
  binName: 'doppler',
  ...DOPPLER_NAMES,
  probeArgv: ['doppler', '--version'],
  versionFrom: firstVersion,
  platforms: UNIX,
  // `gnupg` is a real prerequisite (binary signature verification) and is ORDERED as the first step of
  // the recipe rather than assumed. It is deliberately not a `DependencyId`: it has no probe of its own
  // here, and its binary (`gpg`) and formula (`gnupg`) diverge, so a spec row for it would be a fifth
  // set of names carried for one `brew install` line.
  prerequisites: ['brew'],
  bootstrapInstall: managed(['brew', 'install', 'gnupg'], ['brew', 'install', DOPPLER_NAMES.brewInstallSpec]),
  identify: brewKegIdentify(DOPPLER_NAMES.kegName),
  // `brew upgrade doppler`, never `doppler update`, for a keg: the vendor self-updater against a
  // brew-managed binary is the same split-brain as running npm against a Homebrew install.
  updateFor: brewUpgradeFor(DOPPLER_NAMES.brewFormula),
}

const PORTLESS_PACKAGE = 'portless'

const PORTLESS: DependencySpec = {
  id: 'portless',
  binName: PORTLESS_PACKAGE,
  npmPackage: PORTLESS_PACKAGE,
  probeArgv: ['portless', '--version'],
  versionFrom: firstVersion,
  platforms: [...UNIX, 'win32'],
  prerequisites: [],
  // Q1, recorded rather than assumed: a GLOBAL portless does not fix the case this repo actually hits.
  // portless is a `node_modules` dependency here and is never on `PATH` under `sudo` (secure_path), which
  // is why the codebase prints `<node> <abs cli.js>` via `formatPortlessCommand`. A global install helps
  // interactive use and repos that do not depend on infra-kit; it changes nothing about the sudo case.
  bootstrapInstall: managed(['npm', 'install', '-g', PORTLESS_PACKAGE]),
  identify: (binRealPath) => {
    return npmPrefixOfPackage(binRealPath, PORTLESS_PACKAGE) === null ? 'unknown' : 'npm'
  },
  updateFor: (manager) => {
    return manager === 'npm' ? managed(['npm', 'install', '-g', `${PORTLESS_PACKAGE}@latest`]) : null
  },
}

/** Every spec, keyed by id. The single source of the probe argv `doctor` also reads. */
export const DEPENDENCY_SPECS: Record<DependencyId, DependencySpec> = {
  brew: BREW,
  aws: AWS,
  gh: GH,
  doppler: DOPPLER,
  portless: PORTLESS,
}

export const DEPENDENCY_IDS = Object.keys(DEPENDENCY_SPECS) as DependencyId[]

export const specFor = (id: DependencyId): DependencySpec => {
  return DEPENDENCY_SPECS[id]
}

/** Is this tool installable on `platform` at all? Every brew path is macOS/Linuxbrew only. */
export const supportsPlatform = (spec: DependencySpec, platform: NodeJS.Platform): boolean => {
  return spec.platforms.includes(platform)
}

/**
 * The ids in an order where every prerequisite precedes its dependents (depth-first, stable).
 * The graph is five nodes and acyclic by construction; a cycle would recurse, so `seen` is what makes
 * a hand-edit that introduces one fail loudly here rather than hang.
 */
export const installOrder = (ids: readonly DependencyId[]): DependencyId[] => {
  const ordered: DependencyId[] = []
  const seen = new Set<DependencyId>()

  const visit = (id: DependencyId, stack: readonly DependencyId[]): void => {
    if (stack.includes(id)) throw new Error(`dependency cycle: ${[...stack, id].join(' -> ')}`)
    if (seen.has(id)) return

    seen.add(id)
    for (const prerequisite of specFor(id).prerequisites) visit(prerequisite, [...stack, id])
    ordered.push(id)
  }

  for (const id of ids) visit(id, [])

  return ordered
}
