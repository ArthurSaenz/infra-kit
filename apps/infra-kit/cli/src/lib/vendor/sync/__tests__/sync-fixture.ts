import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { applyTargetPlan, buildTargetPlan, probeSource, probeTarget } from 'src/lib/vendor/sync'
import type { ApplyResult, SourceFacts, SyncSpec, TargetPlan } from 'src/lib/vendor/sync'

/**
 * Real-git fixture for the `vendor sync` integration tests: one source repo and two target repos, built with
 * `git init` in a temp dir, so the tests exercise the real probe, copy and commit code rather than a fake.
 */

export const SPEC: SyncSpec = {
  copy: [
    { path: '.claude' },
    { path: '.agents/skills/shadcn' },
    { path: 'vendor/configs' },
    { path: 'vendor/packages' },
  ],
  exclude: ['serverless-config'],
}

export const HOOKS = ['.claude/hooks/pre-bash.sh', '.claude/hooks/post-edit.sh', '.claude/hooks/stop.sh']
export const LINK_PATH = '.claude/skills/shadcn'
export const LINK_TEXT = '../../.agents/skills/shadcn'
export const IGNORED_SOURCE_FILE = '.claude/scheduled_tasks.lock'
export const OBSOLETE_FILE = '.claude/obsolete/old.md'
export const ESLINT_INDEX = 'vendor/configs/eslint-config/index.js'
export const EXCLUDED_SOURCE_FILE = 'vendor/configs/serverless-config/handler.ts'
export const CONSUMER_SERVERLESS = 'vendor/configs/serverless-config/serverless.yml'
export const ROUTE_ID = 'vendor/packages/docs-ui/src/routes/[id].tsx'
export const ROUTE_I = 'vendor/packages/docs-ui/src/routes/i.tsx'
export const PLANTED_IGNORED = ['node_modules/x', 'dist/x', '.omc/x', 'coverage/x'].map((rel) => {
  return `vendor/configs/eslint-config/${rel}`
})

/** Every tracked, non-excluded source file the copy must deliver byte-identical. */
export const SOURCE_TRACKED = [
  '.claude/settings.json',
  '.claude/CLAUDE.md',
  OBSOLETE_FILE,
  ...HOOKS,
  '.agents/skills/shadcn/SKILL.md',
  '.agents/skills/shadcn/rules/forms.md',
  ESLINT_INDEX,
  'vendor/configs/eslint-config/package.json',
  ROUTE_ID,
  ROUTE_I,
]

// The machine's global/system git config (hooks, signing, templates) must not reach any git call, the
// library's included: zx inherits `process.env`, so the vars are set on the process for the suite's lifetime.
const ISOLATED_ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const LEAKY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']

/** Isolate git from the machine's config; returns the restore function. */
export const isolateGitEnv = (): (() => void) => {
  const keys = [...Object.keys(ISOLATED_ENV), ...LEAKY_ENV]
  const saved = new Map(
    keys.map((key) => {
      return [key, process.env[key]]
    }),
  )

  for (const key of LEAKY_ENV) delete process.env[key]

  Object.assign(process.env, ISOLATED_ENV)

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// Absolute, not `git` off PATH: sonarjs/no-os-command-from-path.
const GIT_BIN = '/usr/bin/git'

export const git = (cwd: string, args: string[]): string => {
  return execFileSync(GIT_BIN, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export const writeFile = (root: string, rel: string, content: string, mode = 0o644): void => {
  const full = path.join(root, rel)

  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  // eslint-disable-next-line sonarjs/file-permissions -- the fixture's hooks must be 0o755: mode survival is under test
  fs.chmodSync(full, mode)
}

export const readBytes = (root: string, rel: string): Buffer => {
  return fs.readFileSync(path.join(root, rel))
}

export const exists = (root: string, rel: string): boolean => {
  return fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false }) !== undefined
}

export const commitAll = (root: string, message: string): void => {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
}

const initRepo = (root: string): void => {
  fs.mkdirSync(root, { recursive: true })
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['config', 'user.email', 'fixture@example.com'])
  git(root, ['config', 'commit.gpgsign', 'false'])
}

