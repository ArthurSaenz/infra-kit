/**
 * Background auto-update worker. Spawned detached by `maybeAutoUpdate` as
 * `node dist/update-check.js --parent-pid <pid>`, and NEVER run by a human.
 *
 * This is a dedicated bundle, a sibling of `dist/cli.js`, for the same reason `dist/mcp.js` is: booting
 * `cli.js` here would re-run commander, the command catalog, `warnIfLocalInstall()`, and
 * `maybeAutoUpdate()` itself as top-level side effects — the last of which would spawn another child,
 * and another. Importing nothing from `src/entry/cli.ts` is a hard invariant, guarded by a test.
 *
 * It carries NO hashbang: nothing execs it directly, and `dist-shebang.test.ts` asserts its absence.
 * It writes nothing to stdout (it is spawned with `stdio: 'ignore'`, so there is nowhere to write).
 */
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Deep import, not the `src/lib/update-check` barrel: the barrel re-exports `maybeAutoUpdate`, which would
// drag the parent-side spawn path (and pino) into this worker's bundle for no reason.
import { runUpdateCheck } from 'src/lib/update-check/run-update-check'

import packageJson from '../../package.json' with { type: 'json' }

/** `--parent-pid <pid>`, or undefined when absent/malformed (then we install without waiting). */
const parseParentPid = (argv: string[]): number | undefined => {
  const index = argv.indexOf('--parent-pid')

  if (index === -1) return undefined

  const pid = Number(argv[index + 1])

  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** The installed `dist/cli.js` beside this bundle — the path whose owning package manager we detect. */
const selfRealPath = (): string => {
  return fs.realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)))
}

const main = async (): Promise<void> => {
  await runUpdateCheck(packageJson.version, {
    selfRealPath: selfRealPath(),
    parentPid: parseParentPid(process.argv),
  })
}

// A detached background worker must never surface a crash, a non-zero exit, or an unhandled rejection —
// there is no one to see it and nothing depends on it. `runUpdateCheck` already swallows its own
// failures; this is the last line of defence around path resolution and JSON import.
main().catch(() => {
  process.exitCode = 0
})
