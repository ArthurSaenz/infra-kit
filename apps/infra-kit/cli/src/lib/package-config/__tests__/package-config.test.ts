import type { InfraKitPackageConfig } from '@slip-stream-kit/config'
import { describe, expect, it } from 'vitest'

import { DEFAULT_RULES, ROOT_DEFAULT_RULES, resolvePackageConfig } from '../package-config'

// The config-authoring surface (`defineConfig`, `packageConfigSchema`) moved to
// `@slip-stream-kit/config` and is tested there. What stays here is audit POLICY: the baselines and
// the merge that resolves a package's config against them.

describe('resolvePackageConfig', () => {
  it('falls back to defaults for every unset key', () => {
    const rules = resolvePackageConfig({})

    expect(rules.requiredScripts).toEqual(DEFAULT_RULES.requiredScripts)
    expect(rules.requiredFiles).toEqual(DEFAULT_RULES.requiredFiles)
  })

  it('replaces a key wholesale when provided, including an empty array opt-out', () => {
    const rules = resolvePackageConfig({ requiredScripts: [], requiredFiles: ['serverless.common.yml'] })

    expect(rules.requiredScripts).toEqual([])
    expect(rules.requiredFiles).toEqual(['serverless.common.yml'])
  })

  it('does not share the default array reference with the resolved result', () => {
    const rules = resolvePackageConfig({})

    rules.requiredScripts.push('mutated')

    expect(DEFAULT_RULES.requiredScripts).not.toContain('mutated')
  })

  it('falls back to the supplied baseline (root) for unset keys, including turbo tasks', () => {
    const rules = resolvePackageConfig({}, ROOT_DEFAULT_RULES)

    expect(rules.requiredScripts).toEqual(ROOT_DEFAULT_RULES.requiredScripts)
    expect(rules.turboTasks).toEqual(ROOT_DEFAULT_RULES.turboTasks)
  })

  it('lets a config override turbo.requiredTasks', () => {
    const rules = resolvePackageConfig({ turbo: { requiredTasks: ['build'] } }, ROOT_DEFAULT_RULES)

    expect(rules.turboTasks).toEqual(['build'])
  })

  it('defaults turboTasks to an empty array for packages', () => {
    const rules = resolvePackageConfig({})

    expect(rules.turboTasks).toEqual([])
  })

  it('treats a `dev` block as inert to the audit', () => {
    const config: InfraKitPackageConfig = {
      dev: {
        proxy: {
          templates: { local: 'http://localhost:<port>', cloud: 'https://<env>.example.com' },
          routes: { '/api': { packageName: '@app/backend', from: ['cloud'] } },
        },
      },
    }

    expect(resolvePackageConfig(config)).toEqual(resolvePackageConfig({}))
  })
})
