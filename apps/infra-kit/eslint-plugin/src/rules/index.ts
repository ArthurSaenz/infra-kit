import type { Rule } from 'eslint'

import { componentFileOrder } from './component-file-order'
import { propsDestructuringBlankLine } from './props-destructuring-blank-line'
import { propsDestructuringNewline } from './props-destructuring-newline'
import { requireComponentStories } from './require-component-stories'

export const rules: Record<string, Rule.RuleModule> = {
  'props-destructuring-newline': propsDestructuringNewline,
  'props-destructuring-blank-line': propsDestructuringBlankLine,
  'component-file-order': componentFileOrder,
  'require-component-stories': requireComponentStories,
}
