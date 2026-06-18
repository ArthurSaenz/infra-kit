import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { existsSync } from 'node:fs'
import { afterAll, describe, it, vi } from 'vitest'

import { requireComponentStories } from '../require-component-stories'

// Preserve the real `node:fs` and override only `existsSync` — RuleTester/tsParser must keep working.
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>()

  return { ...actual, existsSync: vi.fn() }
})

// Wire ESLint's RuleTester into vitest's lifecycle so each case becomes a real test.
const ruleTesterHooks = RuleTester as unknown as {
  afterAll: typeof afterAll
  describe: typeof describe
  it: typeof it
  itOnly: typeof it.only
}

ruleTesterHooks.afterAll = afterAll
ruleTesterHooks.describe = describe
ruleTesterHooks.it = it
// eslint-disable-next-line test/no-only-tests -- RuleTester requires an `itOnly` hook reference.
ruleTesterHooks.itOnly = it.only

const toPosix = (filePath: string): string => {
  return filePath.split('\\').join('/')
}

// RuleTester registers its cases now, but ESLint runs them AFTER this module finishes evaluating.
// A per-case `existsSync.mockReturnValue(...)` would therefore all run up front, and the LAST write
// would win for every deferred case. So existence is modelled as a pure function of the path: these
// are the `deriveExpectedStoryPaths()[0]` story locations of the two "valid" components below — keep
// them in lockstep with those filenames — and only these paths "exist" on disk.
const EXISTING_STORY_PATHS = new Set<string>([
  '/r/src/features/user/__stories__/user-card-component.stories.tsx',
  '/r/src/components/default/__stories__/button-component.stories.tsx',
])

vi.mocked(existsSync).mockImplementation(((candidate: unknown) => {
  return EXISTING_STORY_PATHS.has(toPosix(String(candidate)))
}) as typeof existsSync)

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
})

// A real component (PascalCase, returns JSX) so the requireComponentAst gate is satisfied.
const COMPONENT = 'const Foo = () => <div />'
// A file that declares no component — requireComponentAst should skip it.
const NON_COMPONENT = 'export const value = 1'

ruleTester.run('require-component-stories', requireComponentStories, {
  valid: [
    // Feature component whose feature-root story exists.
    {
      code: COMPONENT,
      filename: '/r/src/features/user/components/user-card-component.tsx',
    },
    // components/default component whose sibling story exists.
    {
      code: COMPONENT,
      filename: '/r/src/components/default/button-component.tsx',
    },
    // Containers are never required to have stories (classification returns null).
    {
      code: COMPONENT,
      filename: '/r/src/features/user/containers/user-card-container.tsx',
    },
    // A -component file that declares no component is skipped via requireComponentAst.
    {
      code: NON_COMPONENT,
      filename: '/r/src/features/user/components/data-component.tsx',
    },
    // Control: no filename -> context.filename is `<input>` -> gate miss -> no error (right reason).
    {
      code: COMPONENT,
    },
    // Nested below components/ (depth guard) -> not classified -> clean despite no story.
    {
      code: COMPONENT,
      filename: '/r/src/features/user/components/sub/deep-component.tsx',
    },
    // `paths` provided but filename does not match -> rule inactive -> clean despite missing story.
    {
      code: COMPONENT,
      filename: '/r/src/components/default/unmatched-component.tsx',
      options: [{ paths: ['**/features/**'] }],
    },
    // `ignore` matches the filename -> skipped -> clean despite missing story.
    {
      code: COMPONENT,
      filename: '/r/src/features/skip/components/skip-this-component.tsx',
      options: [{ ignore: ['**/skip/**'] }],
    },
    // `ignore` wins over `paths`: the file matches BOTH globs -> skipped -> clean despite no story.
    {
      code: COMPONENT,
      filename: '/r/src/features/both/components/both-component.tsx',
      options: [{ paths: ['**/features/**'], ignore: ['**/both/**'] }],
    },
  ],
  invalid: [
    // Feature component with no story. Doubles as the mapping proof: the reported expected path is
    // the feature-root __stories__/ location with the .stories.tsx name.
    {
      code: COMPONENT,
      filename: '/r/src/features/lonely/components/lonely-component.tsx',
      errors: [
        {
          message:
            "Dumb component 'lonely-component.tsx' is missing a Storybook story (expected at '/r/src/features/lonely/__stories__/lonely-component.stories.tsx').",
        },
      ],
    },
    // components/default component with no sibling story -> exactly one error (no double-report).
    {
      code: COMPONENT,
      filename: '/r/src/components/default/orphan-component.tsx',
      errors: [{ messageId: 'missingStory' }],
    },
    // `paths` matches and the story is missing -> rule active -> reports.
    {
      code: COMPONENT,
      filename: '/r/src/features/user2/components/widget-component.tsx',
      options: [{ paths: ['**/features/**'] }],
      errors: [{ messageId: 'missingStory' }],
    },
    // `ignore` provided but does not match -> rule stays active -> reports.
    {
      code: COMPONENT,
      filename: '/r/src/features/active/components/active-component.tsx',
      options: [{ ignore: ['**/generated/**'] }],
      errors: [{ messageId: 'missingStory' }],
    },
    // `requireComponentAst: false` drops the AST gate -> a -component file with no component body
    // still reports (the complement of the default-true skip in the valid set above).
    {
      code: NON_COMPONENT,
      filename: '/r/src/features/user/components/inert-component.tsx',
      options: [{ requireComponentAst: false }],
      errors: [{ messageId: 'missingStory' }],
    },
    // `extraTargets` classifies a custom layout (ui/widgets) -> missing story -> reports.
    {
      code: COMPONENT,
      filename: '/r/src/ui/widgets/gadget-component.tsx',
      options: [{ extraTargets: [{ componentsDir: 'widgets', anchorParentDir: 'ui', storyMode: 'sibling' }] }],
      errors: [{ messageId: 'missingStory' }],
    },
  ],
})
