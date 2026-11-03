import { findPackageRoot } from './package-root'
import { resolvePackageType } from './package-type-reader'
import { matchesAnyGlob } from './path-match'

/** Where a feature's dumb components live — the default scope of the dumb-component rules. */
export const DUMB_COMPONENT_PATHS = ['**/features/*/components/**/*.tsx', '**/*-component.tsx']

// Backends and Playwright suites render no React, so a `.tsx` there is never a UI component.
const NON_UI_TYPES = new Set(['backend', 'e2e'])

const STORY_OR_TEST_DIR = /(?:^|\/)(?:__tests__|__stories__)\//
const STORY_OR_TEST_EXT = /\.(?:stories|test|spec)\.[cm]?[jt]sx?$/

/** Whether `filename` is a story or test file, which renders components without being one. */
export const isStoryOrTestFile = (filename: string): boolean => {
  return STORY_OR_TEST_DIR.test(filename) || STORY_OR_TEST_EXT.test(filename)
}

/** Whether `filename` sits in a package that can hold UI components (virtual filenames count). */
export const isUiPackageFile = (filename: string): boolean => {
  const packageRoot = findPackageRoot(filename)

  return packageRoot === null || !NON_UI_TYPES.has(resolvePackageType(packageRoot))
}

/** The shared `paths`/`ignore` gate: ignore wins, an empty `paths` matches everything. */
export const isInScope = (filename: string, paths: readonly string[], ignore: readonly string[]): boolean => {
  if (ignore.length > 0 && matchesAnyGlob(filename, ignore)) {
    return false
  }

  return paths.length === 0 || matchesAnyGlob(filename, paths)
}
