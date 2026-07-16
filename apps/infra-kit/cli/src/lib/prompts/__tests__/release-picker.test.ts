import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'
import { jsonOutput } from 'src/lib/json-output'
import { mcpMode } from 'src/lib/mcp-mode'

import type { BranchPickerItem } from '../types'

// Mock the Ink boot module so the shim never loads React and so tests can assert
// whether the dynamic `import('src/tui/boot')` branch was reached at all — if the
// `assertInteractive()` guard fires first, neither of these mocks is ever called.
const runBranchPicker = vi.fn<(items: BranchPickerItem[]) => Promise<string | null>>()
const runBranchMultiPicker = vi.fn<(items: BranchPickerItem[], opts?: unknown) => Promise<string[] | null>>()

vi.mock('src/tui/boot', () => {
  return { runBranchPicker, runBranchMultiPicker }
})

const { pickReleaseBranch, pickReleaseBranches } = await import('../release-picker')

const items: BranchPickerItem[] = [{ value: 'release/1.2.3', label: 'release/1.2.3' }]

const originalIsTTY = process.stdin.isTTY

afterEach(() => {
  process.stdin.isTTY = originalIsTTY
  jsonOutput.enabled = false
  mcpMode.enabled = false
  runBranchPicker.mockReset()
  runBranchMultiPicker.mockReset()
})

describe('release-picker interactive guard', () => {
  it('throws OperationError and never imports the TUI when stdin is not a TTY', async () => {
    process.stdin.isTTY = false

    await expect(pickReleaseBranch(items)).rejects.toBeInstanceOf(OperationError)
    await expect(pickReleaseBranches(items)).rejects.toBeInstanceOf(OperationError)

    expect(runBranchPicker).not.toHaveBeenCalled()
    expect(runBranchMultiPicker).not.toHaveBeenCalled()
  })

  it('throws OperationError and never imports the TUI when serving MCP, even though stdin IS a TTY', async () => {
    // `commands/mcp/mcp.ts` spawns the server with `stdio: 'inherit'`, so a
    // terminal-launched `infra-kit mcp` really does have a TTY stdin. The old
    // `!isTTY`-only guard does not fire here and would render an Ink picker into the
    // JSON-RPC stream — `worktrees-add` and `gh-merge-dev` are mcpExposed with all
    // branch inputs optional, so that path is reachable.
    process.stdin.isTTY = true
    mcpMode.enabled = true

    await expect(pickReleaseBranch(items)).rejects.toBeInstanceOf(OperationError)
    await expect(pickReleaseBranches(items)).rejects.toBeInstanceOf(OperationError)

    expect(runBranchPicker).not.toHaveBeenCalled()
    expect(runBranchMultiPicker).not.toHaveBeenCalled()
  })

  it('throws OperationError and never imports the TUI when --json output is enabled', async () => {
    process.stdin.isTTY = true
    jsonOutput.enabled = true

    await expect(pickReleaseBranch(items)).rejects.toBeInstanceOf(OperationError)
    await expect(pickReleaseBranches(items)).rejects.toBeInstanceOf(OperationError)

    expect(runBranchPicker).not.toHaveBeenCalled()
    expect(runBranchMultiPicker).not.toHaveBeenCalled()
  })
})

describe('pickReleaseBranch', () => {
  it('throws PromptCancelledError when the picker is cancelled', async () => {
    process.stdin.isTTY = true
    runBranchPicker.mockResolvedValue(null)

    await expect(pickReleaseBranch(items)).rejects.toMatchObject({ name: 'PromptCancelledError' })
  })

  it('returns the selected value unchanged', async () => {
    process.stdin.isTTY = true
    runBranchPicker.mockResolvedValue('release/1.2.3')

    expect(await pickReleaseBranch(items)).toBe('release/1.2.3')
  })
})

describe('pickReleaseBranches', () => {
  it('throws PromptCancelledError when the picker is cancelled', async () => {
    process.stdin.isTTY = true
    runBranchMultiPicker.mockResolvedValue(null)

    await expect(pickReleaseBranches(items)).rejects.toMatchObject({
      name: 'PromptCancelledError',
    })
  })

  it('returns the selected values unchanged', async () => {
    process.stdin.isTTY = true
    runBranchMultiPicker.mockResolvedValue(['release/1.2.3'])

    expect(await pickReleaseBranches(items)).toStrictEqual(['release/1.2.3'])
  })
})
