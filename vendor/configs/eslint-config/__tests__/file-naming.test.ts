import { describe, expect, it } from 'vitest'

import { isKebabFolder } from '../src/configs/file-naming.js'
import { expectClean, expectFlagged, lintCase } from './_lint-case.js'

const SOURCE = 'export const a = 1\n'

const naming = async (fileName: string) => {
  const messages = await lintCase({ source: SOURCE, fileName })

  return messages.filter((m) => m.ruleId === 'unicorn/filename-case' || m.ruleId === 'wl-config/folder-case')
}

describe('file naming: kebab-case is required', () => {
  it('flags a camelCase file name', async () => {
    expectFlagged(await naming('src/features/billing/userCard.ts'), 'unicorn/filename-case', 'user-card.ts')
  })

  it('flags a PascalCase component file', async () => {
    expectFlagged(await naming('src/features/billing/UserCard.tsx'), 'unicorn/filename-case', 'user-card.tsx')
  })

  it('flags a snake_case file name', async () => {
    expectFlagged(await naming('src/lib/terms_conditions.ts'), 'unicorn/filename-case', 'terms-conditions.ts')
  })

  it('flags a camelCase folder', async () => {
    expectFlagged(await naming('src/dataSource/client.ts'), 'wl-config/folder-case', '`dataSource`')
  })

  it('flags a snake_case folder', async () => {
    expectFlagged(await naming('src/lambda_controllers/get.ts'), 'wl-config/folder-case', '`lambda_controllers`')
  })

  // The folder rule exists because unicorn's own folder check stops at the first ignored segment.
  it('still checks file names inside a __tests__ folder', async () => {
    expectFlagged(await naming('src/lib/__tests__/userCard.test.ts'), 'unicorn/filename-case', 'user-card.test.ts')
  })
})

describe('file naming: framework- and tool-mandated names pass', () => {
  it.each([
    'src/features/billing/user-card.tsx',
    'src/features/billing/index.ts',
    'src/lib/__tests__/user-card.test.ts',
    'src/__mocks__/@aws-sdk/client-s3.ts',
    'src/__fixtures__/order.ts',
    '.storybook/preview.tsx',
    'src/routes/__root.tsx',
    'src/routes/$.tsx',
    'src/routes/$postId.tsx',
    'src/routes/posts.$postId.tsx',
    'src/routes/posts_.$postId.edit.tsx',
    'src/routes/-components/header.tsx',
    'src/routes/-header.tsx',
    'src/routes/_authenticated/(admin)/$userId/settings.tsx',
    'src/routes/[id]/view.tsx',
    'src/pages/+Page.tsx',
    'src/pages/+config.ts',
  ])('%s', async (fileName) => {
    expect(await naming(fileName)).toEqual([])
  })

  it('does not check markdown files (README.md, CLAUDE.md)', async () => {
    for (const fileName of ['src/features/billing/README.md', 'src/features/billing/CLAUDE.md']) {
      const messages = await lintCase({ source: '# Title\n', fileName })

      expectClean(messages, 'unicorn/filename-case')
      expectClean(messages, 'wl-config/folder-case')
    }
  })
})

describe('file naming: folder classification', () => {
  it.each([
    ['popup.legacy', true],
    ['_LEGACY_finder', false],
    ['__type-tests__', true],
    ['[_]dev', true],
    ['magicLink', false],
    ['activeTrail', false],
    ['dataSource', false],
    ['_LEGACY_holiday-finder', false],
    ['posts.$postId', true],
    ['{-$lang}', true],
    ['pt-BR', true],
    ['en_US', true],
    ['pt-br-BR', false],
  ])('%s -> %s', (name, expected) => {
    expect(isKebabFolder(name)).toBe(expected)
  })
})
