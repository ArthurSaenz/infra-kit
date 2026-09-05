import fs from 'node:fs'
import path from 'node:path'

// Deep loader path, NOT the `src/lib/package-validator` barrel. That barrel pulls in
// `package-validator.ts` → `checks/index` → `agent-guidance-check` → this module, a real
// runtime cycle. The loader subtree imports nothing from `agent-guidance`, so this edge is safe.
import { discoverPackages } from 'src/lib/package-validator/loader'

import { inspectPackageGuidance } from './inspect'
import { readGuidanceFile } from './read-guidance-file'

/** The pnpm workspace manifest whose presence defines the workspace root. */
const WORKSPACE_FILE = 'pnpm-workspace.yaml'

/** The per-package guidance file the adoption probe looks for. */
const GUIDANCE_FILE = 'CLAUDE.md'

/**
 * Whether this workspace has adopted per-package guidance blocks, and the evidence for it.
 *
 * Adoption is inferred from working-tree state: at least one discovered workspace package
 * already carries a well-formed package block. It is deliberately not a bare boolean —
 * the post-adoption `missing` message has to name the package that switched enforcement on,
 * and `workspaceRoot` rides in both variants so that path can be relativized.
 */
export type AdoptionState =
  { adopted: true; workspaceRoot: string; evidencePath: string } | { adopted: false; workspaceRoot: string | null }

/**
 * Walk upward from `start` to the nearest directory holding a `pnpm-workspace.yaml`.
 * Returns `null` when there is none — a per-package `audit` run outside a pnpm workspace
 * is simply never adopted rather than an error.
 *
 * @example
 * findWorkspaceRoot('/repo/apps/client/ui/src')
 * // => '/repo'
 * @example
 * findWorkspaceRoot('/tmp/loose-package')
 * // => null
 */
export const findWorkspaceRoot = (start: string): string | null => {
  let current = path.resolve(start)

  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, WORKSPACE_FILE))) return current

    current = path.dirname(current)
  }

  return fs.existsSync(path.join(current, WORKSPACE_FILE)) ? current : null
}

/** Per-process memo, keyed by workspace root so a second root in the same process is probed afresh. */
const adoptionByRoot = new Map<string, AdoptionState>()

/**
 * Drop the memoized adoption verdicts. Tests only — a real run resolves one workspace and
 * the memo is what keeps a 27-package `audit --all` from re-probing 27 times.
 *
 * @example
 * resetAdoptionCache()
 * // the next resolveAdoption() call re-reads the filesystem
 */
export const resetAdoptionCache = (): void => {
  adoptionByRoot.clear()
}

/**
 * The uncached probe: the first discovered package (packages come back sorted) whose
 * `CLAUDE.md` inspects as `ok` is the adoption evidence. A malformed or foreign block is
 * explicitly not adoption — a half-pasted marker pair must not switch enforcement on.
 */
const probeAdoption = async (workspaceRoot: string): Promise<AdoptionState> => {
  let packageDirs: string[]

  try {
    // `discoverPackages` reads the workspace file with an unguarded readFile + yaml.parse,
    // so proving the file exists does not prove it parses. Any throw degrades to unadopted.
    packageDirs = await discoverPackages(workspaceRoot)
  } catch {
    return { adopted: false, workspaceRoot }
  }

  for (const packageDir of packageDirs) {
    const guidancePath = path.join(packageDir, GUIDANCE_FILE)
    const content = readGuidanceFile(guidancePath)

    if (content === null) continue

    if (inspectPackageGuidance(content).state === 'ok') {
      return { adopted: true, workspaceRoot, evidencePath: guidancePath }
    }
  }

  return { adopted: false, workspaceRoot }
}

/**
 * Resolve whether `workspaceRoot`'s workspace has adopted package guidance blocks,
 * memoized per process. A `null` root (no `pnpm-workspace.yaml` above the target) is
 * never adopted, and needs no probe.
 *
 * @example
 * await resolveAdoption('/repo')
 * // => { adopted: true, workspaceRoot: '/repo', evidencePath: '/repo/apps/client/ui/CLAUDE.md' }
 * @example
 * await resolveAdoption(null)
 * // => { adopted: false, workspaceRoot: null }
 */
export const resolveAdoption = async (workspaceRoot: string | null): Promise<AdoptionState> => {
  if (workspaceRoot === null) return { adopted: false, workspaceRoot: null }

  const memoized = adoptionByRoot.get(workspaceRoot)

  if (memoized) return memoized

  const state = await probeAdoption(workspaceRoot)

  adoptionByRoot.set(workspaceRoot, state)

  return state
}
