import { describe, expect, it } from 'vitest'

import { getExposedMcpTools } from 'src/lib/command-catalog'
import { buildPaletteItems, resolveLeaf } from 'src/lib/command-catalog/palette'
import { buildProgram } from 'src/lib/program/program'
import { canPromptForDeploySource, resolveDeploySource } from 'src/lib/release-deploy'

const leaf = (path: string[]) => {
  return resolveLeaf(buildProgram().commands, path)
}

const optionFlags = (path: string[]) => {
  return (leaf(path)?.options ?? []).map((option) => {
    return option.long
  })
}

describe('--from wiring', () => {
  it.each([['deploy-all'], ['deploy-selected']])('registers --from on release %s with NO default', (name) => {
    const from = leaf(['release', name])?.options.find((option) => {
      return option.long === '--from'
    })

    expect(from).toBeDefined()
    // A default here would silently re-create the ambiguity the flag exists to remove, so the absence
    // of one is asserted rather than assumed. `parseDeploySource` is what turns "absent" into an error.
    expect(from?.defaultValue).toBeUndefined()
  })

  it('offers both sources’ flags on the merged commands', () => {
    const flags = optionFlags(['release', 'deploy-all'])

    expect(flags).toEqual(
      expect.arrayContaining(['--from', '--version', '--env', '--yes', '--skip-terraform', '--dry-run', '--print-env']),
    )
  })

  it('no longer offers --skip-preflight, whose only effect was defeating the clean-tree check', () => {
    expect(optionFlags(['release', 'deploy-all'])).not.toContain('--skip-preflight')
    expect(optionFlags(['release', 'deploy-selected'])).not.toContain('--skip-preflight')
    expect(optionFlags(['local', 'deploy-all'])).not.toContain('--skip-preflight')
  })

  it('exposes exactly one service flag on the merged command', () => {
    const flags = optionFlags(['release', 'deploy-selected'])

    expect(flags).toContain('--services')
    expect(flags).not.toContain('--service')
  })
})

describe('deprecated local aliases', () => {
  it.each([['deploy-all'], ['deploy-selected']])('local %s still resolves for anyone who types it', (name) => {
    expect(leaf(['local', name])).toBeDefined()
  })

  it.each([['deploy-all'], ['deploy-selected']])('local %s says what replaced it', (name) => {
    expect(leaf(['local', name])?.description()).toMatch(/Deprecated .*--from local/)
  })

  it('does not offer --from on the aliases, which are pinned to local', () => {
    expect(optionFlags(['local', 'deploy-all'])).not.toContain('--from')
  })

  it('keeps --service registered on the alias its forwarding depends on', () => {
    // program.ts forwards `options.service` into the merged args as `services`. Drop or rename this
    // flag and that forwarding silently yields undefined — a deploy-everything on a -selected command.
    expect(optionFlags(['local', 'deploy-selected'])).toContain('--service')
  })
})

describe('mCP surface is untouched by the CLI merge', () => {
  it('still advertises all four deploy tools under their original names', () => {
    const names = getExposedMcpTools().map((tool) => {
      return tool.name
    })

    expect(names).toEqual(
      expect.arrayContaining([
        'gh-release-deploy-all',
        'gh-release-deploy-selected',
        'local-deploy-all',
        'local-deploy-selected',
      ]),
    )
  })

  it('keeps every deploy tool behind the two-phase confirm gate', () => {
    const deployTools = getExposedMcpTools().filter((tool) => {
      return tool.name.includes('deploy-')
    })

    expect(deployTools).toHaveLength(4)

    for (const tool of deployTools) {
      expect(tool.requiresHumanConfirm).toBe(true)
    }
  })

  it('does not leak --from into any deploy tool’s input schema', () => {
    // The merge is a CLI-layer change on purpose: the MCP boundary auto-confirms every call, so a
    // source argument there would be chosen by an agent and confirmed by nobody.
    for (const tool of getExposedMcpTools()) {
      if (!tool.name.includes('deploy-')) continue

      expect(Object.keys(tool.inputSchema)).not.toContain('from')
    }
  })
})

describe('palette reachability', () => {
  // The palette and session shell spawn `[cliPath, ...groupPath]` with NO flags (session/run-session).
  // A required-and-unpromptable argument therefore turns a palette row into a row that fails the moment
  // it is picked — which is what `--from` did before it grew a picker. These rows are rendered, so they
  // must be runnable.
  it.each([['deploy-all'], ['deploy-selected']])('release %s is offered in the palette', (name) => {
    const rows = buildPaletteItems(buildProgram().commands).map((row) => {
      return row.name
    })

    expect(rows).toContain(`release ${name}`)
  })

  it('can resolve --from without argv when the run is interactive', async () => {
    expect(canPromptForDeploySource).toBeTypeOf('function')

    // Non-interactive is the strict half of the contract: no prompt, no default, hard error.
    await expect(resolveDeploySource(undefined)).rejects.toThrow(/--from is required/)
  })

  it('still accepts an explicit --from without prompting', async () => {
    await expect(resolveDeploySource('local')).resolves.toBe('local')
  })
})
