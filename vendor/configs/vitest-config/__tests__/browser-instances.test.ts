import { describe, expect, it } from 'vitest'

import { defineBrowserConfig, defineReactBrowserConfig } from '../src/index.js'

const dirname = import.meta.dirname

describe('browser instances: an override replaces the default list', () => {
  it.each([
    ['defineBrowserConfig', defineBrowserConfig],
    ['defineReactBrowserConfig', defineReactBrowserConfig],
  ])('%s keeps only the consumer instances', (_name, define) => {
    const config = define(dirname, { test: { browser: { instances: [{ browser: 'firefox' }] } } })

    expect(config.test?.browser?.instances).toEqual([{ browser: 'firefox' }])
  })

  it('keeps the chromium default when the consumer names no instances', () => {
    const config = defineReactBrowserConfig(dirname, { test: { browser: { headless: false } } })

    expect(config.test?.browser?.instances).toEqual([{ browser: 'chromium' }])
    expect(config.test?.browser?.headless).toBe(false)
  })
})
