import fs from 'node:fs'
import path from 'node:path'

/**
 * Every package that can supply the `infraKitDev` helper, with the lowest version of THAT package this CLI
 * can run against, and what an older one gets wrong.
 *
 * A LIST, and each floor is a point on ITS OWN package's version line — never comparable across entries.
 * Keep them all, check whichever the repo actually resolves, and only drop the `infra-kit` entry once no
 * consumer imports `infra-kit/vite` any more. Consumed by {@link assertHelperVersionFloor}.
 */
// Why the guard exists at all: skew here is GUARANTEED rather than hypothetical. The CLI is installed
// globally and self-updates silently, while the helper is PINNED in each consumer's `node_modules`, so a
// new CLI routinely meets an old helper. An old helper ignores `origin` and rebuilds the target from the
// consumer's `templates.local` — which still says `http://` — and then proxies plain HTTP at a TLS
// listener. That failure is silent (portless answers :80 with a 302 rather than refusing), so nothing
// downstream would catch it. Refuse at start instead.
//
// Why a list, spelled out: this is the whole subtlety of the `infra-kit` → `@slip-stream-kit/config`
// split, and getting it wrong fails silently in both directions.
// - Comparing the new package's version against the OLD package's floor (`0.1.132`) is meaningless. The
//   two are unrelated version lines; a new package seeded low would throw for every consumer, and one
//   seeded high would pass vacuously — a dead guard that still looks alive.
// - Simply RE-KEYING the guard to the new package (rather than adding to it) drops the old entry, and
//   then a not-yet-migrated consumer — the exact population still running an old helper — silently stops
//   being checked at all.
// The packages release in LOCKSTEP, which is what keeps each floor comparable to the CLI's own version as
// the wire evolves.
//
// `@slip-stream-kit/vite` (the plugin) needs its OWN entry even though it only wraps
// `@slip-stream-kit/config`, and the reason is pnpm's layout rather than style: a consumer on the plugin
// declares only the plugin, so `config` is a TRANSITIVE dep living in the virtual store — it resolves
// from neither the app dir nor the repo root, and `assertHelperVersionFloor` would find nothing to check
// and skip the repo entirely. The plugin's own `dependencies` pin the config version exactly
// (`workspace:*` publishes as the released version), so checking the plugin checks the pair.
// 0.15.0 is the first `@slip-stream-kit/config` whose `infraKitE2e()` aims at the repo-scoped
// `<release>.<package>.<repo>.localhost` alias. An older one points Playwright at the repo-less host, which
// this CLI no longer registers, or which another repo's older CLI still does: the collision this fixes.
// The plugin pins config exactly, so it shares the floor. `infra-kit` ships no Playwright helper.
const REPO_ALIAS_WHY =
  'dev aliases are now scoped by repo (`<release>.<package>.<repo>.localhost`), and only that helper aims ' +
  'Playwright at them. An older one would test whatever another repo serves on the old repo-less host.'

const HTTPS_WHY =
  'dev URLs are now HTTPS, and only that `infraKitDev` helper understands them. An older one would proxy ' +
  'plain HTTP at a TLS listener, silently.'

export const HELPER_PACKAGES = [
  { name: '@slip-stream-kit/vite', floor: '0.15.0', why: REPO_ALIAS_WHY },
  { name: '@slip-stream-kit/config', floor: '0.15.0', why: REPO_ALIAS_WHY },
  { name: 'infra-kit', floor: '0.1.132', why: HTTPS_WHY },
] as const

/** `true` when `version` sorts strictly below `floor` (numeric, dot-separated; missing parts are 0). */
export const isBelowVersion = (version: string, floor: string): boolean => {
  const parse = (v: string): number[] => {
    return v.split('.').map((part) => {
      return Number.parseInt(part, 10) || 0
    })
  }

  const a = parse(version)
  const b = parse(floor)

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0

    if (left !== right) return left < right
  }

  return false
}

/** Package dirs whose manifest may declare a helper: the repo root, plus every `apps/<app>/{api,ui}`. */
const manifestDirs = (repoRoot: string): string[] => {
  const dirs = [repoRoot]

  try {
    for (const app of fs.readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })) {
      if (!app.isDirectory()) continue
      for (const part of ['api', 'ui']) dirs.push(path.join(repoRoot, 'apps', app.name, part))
    }
  } catch {
    // No `apps/` dir — the root manifest alone decides.
  }

  return dirs
}

/** Does `<dir>/package.json` declare `name` in dependencies or devDependencies? */
const declaresPackage = (dir: string, name: string): boolean => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<
      string,
      Record<string, string> | undefined
    >

    return ['dependencies', 'devDependencies'].some((field) => {
      return pkg[field]?.[name] != null
    })
  } catch {
    return false
  }
}

/**
 * Find the installed `name` by walking `node_modules` UPWARD from `fromDir`, exactly as Node resolves it.
 *
 * Probing `<repoRoot>/node_modules/<name>` alone — which is what this used to do — is wrong under pnpm,
 * and wrong in the direction that hurts. pnpm does NOT hoist a workspace package's dependency to the root:
 * a dep declared in `apps/client/ui/package.json` lands in `apps/client/ui/node_modules/`, and the root has
 * no trace of it. So the root-only probe would (a) fail to find — and therefore never version-check — a
 * helper declared where it is actually USED (next to the `vite.config.ts` that imports it), and (b) once
 * the consumer drops root `infra-kit` for the global CLI, report the correctly-installed helper as
 * "missing" and tell the user to run `pnpm install`, which can never fix it. Resolve it the way Node does.
 */
