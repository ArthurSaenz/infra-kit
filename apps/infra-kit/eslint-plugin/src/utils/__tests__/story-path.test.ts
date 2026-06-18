import { describe, expect, it } from 'vitest'

import { classifyComponent, deriveExpectedStoryPaths } from '../story-path'

describe('classifyComponent', () => {
  it('classifies a feature component (features/<f>/components) as feature-root', () => {
    expect(classifyComponent('/r/src/features/user/components/user-card-component.tsx')).toEqual({
      mode: 'feature-root',
    })
  })

  it('classifies a components/default component as sibling', () => {
    expect(classifyComponent('/r/src/components/default/button-component.tsx')).toEqual({ mode: 'sibling' })
  })

  it('returns null for a nested component below components/ (depth guard)', () => {
    expect(classifyComponent('/r/src/features/user/components/sub/deep-component.tsx')).toBeNull()
  })

  it('returns null for a container file', () => {
    expect(classifyComponent('/r/src/features/user/containers/user-card-container.tsx')).toBeNull()
  })

  it('returns null when the basename lacks the -component suffix', () => {
    expect(classifyComponent('/r/src/features/user/components/index.tsx')).toBeNull()
    expect(classifyComponent('/r/src/features/user/components/helper.tsx')).toBeNull()
  })

  it('returns null for a non-component extension', () => {
    expect(classifyComponent('/r/src/features/user/components/user-card-component.ts')).toBeNull()
  })

  it('does NOT classify a components/ child whose chain is not features/<f>/components', () => {
    // parent is `components` but great-grandparent is not `features`.
    expect(classifyComponent('/r/src/widgets/x/components/foo-component.tsx')).toBeNull()
  })

  it('honors an extra structured target', () => {
    const opts = { extraTargets: [{ componentsDir: 'widgets', anchorParentDir: 'ui', storyMode: 'sibling' as const }] }

    expect(classifyComponent('/r/src/ui/widgets/foo-component.tsx', opts)).toEqual({ mode: 'sibling' })
    // anchorParentDir mismatch -> null
    expect(classifyComponent('/r/src/elsewhere/widgets/foo-component.tsx', opts)).toBeNull()
  })

  it('normalizes Windows separators', () => {
    expect(classifyComponent('C:\\r\\src\\features\\user\\components\\user-card-component.tsx')).toEqual({
      mode: 'feature-root',
    })
  })
})

describe('deriveExpectedStoryPaths', () => {
  it('maps a feature component to the feature-root __stories__/ directory', () => {
    const [first] = deriveExpectedStoryPaths('/r/src/features/user/components/user-card-component.tsx')

    expect(first).toBe('/r/src/features/user/__stories__/user-card-component.stories.tsx')
  })

  it('maps a components/default component to a co-located sibling __stories__/', () => {
    const [first] = deriveExpectedStoryPaths('/r/src/components/default/button-component.tsx')

    expect(first).toBe('/r/src/components/default/__stories__/button-component.stories.tsx')
  })

  it('returns an empty list for a non-component file', () => {
    expect(deriveExpectedStoryPaths('/r/src/features/user/components/index.tsx')).toEqual([])
  })

  it('fans out candidates across storyExtensions in priority order', () => {
    const candidates = deriveExpectedStoryPaths('/r/src/components/default/button-component.tsx')

    expect(candidates).toEqual([
      '/r/src/components/default/__stories__/button-component.stories.tsx',
      '/r/src/components/default/__stories__/button-component.stories.jsx',
      '/r/src/components/default/__stories__/button-component.stories.ts',
      '/r/src/components/default/__stories__/button-component.stories.js',
    ])
  })

  it('reflects custom storiesDir and storySuffix knobs', () => {
    const [first] = deriveExpectedStoryPaths('/r/src/features/user/components/user-card-component.tsx', {
      storiesDir: 'stories',
      storySuffix: '.story',
    })

    expect(first).toBe('/r/src/features/user/stories/user-card-component.story.tsx')
  })

  it('derives the .tsx story name independent of the .jsx component extension', () => {
    // Story extension comes from storyExtensions[0] (.tsx), NOT the component's own .jsx.
    const [first] = deriveExpectedStoryPaths('/r/src/features/user/components/user-card-component.jsx')

    expect(first).toBe('/r/src/features/user/__stories__/user-card-component.stories.tsx')
  })
})
