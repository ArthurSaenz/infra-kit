import type { Rule } from 'eslint'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { bodyDeclaresComponent } from '../../utils/component'
import { matchesAnyGlob } from '../../utils/path-match'
import type { ExtraTarget, StoryPathOptions } from '../../utils/story-path'
import { DEFAULT_STORY_PATH_OPTIONS, classifyComponent, deriveExpectedStoryPaths } from '../../utils/story-path'

interface Options {
  paths?: string[]
  ignore?: string[]
  storiesDir?: string
  storySuffix?: string
  storyExtensions?: string[]
  componentSuffix?: string
  requireComponentAst?: boolean
  extraTargets?: ExtraTarget[]
}

/** Pick the story-path knobs out of the rule options, leaving defaults to the helper. */
const toStoryPathOptions = (options: Options): Partial<StoryPathOptions> => {
  const picked: Partial<StoryPathOptions> = {}

  if (options.storiesDir !== undefined) {
    picked.storiesDir = options.storiesDir
  }

  if (options.storySuffix !== undefined) {
    picked.storySuffix = options.storySuffix
  }

  if (options.storyExtensions !== undefined) {
    picked.storyExtensions = options.storyExtensions
  }

  if (options.componentSuffix !== undefined) {
    picked.componentSuffix = options.componentSuffix
  }

  if (options.extraTargets !== undefined) {
    picked.extraTargets = options.extraTargets
  }

  return picked
}

export const requireComponentStories: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a co-located Storybook story for every dumb component.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin',
    },
    schema: [
      {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional globs; when provided the rule only runs for files whose path matches one.',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional globs; the rule is skipped for matching files, even if they also match `paths`.',
          },
          storiesDir: {
            type: 'string',
            description: `Story directory name (default '${DEFAULT_STORY_PATH_OPTIONS.storiesDir}').`,
          },
          storySuffix: {
            type: 'string',
            description: `Suffix inserted before the extension (default '${DEFAULT_STORY_PATH_OPTIONS.storySuffix}').`,
          },
          storyExtensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extensions a satisfying story file may have, in priority order.',
          },
          componentSuffix: {
            type: 'string',
            description: `Basename suffix a component file must end with (default '${DEFAULT_STORY_PATH_OPTIONS.componentSuffix}'; '' disables).`,
          },
          requireComponentAst: {
            type: 'boolean',
            description: 'When true (default), only require a story for files that actually declare a component.',
          },
          extraTargets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                componentsDir: { type: 'string' },
                anchorParentDir: { type: 'string' },
                storyMode: { enum: ['feature-root', 'sibling'] },
              },
              required: ['componentsDir', 'storyMode'],
              additionalProperties: false,
            },
            description: 'Extra structured component layouts (componentsDir + optional anchorParentDir + storyMode).',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingStory: "Dumb component '{{component}}' is missing a Storybook story (expected at '{{expected}}').",
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const paths = options.paths ?? []
    const ignore = options.ignore ?? []
    const requireComponentAst = options.requireComponentAst ?? true
    const storyPathOptions = toStoryPathOptions(options)

    // `ignore` takes precedence: skip excluded files even when they also match `paths`.
    if (ignore.length > 0 && matchesAnyGlob(context.filename, ignore)) {
      return {}
    }

    if (paths.length > 0 && !matchesAnyGlob(context.filename, paths)) {
      return {}
    }

    return {
      Program(program) {
        // Is this file a dumb component that requires a story, and where would the story live?
        if (!classifyComponent(context.filename, storyPathOptions)) {
          return
        }

        // Only enforce on files that actually declare a component (avoids flagging stray
        // non-component files placed under a components/ directory).
        if (requireComponentAst && !bodyDeclaresComponent(program.body)) {
          return
        }

        const candidates = deriveExpectedStoryPaths(context.filename, storyPathOptions)

        // The story is satisfied if ANY candidate (by extension) exists on disk.
        const hasStory = candidates.some((candidate) => {
          return existsSync(candidate)
        })

        if (hasStory) {
          return
        }

        context.report({
          node: program,
          messageId: 'missingStory',
          data: {
            component: path.posix.basename(context.filename.split('\\').join('/')),
            expected: candidates[0] ?? '',
          },
        })
      },
    }
  },
}