const findHelperDir = (repoRoot: string, fromDir: string, name: string): string | undefined => {
  const segments = name.split('/')
  let dir = fromDir

  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...segments)

    if (fs.existsSync(candidate)) return candidate

    const parent = path.dirname(dir)

    if (dir === repoRoot || parent === dir) return undefined
    dir = parent
  }
}

/**
 * `true` when `<repoRoot>/node_modules/<name>` is a workspace link back into this repo rather than a
 * published install.
 *
 * Resolves BOTH sides before comparing: on macOS a temp path realpaths from `/var` to `/private/var`, so
 * an unresolved root would never contain a resolved child and a workspace link would be misread as a
 * published install.
 */
const isWorkspaceLinked = (repoRoot: string, helperDir: string): boolean => {
  try {
    const real = fs.realpathSync(helperDir)
    const root = fs.realpathSync(repoRoot)

    return real.startsWith(root + path.sep) && !real.includes(`${path.sep}node_modules${path.sep}`)
  } catch {
    return false
  }
}

/** `realpath`, falling back to the input when it cannot be resolved (used only as a dedupe key). */
const safeRealpath = (target: string): string => {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/** Enforce one helper package's floor against ONE resolved install directory. */
const assertFloorAt = (repoRoot: string, helper: (typeof HELPER_PACKAGES)[number], helperDir: string): void => {
  const { name, floor, why } = helper

  // In this repo `node_modules/@slip-stream-kit/config` symlinks to `apps/infra-kit/config`, whose
  // version is the unreleased working tree. Enforcing a floor there would brick `infra-kit dev` on the
  // very repo that develops it.
  if (isWorkspaceLinked(repoRoot, helperDir)) return

  let version: string

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(helperDir, 'package.json'), 'utf-8')) as { version?: string }

    if (typeof pkg.version !== 'string') throw new TypeError('no version field')
    version = pkg.version
  } catch {
    throw new Error(
      `infra-kit dev: could not read the version of the pinned \`${name}\` helper (${helperDir}). Refusing ` +
        `to start rather than risk proxying plain HTTP at a TLS listener. Run \`pnpm install\`.`,
    )
  }

  if (isBelowVersion(version, floor)) {
    throw new Error(
      `infra-kit dev: this repo pins ${name} ${version}; bump ${name} to >=${floor}. From ${floor} on, ${why}\n` +
        `    pnpm add -D ${name}@^${floor}`,
    )
  }
}

/**
 * Refuse to start against a consumer-pinned `infraKitDev` helper too old to understand the dev-context
 * fragment's `origin` field, or the repo-scoped alias — whichever package that helper comes from (see {@link HELPER_PACKAGES}).
 *
 * Every helper package is checked INDEPENDENTLY, and every place it resolves from is checked (see
 * {@link findHelperDir}). Three outcomes per package:
 * - **Workspace-linked → SKIP** (that install only; every other one is still checked).
 * - **Declared but unresolvable → THROW (fail closed).** The consumer says it uses a helper and we
 *   cannot prove which version; guessing is how the silent case ships.
 * - **Neither installed nor declared → SKIP.** Nothing to be skewed against. (This is also what keeps
 *   bare test fixtures runnable.)
 */
// Two migration shapes make the per-package, per-location sweep necessary rather than fussy:
// - A repo mid-migration has BOTH (`@slip-stream-kit/config` added, `infra-kit` not yet dropped), and its
//   vite configs may still import from either. Stopping at the first helper that passes would hand exactly
//   that repo a silent HTTP-into-TLS proxy from the other one.
// - Under pnpm the helper usually resolves NOT from the repo root but from the package that declares it —
//   `apps/client/ui/node_modules/` sits right next to the `vite.config.ts` that imports it.
export const assertHelperVersionFloor = (repoRoot: string): void => {
  const dirs = manifestDirs(repoRoot)

  for (const helper of HELPER_PACKAGES) {
    const { name } = helper

    const declaredIn = dirs.filter((dir) => {
      return declaresPackage(dir, name)
    })

    // Always probe the root too: a helper can be present without being declared (hoisted, or a transitive
    // of something else), and it would still be the one vite resolves.
    const resolved = new Map<string, string>()

    for (const dir of [...declaredIn, repoRoot]) {
      const found = findHelperDir(repoRoot, dir, name)

      // Key by realpath: several packages symlinking into the same pnpm store entry are ONE install, and
      // re-reading it per app would just multiply identical work (and identical error messages).
      if (found) resolved.set(safeRealpath(found), found)
    }

    if (resolved.size === 0) {
      if (declaredIn.length === 0) continue

      throw new Error(
        `infra-kit dev: ${declaredIn[0]}/package.json depends on ${name} but it does not resolve from there, ` +
          `so the \`infraKitDev\` helper version cannot be verified. Run \`pnpm install\`.`,
      )
    }

    for (const helperDir of resolved.values()) assertFloorAt(repoRoot, helper, helperDir)
  }
}
