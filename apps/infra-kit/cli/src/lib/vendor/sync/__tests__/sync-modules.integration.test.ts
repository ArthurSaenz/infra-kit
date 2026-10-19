import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { vendorCheck } from 'src/commands/vendor-check'
import { applyTargetPlan } from 'src/lib/vendor/sync'
import type { ModuleSelection, SyncSpec } from 'src/lib/vendor/sync'

import {
  ROUTE_I,
  ROUTE_ID,
  buildFixture,
  commitAll,
  exists,
  git,
  isolateGitEnv,
  preview,
  writeFile,
} from './sync-fixture'
import type { Fixture } from './sync-fixture'

const TIMEOUT_MS = 60_000

const MODULE_SPEC: SyncSpec = {
  copy: [
    { path: '.claude' },
    { path: 'vendor/configs' },
    { path: 'vendor/packages', module: 'docs' },
    { path: '.agents/skills/shadcn', module: 'skills' },
  ],
  exclude: ['serverless-config'],
}

const CORE_ONLY: ModuleSelection = { kind: 'modules', modules: [] }

let restoreEnv: () => void
let fx: Fixture

beforeAll(() => {
  restoreEnv = isolateGitEnv()
})

beforeEach(() => {
  fx = buildFixture()
})

afterEach(() => {
  fx.cleanup()
})

afterAll(() => {
  restoreEnv()
})

const syncAndCommit = async (selection?: ModuleSelection) => {
  const { source, plan } = await preview(fx.source, fx.targetA, MODULE_SPEC, selection)

  await applyTargetPlan({ source, plan })
  commitAll(fx.targetA, 'sync')

  return plan
}

describe('vendor sync — vendorTarget modules', () => {
  it(
    'prunes a dropped vendored module, leaves a dropped root path, and keeps vendor check green',
    async () => {
      await syncAndCommit()
      expect(exists(fx.targetA, ROUTE_ID)).toBe(true)
      writeFile(fx.targetA, 'vendor/packages/docs-ui/node_modules/x/index.js', 'ignored build output\n')

      const plan = await syncAndCommit(CORE_ONLY)
      const notes = plan.notes.join('\n')

      expect(plan.status).toBe('changed')
      expect(notes).toContain('vendor/packages: 0 added, 0 modified, 2 removed')
      expect(notes).toContain('run pnpm install')
      expect(notes).toContain('.agents/skills/shadcn: not in vendorTarget.modules, left in place')
      expect(exists(fx.targetA, ROUTE_ID)).toBe(false)
      expect(exists(fx.targetA, ROUTE_I)).toBe(false)
      expect(exists(fx.targetA, 'vendor/packages')).toBe(false)
      expect(exists(fx.targetA, '.agents/skills/shadcn/SKILL.md')).toBe(true)

      const { structuredContent } = await vendorCheck({ cwd: fx.targetA })

      expect(structuredContent).toMatchObject({ status: 'clean', ok: true })
    },
    TIMEOUT_MS,
  )

  it(
    'never copies an unselected module into a fresh target',
    async () => {
      await syncAndCommit({ kind: 'modules', modules: ['skills'] })

      expect(exists(fx.targetA, '.agents/skills/shadcn/SKILL.md')).toBe(true)
      expect(exists(fx.targetA, ROUTE_ID)).toBe(false)
      expect(exists(fx.targetA, 'vendor/configs/eslint-config/index.js')).toBe(true)
    },
    TIMEOUT_MS,
  )

  it(
    'fails the row when a target package still depends on a package the prune would delete',
    async () => {
      writeFile(fx.source, 'vendor/packages/docs-ui/package.json', '{ "name": "@wl/docs-ui" }\n')
      commitAll(fx.source, 'source: docs-ui manifest')
      await syncAndCommit()
      writeFile(fx.targetA, 'apps/web/package.json', '{ "dependencies": { "@wl/docs-ui": "workspace:*" } }\n')
      commitAll(fx.targetA, 'web uses docs-ui')

      const { plan } = await preview(fx.source, fx.targetA, MODULE_SPEC, CORE_ONLY)

      expect(plan.status).toBe('fail')
      expect(plan.notes.join('\n')).toContain(
        'apps/web/package.json depends on @wl/docs-ui: add "docs" to vendorTarget.modules',
      )
      expect(git(fx.targetA, ['status', '--porcelain'])).toBe('')
    },
    TIMEOUT_MS,
  )

  it(
    'fails the row when a root script or a deploy script still runs the package, but not on a prose mention',
    async () => {
      writeFile(fx.source, 'vendor/packages/docs-ui/package.json', '{ "name": "@wl/docs-ui" }\n')
      commitAll(fx.source, 'source: docs-ui manifest')
      await syncAndCommit()
      writeFile(fx.targetA, 'package.json', '{ "scripts": { "docs": "pnpm --filter @wl/docs-ui dev" } }\n')
      writeFile(fx.targetA, 'devops/deploy-docs.sh', 'pnpm exec turbo build --filter=@wl/docs-ui\n')
      writeFile(fx.targetA, 'README.md', 'The site lives in @wl/docs-ui.\n')
      writeFile(fx.targetA, 'ci.yml', 'run: pnpm --filter @wl/docs-ui-legacy build\n')
      commitAll(fx.targetA, 'docs site wiring')

      const { plan } = await preview(fx.source, fx.targetA, MODULE_SPEC, CORE_ONLY)

      expect(plan.status).toBe('fail')
      expect(plan.notes).toStrictEqual([
        'devops/deploy-docs.sh uses @wl/docs-ui: add "docs" to vendorTarget.modules or stop using it',
        'package.json script "docs" runs @wl/docs-ui: add "docs" to vendorTarget.modules or stop using it',
      ])
    },
    TIMEOUT_MS,
  )

  it(
    'fails the row on a module the source does not offer, naming the ones it does',
    async () => {
      const { plan } = await preview(fx.source, fx.targetA, MODULE_SPEC, { kind: 'modules', modules: ['dcos'] })

      expect(plan.status).toBe('fail')
      expect(plan.message).toBe(
        'vendorTarget: unknown module(s) dcos in vendorTarget.modules; the source offers: docs, skills',
      )
    },
    TIMEOUT_MS,
  )
})
