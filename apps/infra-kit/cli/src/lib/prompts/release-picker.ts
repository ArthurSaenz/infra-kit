import process from 'node:process'

import { agentMode, isHeadless } from 'src/lib/agent-mode'
import { OperationError } from 'src/lib/errors/operation-error'
import { PromptCancelledError } from 'src/lib/errors/prompt-cancelled-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'

import type { BranchPickerItem } from './types'

/**
 * Gate the interactive Ink picker: throw, without ever loading React, when nobody can answer it
 * (`isHeadless()`) or when there is no interactive input (`stdin.isTTY`).
 */
// Both clauses are load-bearing.
//
// `--json` on a TTY without an explicit arg would otherwise pass a TTY-only gate and dynamically
// import the TUI, leaking React onto the `--json` path.
//
// The TTY predicate is `stdin.isTTY` only — deliberately NOT the palette's `stdout && stdin`.
// These prompts render to stderr, so an interactive run whose STDOUT is redirected (e.g.
// `worktrees-remove > log.txt`) must still prompt; requiring `stdout.isTTY` would regress that.
// Input-side interactivity is what the picker actually needs.
//
// The agent clause is not defensive: `worktrees-add` and `gh-merge-dev` are `mcpExposed: true` with
// ALL of their branch inputs `.optional()`, so an MCP call with those args omitted DOES enter the
// interactive branch, and without a guard it would render an Ink picker into the JSON-RPC stream.
// `!isTTY` alone cannot catch it — see lib/agent-mode for why `stdio: 'inherit'` defeats it — and
// stays only for genuinely non-interactive human runs (pipes, CI).
//
// Two error classes on purpose. An agent or a `--json` consumer gets `argument_required` naming the
// flag this picker would have filled — no `choices`: the candidates are what `release list --json` /
// `worktrees list --json` already return, and no picker invents a row shape of its own. A plain
// non-TTY human run (a pipe, CI) keeps the `OperationError`: nothing is parsing its stdout.
const assertInteractive = (argument: 'version' | 'versions') => {
  const context = {
    operation: 'interactive branch selection',
    remediation:
      'pass the branch selection explicitly (CLI: `--version`/`--versions`/`--all`; MCP: the `version`/`versions`/`all` fields) for non-interactive, --json, or MCP runs',
  }

  if (isHeadless()) {
    throw new StructuredRefusalError({ status: 'argument_required', argument, agentMode: agentMode.source }, 2, context)
  }

  if (!process.stdin.isTTY) throw new OperationError(undefined, context)
}

/**
 * Prompt for a single release branch via the searchable Ink picker. Throws an
 * `OperationError` on non-interactive/`--json`/MCP runs (see `assertInteractive`)
 * and a `PromptCancelledError` if the user backs out with Esc/Ctrl-C. The Ink
 * TUI is reached only through a dynamic import so React never loads on the
 * bail paths.
 */
export const pickReleaseBranch = async (items: BranchPickerItem[]): Promise<string> => {
  assertInteractive('version')
  const { runBranchPicker } = await import('src/tui/boot')
  const value = await runBranchPicker(items)

  if (value === null) throw new PromptCancelledError()

  return value
}

/**
 * Prompt for one or more release branches via the searchable Ink multi-picker.
 * Same guard and cancellation semantics as {@link pickReleaseBranch}; returns
 * the selected values.
 */
export const pickReleaseBranches = async (
  items: BranchPickerItem[],
  opts?: { required?: boolean; allowSelectAll?: boolean },
): Promise<string[]> => {
  assertInteractive('versions')
  const { runBranchMultiPicker } = await import('src/tui/boot')
  const values = await runBranchMultiPicker(items, opts)

  if (values === null) throw new PromptCancelledError()

  return values
}
