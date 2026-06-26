import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'

import { addJsonOption, emit, jsonOutput } from '../json-output'

describe('json-output', () => {
  afterEach(() => {
    jsonOutput.enabled = false
  })

  describe('emit', () => {
    it('writes structuredContent as pretty JSON when enabled', () => {
      jsonOutput.enabled = true
      const writes: string[] = []

      const result = emit({ structuredContent: { version: '1.2.3' } }, (text) => {
        writes.push(text)
      })

      expect(writes).toHaveLength(1)
      const [payload = ''] = writes

      expect(JSON.parse(payload)).toEqual({ version: '1.2.3' })
      // returns the result unchanged for pass-through use (emit(await handler()))
      expect(result).toEqual({ structuredContent: { version: '1.2.3' } })
    })

    it('is a no-op when json mode is disabled', () => {
      jsonOutput.enabled = false
      const writes: string[] = []

      emit({ structuredContent: { a: 1 } }, (text) => {
        writes.push(text)
      })

      expect(writes).toHaveLength(0)
    })

    it('writes nothing when structuredContent is undefined or null, even if enabled', () => {
      jsonOutput.enabled = true
      const writes: string[] = []

      emit(undefined, (text) => {
        writes.push(text)
      })
      emit({}, (text) => {
        writes.push(text)
      })
      emit({ structuredContent: null }, (text) => {
        writes.push(text)
      })

      expect(writes).toHaveLength(0)
    })
  })

  // Regression: `--json` must activate on grouped/nested subcommands, not just
  // flat top-level commands. Commander binds a post-subcommand `--json` to the
  // parent group, so the preAction hook must read `optsWithGlobals()`, not
  // `opts()`. This drives the real Commander parse path end-to-end.
  describe('grouped subcommand --json (regression)', () => {
    const buildProgram = (writes: string[]): Command => {
      const program = new Command()
      const group = program.command('group')

      group.command('leaf').action(() => {
        emit({ structuredContent: { ok: true } }, (text) => {
          writes.push(text)
        })
      })

      program.commands.forEach(addJsonOption)
      program.hook('preAction', (_thisCommand, actionCommand) => {
        jsonOutput.enabled = Boolean(actionCommand.optsWithGlobals().json)
      })

      return program
    }

    it('emits JSON for `group leaf --json` (post-subcommand flag on a nested command)', async () => {
      const writes: string[] = []

      await buildProgram(writes).parseAsync(['node', 'cli', 'group', 'leaf', '--json'])

      expect(writes).toHaveLength(1)
      const [payload = ''] = writes

      expect(JSON.parse(payload)).toEqual({ ok: true })
    })

    it('emits nothing for `group leaf` without --json', async () => {
      const writes: string[] = []

      await buildProgram(writes).parseAsync(['node', 'cli', 'group', 'leaf'])

      expect(writes).toHaveLength(0)
    })
  })

  describe('addJsonOption', () => {
    it('registers --json on a command', () => {
      const cmd = new Command('demo')

      addJsonOption(cmd)

      expect(
        cmd.options.some((option) => {
          return option.long === '--json'
        }),
      ).toBe(true)
    })

    it('is idempotent (does not double-register)', () => {
      const cmd = new Command('demo')

      addJsonOption(cmd)
      addJsonOption(cmd)

      const jsonOptions = cmd.options.filter((option) => {
        return option.long === '--json'
      })

      expect(jsonOptions).toHaveLength(1)
    })

    it('registers --json on nested subcommands too', () => {
      const parent = new Command('parent')
      const child = parent.command('child')

      addJsonOption(parent)

      expect(
        child.options.some((option) => {
          return option.long === '--json'
        }),
      ).toBe(true)
    })
  })
})
