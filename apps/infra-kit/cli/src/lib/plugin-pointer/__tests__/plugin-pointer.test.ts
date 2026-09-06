import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MARKETPLACE_NAME, PLUGIN_KEY, ensurePluginPointer } from '../plugin-pointer'

/**
 * I7/I8 — `init`'s merge into a consumer's `.claude/settings.json` must be additive and nothing else.
 *
 * The fixture is the REAL shape of a consumer repo's settings file (hulyo-monorepo's, as of this
 * commit): six `permissions.deny` entries, five `hooks` events, nine `enabledPlugins` and three
 * `extraKnownMarketplaces`. A synthetic two-key fixture would pass while destroying exactly what
 * makes this risky.
 *
 * Real temp dirs throughout, no fs mocking: the round-trip these tests assert (parse → mutate →
 * re-serialize is byte-identical apart from the additions) is a property of the actual file bytes,
 * and a mocked fs would assert it against a string we invented.
 */

const FIXTURE = `{
  "permissions": {
    "deny": [
      "Bash(doppler secrets:*)",
      "Bash(pnpm exec infra-kit release-deliver:*)",
      "Bash(pnpm exec infra-kit release deliver:*)",
      "Bash(pnpm exec ik release-deliver:*)",
      "Bash(pnpm exec ik release deliver:*)",
      "Bash(ik release deliver:*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/bash-launcher.mjs"
          },
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/bash-guard.mjs"
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/protect-files.mjs"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/edit-pipeline.mjs",
            "timeout": 90
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/quality-gate.mjs",
            "timeout": 600
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/setup-env.mjs"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/session-end.mjs"
          }
        ]
      }
    ]
  },
  "enabledPlugins": {
    "oh-my-claudecode@omc": true,
    "chrome-devtools-mcp@chrome-devtools-plugins": true,
    "playwright@claude-plugins-official": true,
    "context7@claude-plugins-official": true,
    "atlassian@claude-plugins-official": true,
    "commit-commands@claude-plugins-official": true,
    "frontend-design@claude-plugins-official": true,
    "context-mode@context-mode": true,
    "typescript-lsp@claude-plugins-official": true
  },
  "extraKnownMarketplaces": {
    "context-mode": {
      "source": {
        "source": "github",
        "repo": "mksglu/context-mode"
      }
    },
    "chrome-devtools-plugins": {
      "source": {
        "source": "github",
        "repo": "ChromeDevTools/chrome-devtools-mcp"
      }
    },
    "omc": {
      "source": {
        "source": "git",
        "url": "https://github.com/Yeachan-Heo/oh-my-claudecode.git"
      }
    }
  }
}
`

let dir: string
let settingsPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pointer-'))
  settingsPath = path.join(dir, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const write = (content: string): void => {
  fs.writeFileSync(settingsPath, content, 'utf-8')
}

const read = (): string => {
  return fs.readFileSync(settingsPath, 'utf-8')
}

/**
 * The fixture's exact bytes with the two additions spliced in by hand — commas, indentation and
 * position included. Comparing against this rather than against a re-serialization is what makes the
 * assertion a byte test: a run that reindented the file, resorted a key, or moved the trailing comma
 * fails here and passes any parsed comparison.
 */
const EXPECTED = FIXTURE.replace(
  '    "typescript-lsp@claude-plugins-official": true\n  }',
  '    "typescript-lsp@claude-plugins-official": true,\n    "infra-kit@infra-kit": true\n  }',
).replace(
  '        "url": "https://github.com/Yeachan-Heo/oh-my-claudecode.git"\n      }\n    }\n  }',
  [
    '        "url": "https://github.com/Yeachan-Heo/oh-my-claudecode.git"',
    '      }',
    '    },',
    '    "infra-kit": {',
    '      "source": {',
    '        "source": "github",',
    '        "repo": "ArthurSaenz/infra-kit"',
    '      }',
    '    }',
    '  }',
  ].join('\n'),
)

describe('ensurePluginPointer — the fixture merge (I7)', () => {
  it('adds exactly the two keys and changes nothing else', () => {
    write(FIXTURE)

    const result = ensurePluginPointer(settingsPath)

    expect(result.status).toBe('added')
    expect(result.added).toEqual(['extraKnownMarketplaces.infra-kit', 'enabledPlugins.infra-kit@infra-kit'])

    const after = JSON.parse(read()) as Record<string, Record<string, unknown>>

    expect(after.enabledPlugins?.[PLUGIN_KEY]).toBe(true)
    expect(after.extraKnownMarketplaces?.[MARKETPLACE_NAME]).toEqual({
      source: { source: 'github', repo: 'ArthurSaenz/infra-kit' },
    })

    // Every other key, parsed, is untouched.
    delete after.enabledPlugins?.[PLUGIN_KEY]
    delete after.extraKnownMarketplaces?.[MARKETPLACE_NAME]
    expect(after).toEqual(JSON.parse(FIXTURE))
  })

  it('produces the original bytes plus the two additions, and nothing else', () => {
    // Guard the guard: a fixture edit that breaks either splice would otherwise make this vacuous.
    expect(EXPECTED).not.toBe(FIXTURE)
    expect(EXPECTED).toContain('"infra-kit@infra-kit": true')
    expect(EXPECTED).toContain('"repo": "ArthurSaenz/infra-kit"')

    write(FIXTURE)
    ensurePluginPointer(settingsPath)

    expect(read()).toBe(EXPECTED)
  })

  it('preserves key order — the two keys are appended, nothing is resorted', () => {
    write(FIXTURE)
    ensurePluginPointer(settingsPath)

    const parsed = JSON.parse(read()) as Record<string, Record<string, unknown>>

    expect(Object.keys(parsed)).toEqual(['permissions', 'hooks', 'enabledPlugins', 'extraKnownMarketplaces'])
    expect(Object.keys(parsed.enabledPlugins ?? {}).at(-1)).toBe(PLUGIN_KEY)
    expect(Object.keys(parsed.extraKnownMarketplaces ?? {}).at(-1)).toBe(MARKETPLACE_NAME)
    expect(Object.keys(parsed.enabledPlugins ?? {})).toHaveLength(10)
    expect(Object.keys(parsed.hooks ?? {})).toHaveLength(5)
  })

  it('keeps every hook event and deny entry intact', () => {
    write(FIXTURE)
    ensurePluginPointer(settingsPath)

    const parsed = JSON.parse(read()) as { permissions: { deny: string[] }; hooks: Record<string, unknown> }

    expect(parsed.permissions.deny).toHaveLength(6)
    expect(Object.keys(parsed.hooks)).toEqual([
      'PreToolUse',
      'PostToolUse',
      'TaskCompleted',
      'SessionStart',
      'SessionEnd',
    ])
  })
})

describe('ensurePluginPointer — idempotence', () => {
  it('second run is a no-op: no write, mtime unchanged', async () => {
    write(FIXTURE)
    ensurePluginPointer(settingsPath)

    const first = read()
    const mtime = fs.statSync(settingsPath).mtimeMs

    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })

    const second = ensurePluginPointer(settingsPath)

    expect(second.status).toBe('unchanged')
    expect(second.added).toEqual([])
    expect(read()).toBe(first)
    expect(fs.statSync(settingsPath).mtimeMs).toBe(mtime)
  })

  it('leaves a deliberate `false` opt-out alone', () => {
    write(`{\n  "enabledPlugins": {\n    "${PLUGIN_KEY}": false\n  }\n}\n`)

    const result = ensurePluginPointer(settingsPath)

    expect(result.status).toBe('added')
    expect(result.added).toEqual(['extraKnownMarketplaces.infra-kit'])
    expect((JSON.parse(read()) as { enabledPlugins: Record<string, unknown> }).enabledPlugins[PLUGIN_KEY]).toBe(false)
  })

  it('never overwrites an existing marketplace entry pointing elsewhere', () => {
    write(
      `{\n  "extraKnownMarketplaces": {\n    "${MARKETPLACE_NAME}": { "source": { "source": "git", "url": "file:///local" } }\n  }\n}\n`,
    )

    ensurePluginPointer(settingsPath)

    const parsed = JSON.parse(read()) as { extraKnownMarketplaces: Record<string, unknown> }

    expect(parsed.extraKnownMarketplaces[MARKETPLACE_NAME]).toEqual({
      source: { source: 'git', url: 'file:///local' },
    })
  })
})

