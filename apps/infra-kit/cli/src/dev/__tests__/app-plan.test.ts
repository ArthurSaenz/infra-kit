import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { planAppRun } from '../app-plan'

let root: string

const uiWithRoutes = (app: string, routes: Record<string, unknown>) => {
  const dir = path.join(root, 'apps', app, 'ui')

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'infra-kit.config.ts'),
    `export default ${JSON.stringify({
      deployedUrlEnv: `${app.toUpperCase()}_URL`,
      dev: { proxy: { templates: { local: 'https://<release>.<packageName>.localhost' }, routes } },
    })}\n`,
  )

  return { name: app, path: dir }
}

const apis = [
  { name: 'backoffice', packageName: 'backend-api' },
  { name: 'cronjobs', packageName: 'cronjob-api' },
  { name: 'metasearch', packageName: 'metasearch-api' },
]

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-app-plan-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('planAppRun', () => {
  it('runs the UI, its own api, and every backend a local-capable route names — pinned local', async () => {
    const ui = uiWithRoutes('backoffice', {
      '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
      '/api/v1/cronjob': { packageName: 'cronjob-api', from: ['local', 'cloud'], default: 'cloud' },
      '/media': { packageName: 'backend-api', from: ['cloud'] },
    })

    const plan = await planAppRun('backoffice', apis, [ui])

    expect(plan).toEqual({
      preset: {
        apps: {
          'backoffice/api': {},
          'cronjobs/api': {},
          'backoffice/ui': { proxy: { '/api': 'local', '/api/v1/cronjob': 'local' } },
        },
      },
      unprovided: [],
    })
  })

  it('leaves a local-capable route with no backend in the repo on cloud, and names it', async () => {
    const ui = uiWithRoutes('client', {
      '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
      '/sdk': { packageName: 'sdk-handler', from: ['local', 'cloud'], default: 'cloud' },
    })

    const plan = await planAppRun('client', apis, [ui])

    expect(plan?.preset.apps).toEqual({
      'backoffice/api': {},
      'client/ui': { proxy: { '/api': 'local' } },
    })
    expect(plan?.unprovided).toEqual(['/sdk (sdk-handler)'])
  })

  it('runs an api-only app on its own', async () => {
    expect(await planAppRun('metasearch', apis, [])).toEqual({
      preset: { apps: { 'metasearch/api': {} } },
      unprovided: [],
    })
  })

  it('is null for a name that is no app', async () => {
    expect(await planAppRun('clientLocal', apis, [])).toBeNull()
  })
})
