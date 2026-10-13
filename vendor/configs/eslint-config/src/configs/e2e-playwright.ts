import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import type { Rule } from 'eslint'
import playwright from 'eslint-plugin-playwright'

import type { ConfigRules } from '../types.js'
import { isE2eSourceFile } from './e2e-boundaries.js'

// `test.fixme('…', async () => {})` placeholders never run green, so they are tracked debt rather than
// hollow passing tests; expect-expect would otherwise flag every one of them.
const PENDING_MODIFIERS = new Set(['fixme', 'skip'])

const isPendingTestCallee = (node: unknown): boolean => {
  const callee = node as { type?: string; property?: { type?: string; name?: string } }

  return (
    callee.type === 'MemberExpression' &&
    callee.property?.type === 'Identifier' &&
    PENDING_MODIFIERS.has(callee.property.name ?? '')
  )
}

const ignorePendingTests = (rule: Rule.RuleModule): Rule.RuleModule => ({
  ...rule,
  create: (context) => {
    const report: Rule.RuleContext['report'] = (descriptor) => {
      if ('node' in descriptor && isPendingTestCallee(descriptor.node)) {
        return
      }

      context.report(descriptor)
    }

    return rule.create(Object.create(context, { report: { value: report } }) as Rule.RuleContext)
  },
})

const rules = playwright.rules as unknown as Record<string, Rule.RuleModule>

const plugin = {
  ...playwright,
  rules: { ...rules, 'expect-expect': ignorePendingTests(rules['expect-expect']!) },
}

/**
 * Rules that keep a green Playwright run trustworthy: no un-awaited assertions, no focused tests, no
 * timing guesses, no assertion-free or conditionally-asserting tests.
 *
 * @example
 * e2ePlaywright() // spread into the antfu(...) call after e2eBoundaries
 */
export const e2ePlaywright = (): TypedFlatConfigItem => ({
  name: 'wl/e2e-playwright',
  // Same package-level scope as e2eBoundaries.
  files: [isE2eSourceFile as unknown as string],
  plugins: { playwright: plugin },
  rules: {
    'playwright/missing-playwright-await': 'error',
    'playwright/no-focused-test': 'error',
    'playwright/no-wait-for-timeout': 'error',
    'playwright/no-force-option': 'error',
    'playwright/no-conditional-expect': 'error',
    'playwright/no-networkidle': 'error',
    // Suites assert through page-object helpers (`expectOk`, `assertCardVisible`, `page.expectX`).
    'playwright/expect-expect': ['error', { assertFunctionPatterns: ['(^|\\.)(expect|assert|verify)[A-Z]\\w*$'] }],
  } as ConfigRules,
})
