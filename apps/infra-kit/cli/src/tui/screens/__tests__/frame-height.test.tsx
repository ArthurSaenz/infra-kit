import { render } from 'ink'
import { EventEmitter } from 'node:events'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import type { BranchPickerItem } from 'src/lib/prompts/types'
import type { PaletteItem } from 'src/tui/types'

import { BranchMultiPicker } from '../branch-multi-picker'
import { BranchPicker } from '../branch-picker'
import { CommandPalette } from '../command-palette'

/**
 * @fileoverview
 *
 * The invariant that kills the welded-rows bug: for EVERY (columns, rows), an Ink frame must be
 * strictly SHORTER than the viewport.
 *
 * When a frame overflows, the terminal scrolls while Ink draws, and Ink's cleanup — which walks the
 * cursor up one row at a time with `ESC[2K ESC[1A` — SATURATES at row 0. It then erases the wrong rows
 * and leaves the cursor parked ABOVE live content, so the session's status footer and the next palette
 * frame are deposited on top of the command's own output (`❯ ` over `ERROR: …` → `❯ ROR: …`).
 *
 * These tests must NOT use `ink-testing-library`. Its fake stdout hard-codes `columns` as a getter with
 * no setter, defines no `rows` at all (so Ink falls back to the size of whatever terminal the test
 * runner happens to be in), and never sets `isTTY` — which puts Ink on its NON-interactive path, where
 * `renderInteractiveFrame`/`shouldClearTerminalForFrame` never run. A `lastFrame()` assertion therefore
 * measures a code path that cannot overflow, and passes no matter how tall the frame is. That is the
 * "frame tests are false greens" trap, and this bug shipped straight through it.
 *
 * So: drive the real `ink` renderer against a real TTY-shaped stub whose size we control, and assert on
 * the BYTES it writes.
 */

/** A TTY-shaped stdout whose size we control, capturing every byte Ink writes. */
class FakeTty extends EventEmitter {
  isTTY = true
  writes: string[] = []

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }

  write(chunk: string): boolean {
    this.writes.push(chunk)

    return true
  }
}

/** A TTY-shaped stdin that supports raw mode, so Ink takes its interactive path and `useInput` binds. */
class FakeStdin extends EventEmitter {
  isTTY = true
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  read(): null {
    return null
  }

  setEncoding(): void {}
  ref(): void {}
  unref(): void {}
}

