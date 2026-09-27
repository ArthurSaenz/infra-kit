import type { Rule } from 'eslint'

// Each './<rule>' resolves to './<rule>/index.ts' (the rule's folder barrel) under
// `moduleResolution: bundler`; a future switch to node16/nodenext would require explicit paths.
import { componentArrowFunction } from './component-arrow-function'
import { componentFileOrder } from './component-file-order'
import { e2eFileLayout } from './e2e-file-layout'
import { e2eTestTags } from './e2e-test-tags'
import { e2eTestTitle } from './e2e-test-title'
import { maxComponentsPerFile } from './max-components-per-file'
import { maxJsdocLines } from './max-jsdoc-lines'
import { maxJsdocSummaryLines } from './max-jsdoc-summary-lines'
import { maxJsxReturnSize } from './max-jsx-return-size'
import { packageStructure } from './package-structure'
import { propsDestructuringBlankLine } from './props-destructuring-blank-line'
import { propsDestructuringNewline } from './props-destructuring-newline'
import { propsTypeName } from './props-type-name'
import { propsTypeReference } from './props-type-reference'
import { requireComponentStories } from './require-component-stories'
import { requireJsdocExample } from './require-jsdoc-example'
import { testLocation } from './test-location'

export const rules: Record<string, Rule.RuleModule> = {
  'props-destructuring-newline': propsDestructuringNewline,
  'props-destructuring-blank-line': propsDestructuringBlankLine,
  'props-type-reference': propsTypeReference,
  'props-type-name': propsTypeName,
  'component-file-order': componentFileOrder,
  'component-arrow-function': componentArrowFunction,
  'max-components-per-file': maxComponentsPerFile,
  'max-jsx-return-size': maxJsxReturnSize,
  'max-jsdoc-lines': maxJsdocLines,
  'max-jsdoc-summary-lines': maxJsdocSummaryLines,
  'require-component-stories': requireComponentStories,
  'require-jsdoc-example': requireJsdocExample,
  'package-structure': packageStructure,
  'test-location': testLocation,
  'e2e-file-layout': e2eFileLayout,
  'e2e-test-tags': e2eTestTags,
  'e2e-test-title': e2eTestTitle,
}