const buildSource = (root: string): void => {
  initRepo(root)
  writeFile(root, '.gitignore', `${IGNORED_SOURCE_FILE}\n`)
  writeFile(root, '.claude/settings.json', '{ "hooks": {} }\n')
  writeFile(root, '.claude/CLAUDE.md', '# rules\n')
  writeFile(root, OBSOLETE_FILE, 'going away\n')

  for (const hook of HOOKS) writeFile(root, hook, `#!/bin/sh\necho ${path.basename(hook)}\n`, 0o755)

  writeFile(root, IGNORED_SOURCE_FILE, 'pid 123\n')
  writeFile(root, '.agents/skills/shadcn/SKILL.md', '# shadcn\n')
  writeFile(root, '.agents/skills/shadcn/rules/forms.md', 'forms\n')
  fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true })
  fs.symlinkSync(LINK_TEXT, path.join(root, LINK_PATH))
  writeFile(root, ESLINT_INDEX, 'module.exports = {}\n')
  writeFile(root, 'vendor/configs/eslint-config/package.json', '{ "name": "eslint-config" }\n')
  writeFile(root, EXCLUDED_SOURCE_FILE, 'export const handler = 1\n')
  writeFile(root, ROUTE_ID, 'export const Id = 1\n')
  writeFile(root, ROUTE_I, 'export const I = 1\n')
  commitAll(root, 'source: initial')
}

const TARGET_GITIGNORE = 'node_modules/\ndist/\n.omc/\ncoverage/\n'

const buildTarget = (root: string, consumerOwned: boolean): void => {
  initRepo(root)
  writeFile(root, 'README.md', `# ${path.basename(root)}\n`)
  writeFile(root, '.gitignore', TARGET_GITIGNORE)

  if (consumerOwned) writeFile(root, CONSUMER_SERVERLESS, 'service: consumer-owned\n')

  commitAll(root, 'target: initial')

  if (consumerOwned) {
    for (const rel of PLANTED_IGNORED) writeFile(root, rel, `ignored ${rel}\n`)
  }
}

export interface Fixture {
  tmp: string
  source: string
  targetA: string
  /** Holds a tracked consumer-owned `serverless-config` file and planted ignored files under `vendor/`. */
  targetB: string
  cleanup: () => void
}

export const buildFixture = (): Fixture => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-sync-it-'))
  const source = path.join(tmp, 'source')
  const targetA = path.join(tmp, 'target-a')
  const targetB = path.join(tmp, 'target-b')

  buildSource(source)
  buildTarget(targetA, false)
  buildTarget(targetB, true)

  return {
    tmp,
    source,
    targetA,
    targetB,
    cleanup: () => {
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

export interface PreviewResult {
  source: SourceFacts
  plan: TargetPlan
}

export const preview = async (
  sourceRoot: string,
  targetRoot: string,
  spec: SyncSpec = SPEC,
): Promise<PreviewResult> => {
  const source = await probeSource(sourceRoot, spec)
  const facts = await probeTarget(source, { name: path.basename(targetRoot), root: targetRoot })

  return { source, plan: buildTargetPlan(source, facts) }
}

export interface SyncResult extends PreviewResult {
  result: ApplyResult
}

export const sync = async (
  sourceRoot: string,
  targetRoot: string,
  onBeforeFirstWrite?: (argv: string[]) => void,
): Promise<SyncResult> => {
  const { source, plan } = await preview(sourceRoot, targetRoot)
  const result = await applyTargetPlan({ source, plan, onBeforeFirstWrite })

  return { source, plan, result }
}

/** Run a printed argv the way a user pasting it would, with no shell in between. */
export const runArgv = (argv: readonly string[]): void => {
  const [command, ...args] = argv

  if (command !== 'git') throw new Error(`expected a git argv, got ${command ?? '(empty)'}`)

  execFileSync(GIT_BIN, args, { env: { ...process.env, ...ISOLATED_ENV }, stdio: 'pipe' })
}
