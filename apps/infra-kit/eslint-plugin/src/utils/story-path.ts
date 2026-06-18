import path from 'node:path'

/** Where a story file lives relative to its component. */
export type StoryMode = 'feature-root' | 'sibling'

/** A consumer-defined extra component layout (structured — never a glob). */
export interface ExtraTarget {
  /** Immediate parent directory name a component file must sit directly inside. */
  componentsDir: string
  /** Optional grandparent directory name gate (e.g. `features`). */
  anchorParentDir?: string
  /** Where the story is expected for files matched by this target. */
  storyMode: StoryMode
}

export interface StoryPathOptions {
  /** Story directory name (default `__stories__`). */
  storiesDir: string
  /** Suffix inserted before the extension (default `.stories`). */
  storySuffix: string
  /** Extensions a satisfying story file may have, in priority order. */
  storyExtensions: string[]
  /** Extensions a file must have to be considered a component. */
  componentExtensions: string[]
  /** Basename suffix a component file must end with (default `-component`; `''` disables). */
  componentSuffix: string
  /** Additional structured component layouts beyond the two built-ins. */
  extraTargets: ExtraTarget[]
}

export const DEFAULT_STORY_PATH_OPTIONS: StoryPathOptions = {
  storiesDir: '__stories__',
  storySuffix: '.stories',
  storyExtensions: ['.tsx', '.jsx', '.ts', '.js'],
  componentExtensions: ['.tsx', '.jsx'],
  componentSuffix: '-component',
  extraTargets: [],
}

const resolveOptions = (opts?: Partial<StoryPathOptions>): StoryPathOptions => {
  return { ...DEFAULT_STORY_PATH_OPTIONS, ...opts }
}

/** Normalize OS-native separators to posix so all downstream path logic is deterministic. */
const toPosix = (filePath: string): string => {
  return filePath.split('\\').join('/')
}

interface ParsedComponent {
  /** Posix directory of the file. */
  dir: string
  /** Basename without its extension. */
  base: string
  /** Original extension (e.g. `.tsx`). */
  ext: string
  /** Immediate parent directory name. */
  parent: string
  /** Grandparent directory name. */
  grandparent: string
  /** Great-grandparent directory name. */
  greatGrandparent: string
}

/** Parse a file path into the segment view the gate and derivation both need. */
const parse = (filePath: string): ParsedComponent => {
  const normalized = toPosix(filePath)
  const segments = normalized.split('/')
  const basename = segments[segments.length - 1] ?? ''
  const ext = path.posix.extname(basename)
  const base = ext ? basename.slice(0, -ext.length) : basename

  return {
    dir: path.posix.dirname(normalized),
    base,
    ext,
    parent: segments[segments.length - 2] ?? '',
    grandparent: segments[segments.length - 3] ?? '',
    greatGrandparent: segments[segments.length - 4] ?? '',
  }
}

/** Whether the file passes the component preconditions (extension + name suffix). */
const passesComponentPreconditions = (parsed: ParsedComponent, options: StoryPathOptions): boolean => {
  if (!options.componentExtensions.includes(parsed.ext)) {
    return false
  }

  return options.componentSuffix === '' || parsed.base.endsWith(options.componentSuffix)
}

/**
 * Classify a file as a dumb component requiring a story, resolving WHERE its story should live.
 * Returns null when the file is not a component-requiring-a-story under any branch.
 *
 * Exactly one admit-condition may hold:
 *  - feature-root: direct child of `components/` whose chain is `features/<f>/components`.
 *  - sibling: a `components/default/<name>-component` file (parent `default`, grandparent `components`).
 *  - extraTargets: a structured consumer-defined layout.
 */
export const classifyComponent = (filePath: string, opts?: Partial<StoryPathOptions>): { mode: StoryMode } | null => {
  const options = resolveOptions(opts)
  const parsed = parse(filePath)

  if (!passesComponentPreconditions(parsed, options)) {
    return null
  }

  // (a) feature-root — immediate parent is `components` AND the chain is `features/<feature>/components`.
  if (parsed.parent === 'components' && parsed.greatGrandparent === 'features') {
    return { mode: 'feature-root' }
  }

  // (b) sibling — `components/default/<name>-component.*` (NOT a direct child of `components/`).
  if (parsed.parent === 'default' && parsed.grandparent === 'components') {
    return { mode: 'sibling' }
  }

  // (c) extraTargets — structured layouts (componentsDir + optional anchorParentDir).
  for (const target of options.extraTargets) {
    const parentMatches = parsed.parent === target.componentsDir
    const anchorMatches = target.anchorParentDir == null || parsed.grandparent === target.anchorParentDir

    if (parentMatches && anchorMatches) {
      return { mode: target.storyMode }
    }
  }

  return null
}

/**
 * Ordered candidate story paths for a component file. Empty when the file is not a
 * component-requiring-a-story (see {@link classifyComponent}). The story is considered present
 * when ANY candidate exists on disk.
 */
export const deriveExpectedStoryPaths = (filePath: string, opts?: Partial<StoryPathOptions>): string[] => {
  const options = resolveOptions(opts)
  const classification = classifyComponent(filePath, options)

  if (!classification) {
    return []
  }

  const parsed = parse(filePath)

  // feature-root: dirname(file) is `.../components`, so its parent is the feature root.
  // sibling: the story dir sits next to the component file itself.
  const storyBaseDir = classification.mode === 'feature-root' ? path.posix.dirname(parsed.dir) : parsed.dir
  const storyDir = path.posix.join(storyBaseDir, options.storiesDir)

  return options.storyExtensions.map((extension) => {
    return path.posix.join(storyDir, `${parsed.base}${options.storySuffix}${extension}`)
  })
}