/**
 * Built from the code point rather than written as a regex literal: a literal would have to carry a raw
 * ESC control byte, which is invisible in review and trips `no-control-regex` (the same reason
 * `safe-stderr.ts` matches its escape with split/join).
 */
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-z]`, 'gi')

/** Height, in terminal rows, of the tallest frame Ink drew. This is the quantity Ink's overflow gate reads. */
const tallestFrame = (writes: string[]): number => {
  return writes.reduce((tallest, chunk) => {
    const lines = chunk.replace(ANSI, '').split('\n')

    // Ink terminates a frame with a trailing newline; that is a separator, not a row.
    if (lines.at(-1) === '') lines.pop()

    return Math.max(tallest, lines.length)
  }, 0)
}

/**
 * Render `element` at an exact terminal size, deliver one keystroke (so Ink commits a SECOND frame —
 * the overflow clear is gated on `hadPreviousFrame`, so a cold first frame never trips it and a
 * single-render test would be a false green), then report what Ink wrote.
 */
const drawAt = async (element: ReactElement, columns: number, rows: number) => {
  const stdout = new FakeTty(columns, rows)
  const stdin = new FakeStdin()
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  // A printable key: filters nothing (every fixture row contains an 'e'), but forces a re-render.
  stdin.emit('data', 'e')
  // Ink throttles frame writes (32ms); wait past it so the second frame is committed.
  await new Promise((resolve) => {
    return setTimeout(resolve, 80)
  })

  instance.unmount()
  await instance.waitUntilExit()

  const written = stdout.writes.join('')

  return {
    tallest: tallestFrame(stdout.writes),
    /** `ESC[2J` — Ink erasing the whole viewport. Only ever emitted when a frame overflows. */
    clearedScreen: written.includes(`${ESC}[2J`),
    /** `ESC[3J` — erase scrollback. `safe-stderr` strips it in production; it must never be needed. */
    erasedScrollback: written.includes(`${ESC}[3J`),
  }
}

/** The real palette: 25 commands in 3 groups, with the real (long, wrap-prone) descriptions. */
const paletteItems = (): PaletteItem[] => {
  const rows: [string, string, string][] = [
    ['merge-dev', 'Merge dev branch into every release branch', 'Release Management'],
    ['release-list', 'List all release branches', 'Release Management'],
    [
      'release-create',
      'Create one or more release branches (each entry can mix regular/hotfix and its own description)',
      'Release Management',
    ],
    [
      'release-desc-edit',
      "Edit a release's description in Jira and in the matching GitHub PR body",
      'Release Management',
    ],
    ['release-deploy-all', 'Deploy any release branch to any environment', 'Release Management'],
    [
      'release-deploy-selected',
      'Deploy selected services from release branch to any environment',
      'Release Management',
    ],
    ['release-deliver', 'Release a new version to production', 'Release Management'],
    ['worktrees-add', 'Add git worktrees for release branches', 'Worktrees'],
    ['worktrees-list', 'List all git worktrees with detailed information', 'Worktrees'],
    [
      'reopen',
      'Reopen editor + cmux windows for every active worktree in the current project (additive, idempotent)',
      'Worktrees',
    ],
    ['worktrees-remove', 'Remove git worktrees for release branches', 'Worktrees'],
    ['worktrees-sync', 'Remove release worktrees whose PRs are no longer open', 'Worktrees'],
    [
      'audit',
      'Audit against infra-kit.config.ts rules (--all for every package, --root for the monorepo root)',
      'Environment',
    ],
    ['vendor-check', 'Verify vendor/ matches vendor/.sync-manifest.json (self-contained)', 'Environment'],
    ['vendor-diff', 'Source-aware drift check (rsync dry-run) of each target vendored subtree', 'Environment'],
    ['vendor-config', 'Show the machine-local factory config (~/.infra-kit/vendor.json)', 'Environment'],
    ['config-path', 'Show the resolved config merge chain and file paths', 'Environment'],
    ['config-edit', 'Open the user-scope per-project override file in $EDITOR', 'Environment'],
    ['doctor', 'Check installation and authentication status of gh and doppler CLIs', 'Environment'],
    ['init', 'Inject shell integration into .zshrc and sync repo agent-instruction files', 'Environment'],
    ['version', 'Print the installed infra-kit CLI version', 'Environment'],
    ['env-status', 'Show which env is loaded in this session (local introspection; no Doppler call)', 'Environment'],
    ['env-list', 'List available Doppler configs for the detected project', 'Environment'],
    ['env-load', 'Load Doppler env vars for a config. Source the returned file path to apply.', 'Environment'],
    ['env-clear', 'Clear loaded env vars. Source the returned file path to apply.', 'Environment'],
  ]

  return rows.map(([name, description, group]) => {
    return { name, description, group }
  })
}

/** A branch list big enough to overflow: the failing repo had ~20 open releases. */
const branchItems = (count: number): BranchPickerItem[] => {
  return Array.from({ length: count }, (_, index) => {
    return {
      label: `release/v1.${85 + index}.0-with-a-deliberately-long-branch-name`,
      value: `release/v1.${85 + index}.0`,
      description: 'Migrate from legacy dealContent to new getFlightsDealsByParams in SEO pages',
      type: index % 3 === 0 ? 'hotfix' : 'regular',
    }
  })
}

/**
 * Hostile sizes. 80x24 is the default terminal and the one in the bug report; 60 and 40 columns force
 * every long description to wrap unless it is truncated; 10 and 7 rows are ordinary tmux splits and are
 * where a naive "one row per item" window still overflows on its chrome alone.
 */
const SIZES: [number, number][] = [
  [80, 24],
  [60, 24],
  [40, 24],
  [120, 40],
  [80, 12],
  [80, 10],
  [80, 8],
  [80, 7],
  [80, 5],
]

const noop = () => {}

describe('every Ink frame stays shorter than the viewport', () => {
  describe.each(SIZES)('at %ix%i', (columns, rows) => {
    it('commandPalette (25 commands, 3 groups)', async () => {
      const result = await drawAt(
        <CommandPalette items={paletteItems()} onSelect={noop} onCancel={noop} />,
        columns,
        rows,
      )

      expect(result.tallest).toBeLessThan(rows)
      expect(result.clearedScreen).toBe(false)
      expect(result.erasedScrollback).toBe(false)
    })

    it('branchPicker (30 branches)', async () => {
      const result = await drawAt(
        <BranchPicker items={branchItems(30)} onSelect={noop} onCancel={noop} />,
        columns,
        rows,
      )

      expect(result.tallest).toBeLessThan(rows)
      expect(result.clearedScreen).toBe(false)
      expect(result.erasedScrollback).toBe(false)
    })

    it('branchMultiPicker (30 branches)', async () => {
      const result = await drawAt(
        <BranchMultiPicker items={branchItems(30)} onSubmit={noop} onCancel={noop} />,
        columns,
        rows,
      )

      expect(result.tallest).toBeLessThan(rows)
      expect(result.clearedScreen).toBe(false)
      expect(result.erasedScrollback).toBe(false)
    })
  })
})
