import type { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildProgram, commandPath } from 'src/entry/program'
import { JSON_SCHEMA_VERSION, jsonOutput, withEnvelope } from 'src/lib/json-output'

import { NO_JSON_COMMANDS, jsonOutputSchemas, jsonRefusalSchema } from '../json-contract'

const leafPaths = (): string[] => {
  const leaves: string[] = []

  const walk = (command: Command): void => {
    if (command.commands.length === 0) leaves.push(commandPath(command))

    for (const child of command.commands) walk(child)
  }

  walk(buildProgram())

  return leaves.sort()
}

describe('--json contract', () => {
  it('has a schema for every command that writes a document, and none for one that does not', () => {
    const expected = leafPaths().filter((path) => {
      return !NO_JSON_COMMANDS.includes(path)
    })

    expect(Object.keys(jsonOutputSchemas).sort()).toEqual(expected)
  })

  it.each(Object.keys(jsonOutputSchemas).sort())('`%s` carries the envelope in every shape', (path) => {
    const document = { schemaVersion: JSON_SCHEMA_VERSION, command: path }
    const schema = jsonOutputSchemas[path]!

    const arms = schema instanceof z.ZodUnion ? (schema.options as z.ZodObject[]) : [schema as z.ZodObject]

    for (const arm of arms) {
      expect(arm.pick({ schemaVersion: true, command: true }).parse(document)).toEqual(document)
      expect(arm.pick({ schemaVersion: true }).safeParse({ schemaVersion: 2 }).success).toBe(false)
    }
  })

  // The other half of `plugins/infra-kit/skills/ultraqa/__tests__/e2e-json.test.mjs`: the fixture that
  // test holds the skill's field names against must be a document the `e2e` schema accepts.
  it("parses the ultraqa skill's e2e fixture with the `e2e` schema", () => {
    const fixture = path.resolve(
      __dirname,
      '../../../../../../../plugins/infra-kit/skills/ultraqa/__tests__/__fixtures__/e2e-run.json',
    )

    expect(jsonOutputSchemas.e2e!.safeParse(JSON.parse(fs.readFileSync(fixture, 'utf8'))).error).toBeUndefined()
  })

  it('refusals carry the envelope too', () => {
    jsonOutput.command = 'release create'

    try {
      const document = withEnvelope({ status: 'argument_required', argument: 'version', agentMode: 'flag' })

      expect(jsonRefusalSchema.parse(document)).toEqual(document)
    } finally {
      jsonOutput.command = ''
    }
  })

  /**
   * The reviewable form of the contract. A diff here is a change to what `--json` consumers parse:
   * adding a key is fine at `schemaVersion: 1`; renaming, removing or retyping one needs a bump.
   */
  it('matches the committed contract snapshot', () => {
    const contract = Object.fromEntries(
      Object.keys(jsonOutputSchemas)
        .sort()
        .map((path) => {
          return [path, z.toJSONSchema(jsonOutputSchemas[path]!, { unrepresentable: 'any' })]
        }),
    )

    expect({ refusal: z.toJSONSchema(jsonRefusalSchema), commands: contract }).toMatchSnapshot()
  })
})
