import type { Rule } from 'eslint'

// Each './<rule>' resolves to './<rule>/index.ts' (the rule's folder barrel) under
// `moduleResolution: bundler`; a future switch to node16/nodenext would require explicit paths.
import { componentArrowFunction } from './component-arrow-function'
import { componentFileOrder } from './component-file-order'
import { maxComponentsPerFile } from './max-components-per-file'
import { maxJsxReturnSize } from './max-jsx-return-size'
import { propsDestructuringBlankLine } from './props-destructuring-blank-line'
import { propsDestructuringNewline } from './props-destructuring-newline'
import { propsTypeName } from './props-type-name'
import { propsTypeReference } from './props-type-reference'
import { requireComponentStories } from './require-component-stories'

export const rules: Record<string, Rule.RuleModule> = {
  'props-destructuring-newline': propsDestructuringNewline,
  'props-destructuring-blank-line': propsDestructuringBlankLine,
  'props-type-reference': propsTypeReference,
  'props-type-name': propsTypeName,
  'component-file-order': componentFileOrder,
  'component-arrow-function': componentArrowFunction,
  'max-components-per-file': maxComponentsPerFile,
  'max-jsx-return-size': maxJsxReturnSize,
  'require-component-stories': requireComponentStories,
}