describe('ensurePluginPointer — file creation and formatting', () => {
  it('creates an absent file with only the two keys', () => {
    const result = ensurePluginPointer(settingsPath)

    expect(result.status).toBe('created')
    expect(read()).toBe(
      [
        '{',
        '  "extraKnownMarketplaces": {',
        '    "infra-kit": {',
        '      "source": {',
        '        "source": "github",',
        '        "repo": "ArthurSaenz/infra-kit"',
        '      }',
        '    }',
        '  },',
        '  "enabledPlugins": {',
        '    "infra-kit@infra-kit": true',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('creates the .claude directory when it does not exist', () => {
    const nested = path.join(dir, 'fresh-repo', '.claude', 'settings.json')

    expect(ensurePluginPointer(nested).status).toBe('created')
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('preserves a four-space indent rather than reformatting the file', () => {
    write('{\n    "enabledPlugins": {\n        "omc@omc": true\n    }\n}\n')
    ensurePluginPointer(settingsPath)

    expect(read()).toContain('\n    "enabledPlugins"')
    expect(read()).toContain('\n        "infra-kit@infra-kit": true')
  })

  it('preserves a tab indent', () => {
    write('{\n\t"enabledPlugins": {\n\t\t"omc@omc": true\n\t}\n}\n')
    ensurePluginPointer(settingsPath)

    expect(read()).toContain('\n\t"enabledPlugins"')
  })

  it('preserves the absence of a trailing newline', () => {
    write('{\n  "enabledPlugins": {\n    "omc@omc": true\n  }\n}')
    ensurePluginPointer(settingsPath)

    expect(read().endsWith('}')).toBe(true)
  })
})

describe('ensurePluginPointer — unparseable input (I8)', () => {
  it('writes nothing and reports the status', () => {
    const broken = '{ "enabledPlugins": { "omc@omc": true, }  // trailing comma + comment\n'

    write(broken)

    const mtime = fs.statSync(settingsPath).mtimeMs
    const result = ensurePluginPointer(settingsPath)

    expect(result.status).toBe('unparseable')
    expect(result.added).toEqual([])
    expect(read()).toBe(broken)
    expect(fs.statSync(settingsPath).mtimeMs).toBe(mtime)
  })

  it('treats a JSON array as unparseable rather than merging into it', () => {
    write('[]\n')

    expect(ensurePluginPointer(settingsPath).status).toBe('unparseable')
    expect(read()).toBe('[]\n')
  })

  it('leaves a non-object container alone instead of clobbering it', () => {
    write('{\n  "enabledPlugins": "nope"\n}\n')

    const result = ensurePluginPointer(settingsPath)

    expect(result.added).toEqual(['extraKnownMarketplaces.infra-kit'])
    expect((JSON.parse(read()) as { enabledPlugins: unknown }).enabledPlugins).toBe('nope')
  })
})
