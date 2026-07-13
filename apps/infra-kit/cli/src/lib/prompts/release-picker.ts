import process from 'node:process'

import { OperationError } from 'src/lib/errors/operation-error'
import { PromptCancelledError } from 'src/lib/errors/prompt-cancelled-error'
import { jsonOutput } from 'src/lib/json-output'

import type { BranchPickerItem } from './types'

/**
 * Gate the interactive Ink picker. Bails (throwing a clear `OperationError`,
 * never loading React) when there is no interactive input OR when structured
 * output is requested — `--json` is registered on every command and sets
 * `jsonOutput.enabled`, so `--json` on a TTY without an explicit arg would
 * otherwise pass a TTY-only gate and dynamically import the TUI (leaking React
 * onto the `--json` path).
 *
 * The predicate is `stdin.isTTY` only — deliberately NOT the palette's
 * `stdout && stdin`. These prompts render to stderr, so an interactive run whose
 * STDOUT is redirected (e.g. `worktrees-remove > log.txt`) must still prompt;
 * requiring `stdout.isTTY` would regress that. Input-side interactivity is what
 * the picker actually needs.
 *
 * The `!process.stdin.isTTY` clause is LOAD-BEARING, not defensive:
 * `worktrees-add` and `gh-merge-dev` are `mcpExposed: true` with ALL of their
 * branch inputs `.optional()`, so an MCP call with those args omitted DOES enter
 * the interactive branch — only the absent TTY on the MCP server stops the
 * prompt (and stops React from being loaded there). Do not remove it.
 */
const assertInteractive = () => {
  if (!process.stdin.isTTY || jsonOutput.enabled) {
    throw new OperationError(undefined, {
      operation: 'interactive branch selection',
      remediation:
        'pass the branch selection explicitly (CLI: `--version`/`--versions`/`--all`; MCP: the `version`/`versions`/`all` fields) for non-interactive, --json, or MCP runs',
    })
  }
}

/**
 * Prompt for a single release branch via the searchable Ink picker. Throws an
 * `OperationError` on non-interactive/`--json`/MCP runs (see `assertInteractive`)
 * and a `PromptCancelledError` if the user backs out with Esc/Ctrl-C. The Ink
 * TUI is reached only through a dynamic import so React never loads on the
 * bail paths.
 */
export const pickReleaseBranch = async (items: BranchPickerItem[]): Promise<string> => {
  assertInteractive()
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
  assertInteractive()
  const { runBranchMultiPicker } = await import('src/tui/boot')
  const values = await runBranchMultiPicker(items, opts)

  if (values === null) throw new PromptCancelledError()

  return values
}
