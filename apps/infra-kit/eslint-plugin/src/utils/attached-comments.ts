import type { SourceCode } from 'eslint'
import type * as ESTree from 'estree'

/**
 * Where `node` starts once its attached leading comments are included: the unbroken run of comments
 * directly above it, each on the line after the previous one ends. A comment separated by a blank
 * line (a file overview, a section banner) stays behind when the node moves.
 *
 * @example
 * attachedStart(sourceCode, node) // => range start of the JSDoc right above `node`, else of `node`
 */
export const attachedStart = (sourceCode: SourceCode, node: ESTree.Node): number => {
  const previousEndLine = sourceCode.getTokenBefore(node)?.loc.end.line ?? 0
  let start = node.range![0]
  let startLine = node.loc!.start.line

  for (const comment of sourceCode.getCommentsBefore(node).toReversed()) {
    if (comment.loc!.end.line < startLine - 1 || comment.loc!.start.line <= previousEndLine) {
      break
    }

    start = comment.range![0]
    startLine = comment.loc!.start.line
  }

  return start
}
