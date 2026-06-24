import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { requireComponentStories } from '../require-component-stories'

// This suite exercises the REAL node:fs (no mock) against a fixture tree generated at runtime in a
// temp dir — NOT committed under src/, which the plugin lints (`eslint ./src`) and typechecks.
// It guards the end-to-end path-derivation -> existsSync contract the mocked RuleTester cannot.

const RULE_ID = '@wl/require-component-stories'
const COMPONENT_SOURCE = 'export const UserCard = () => <div />\n'

const config = {
  files: ['**/*.{ts,tsx,js,jsx}'],
  plugins: { '@wl': { rules: { 'require-component-stories': requireComponentStories } } },
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
      ecmaVersion: 'latest' as const,
      sourceType: 'module' as const,
    },
  },
  rules: { [RULE_ID]: 'error' as const },
}

let root: string
// The Linter must be rooted at the temp dir so flat config matches files under it (otherwise the
// file falls outside the base path and yields "No matching configuration found").
let linter: Linter
let withStory: string
let withoutStory: string

const writeComponent = (relPath: string): string => {
  const absPath = path.join(root, relPath)

  mkdirSync(path.dirname(absPath), { recursive: true })
  writeFileSync(absPath, COMPONENT_SOURCE)

  return absPath
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'rcs-integration-'))
  linter = new Linter({ cwd: root })

  // Component WITH a co-located feature-root story.
  withStory = writeComponent('features/user/components/user-card-component.tsx')
  mkdirSync(path.join(root, 'features/user/__stories__'), { recursive: true })
  writeFileSync(
    path.join(root, 'features/user/__stories__/user-card-component.stories.tsx'),
    'export const Default = {}\n',
  )

  // Component WITHOUT any story.
  withoutStory = writeComponent('features/lonely/components/lonely-component.tsx')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('require-component-stories (real fs)', () => {
  it('is clean when the co-located story exists on disk', () => {
    const messages = linter.verify(COMPONENT_SOURCE, config, { filename: withStory })

    expect(messages).toHaveLength(0)
  })

  it('reports missingStory when the story is absent on disk', () => {
    const messages = linter.verify(COMPONENT_SOURCE, config, { filename: withoutStory })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe(RULE_ID)
    expect(messages[0]?.messageId).toBe('missingStory')
  })
})
