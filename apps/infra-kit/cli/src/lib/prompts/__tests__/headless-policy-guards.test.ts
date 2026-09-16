import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { exposedTools, promptSites, reachableSites } from './mcp-reachable-prompt-sites'

/**
 * @fileoverview
 * G8 and G6 — the two checks that make a `whenHeadless` answer TRUE rather than merely well-typed.
 *
 * A sibling guard in `every-inquirer-site-is-escapable.test.ts` requires every MCP-reachable
 * `withEscape` site to WRITE an answer. Writing one does not make it right, and neither of the two
 * wrong answers can fail anything on its own:
 *
 * - G8 — `{ refuse: '<argument>' }` names the argument an agent must pass on the re-run. That name
 *   is a claim about SOMEONE ELSE'S Zod schema: if the field is renamed there, the refusal names
 *   something no tool accepts, in a file that never mentions prompts. This is what makes that
 *   mechanical. (It used to check `'unreachable'` claims — "a required field stops an agent getting
 *   here" — until the CLI became a Bash-driven agent surface with no schema in front of a prompt.)
 * - G6 — a tool's description and its `.describe()` strings are the only place an agent is told what
 *   a headless call gets. `worktrees-add` promised `false` for two years while the code fell through
 *   to a `confirm()` writing into the JSON-RPC transport. This compares the prose to the code.
 *
 * Both read the LIVE tool objects (`getExposedMcpTools()`), never a transcription of them.
 */

/**
 * Reachable sites whose answer is something other than the refuse default, keyed
 * `<file>#<enclosing fn>` — a key that survives the edits a line number does not.
 *
 * `tools` are the exposed MCP tools that can reach the site; `fields` are the input fields the
 * answer's truth rests on. G8 re-derives each field from the site's own `{ refuse: '<name>' }`
 * literal and cross-checks it here, so the table and the source have to agree with each other
 * before either is compared to the schema.
 */
const POLICY_SITES: Record<string, { policy: 'argument' | 'value'; tools: string[]; fields: string[] }> = {
  // NOT listed any more: `gh-release-deploy-selected#ghReleaseDeploySelected`,
  // `lib/prompts/env-picker.ts#pickEnv`, `env-load.ts#envLoad`, and the three
  // `release-create.ts#promptForVersionInput` / `#promptForNameInput` / `#promptForReleasesInteractive`
  // sites. The first two claimed `'unreachable'` until PR-1 relaxed `services` and `env` to
  // `.optional()` so the form could offer real lists — at which point G8 named all five claims false in
  // one run. `env-load` followed when `config` went `.optional()` for its own form, and `release-create`
  // when `releases` did — G8 named all six of its claims false in one run. They now declare `'refuse'`
  // at the call site, which this table does not track by design. That transition is what G8 was for,
  // and those are the only times it has fired in anger.
  // `local-deploy-all` never reaches `pickServices` — it takes the `selection === 'all'` branch
  // above it — so `local-deploy-selected` is the only owner, and `service` is the field.
  'commands/local-deploy/local-deploy.ts#pickServices': {
    policy: 'argument',
    tools: ['local-deploy-selected'],
    fields: ['service'],
  },
  'commands/release-desc-edit/release-desc-edit.ts#promptDescription': {
    policy: 'argument',
    tools: ['release-desc-edit'],
    fields: ['description'],
  },
  // The two sites whose answer is a VALUE rather than a claim, and the defect this file exists to
  // have caught: both `.describe()` strings promised "false (MCP, no TTY)" while the code prompted.
  // One helper per follow-up since the Orca migration moved them ahead of the confirm.
  'commands/worktrees-add/worktrees-add.ts#resolveGithubDesktopFollowUp': {
    policy: 'value',
    tools: ['worktrees-add'],
    fields: ['githubDesktop'],
  },
  'commands/worktrees-add/worktrees-add.ts#resolveOrcaFollowUp': {
    policy: 'value',
    tools: ['worktrees-add'],
    fields: ['orca'],
  },
}

/** Prose that tells an agent what a headless call gets. G6 asserts only on tools carrying it. */
const PROMISE = /without a TTY|no TTY|required for MCP|required when invoked via MCP/i

/** Every input field the tool declares — the names a refusal may legitimately tell an agent to pass. */
const declaredFields = (name: string): Set<string> => {
  const tool = exposedTools.find((candidate) => {
    return candidate.name === name
  })

  return new Set(tool ? Object.keys(z.object(tool.inputSchema).shape) : [])
}

/**
 * Exposed tools whose prose tells an agent what happens with no human: either a fixed value
 * ("interactive prompt (CLI) / false (MCP, no TTY)") or a field it MUST pass because the prompt
 * cannot run. Read from the live tool objects, not from a hand-kept list, so deleting the promise
 * from a description changes what this guard asserts instead of leaving it asserting a fiction.
 */
const promiseCarryingTools = new Set(
  exposedTools
    .filter((tool) => {
      const described = Object.values(tool.inputSchema).map((field) => {
        return (field as { description?: string }).description ?? ''
      })

      return PROMISE.test([tool.description, ...described].join(' '))
    })
    .map((tool) => {
      return tool.name
    }),
)

describe('the site table tracks the code it makes claims about', () => {
  it('declares every reachable site that answers with anything but refuse', () => {
    const undeclared = reachableSites
      .filter((site) => {
        return site.policy !== 'refuse' && site.policy !== 'default' && POLICY_SITES[site.key] === undefined
      })
      .map((site) => {
        return `${site.where} (${site.key})`
      })

    expect(undeclared).toEqual([])
  })

  it('has no row that no longer matches a reachable site', () => {
    const live = new Set(
      reachableSites.map((site) => {
        return site.key
      }),
    )
    const stale = Object.keys(POLICY_SITES).filter((key) => {
      return !live.has(key)
    })

    expect(stale).toEqual([])
  })

  it('keeps each declared site on the policy the table records', () => {
    const drifted = reachableSites
      .filter((site) => {
        const entry = POLICY_SITES[site.key]

        return entry !== undefined && site.policy !== entry.policy
      })
      .map((site) => {
        return `${site.where} is ${site.policy}, table says ${POLICY_SITES[site.key]?.policy}`
      })

    expect(drifted).toEqual([])
  })
})

describe('g8 — every `{ refuse: <argument> }` names a field the owning tool declares', () => {
  it('still has argument-naming sites to check (the guard is not vacuous)', () => {
    const named = promptSites.filter((site) => {
      return site.policy === 'argument'
    })

    expect(named.length).toBeGreaterThanOrEqual(2)
  })

  it('agrees with the site table about which field the refusal names', () => {
    const mismatched = promptSites
      .filter((site) => {
        return site.policy === 'argument'
      })
      .filter((site) => {
        const entry = POLICY_SITES[site.key]

        return entry === undefined || site.field === null || !entry.fields.includes(site.field)
      })
      .map((site) => {
        return `${site.where} names \`${site.field}\`, table says ${POLICY_SITES[site.key]?.fields.join('/') ?? 'nothing'}`
      })

    expect(mismatched).toEqual([])
  })

  it('finds that field DECLARED in every owning tool inputSchema', () => {
    // The whole point. `argument_required` tells an agent "pass `<name>` and re-run"; a name no
    // tool accepts is a refusal with no exit, and renaming the field happens in a file that never
    // mentions prompts, with nothing else in the tree noticing.
    const broken = promptSites
      .filter((site) => {
        return site.policy === 'argument' && site.field !== null
      })
      .flatMap((site) => {
        const entry = POLICY_SITES[site.key]
        const field = site.field as string

        return (entry?.tools ?? []).flatMap((tool) => {
          return declaredFields(tool).has(field) ? [] : [`${site.where}: \`${field}\` is not declared on ${tool}`]
        })
      })

    expect(broken).toEqual([])
  })
})

describe('g6 — a tool that promises a non-interactive answer must not refuse', () => {
  const declared = Object.entries(POLICY_SITES).flatMap(([key, entry]) => {
    return entry.tools.map((tool) => {
      return { key, tool }
    })
  })

  it('reads the promise out of the tools rather than trusting a list', () => {
    // These tools document, in prose an agent actually receives, that an MCP call gets a value or is
    // blocked outright. That is a CLAIM about the code below them, and this is the only place the
    // two are ever compared.
    //
    // The two `gh-release-deploy-*` tools and `env-load` USED to be on this list and deliberately are
    // not any more. Their promise was "required when invoked via MCP (interactive pickers are
    // unavailable without a TTY)" — a true statement about a required field. PR-1 made the deploy
    // fields `.optional()` so a form could offer the real releases, environments and services, and
    // `env-load`'s `config` followed for its own form, so the promise stopped being true and was
    // removed with the same change. `local-deploy-selected` stays because its `service` is still
    // required and still says so. Removing a tool from here is only legitimate when its prose changed;
    // this row exists so that dropping one silently cannot happen.
    expect([...promiseCarryingTools]).toEqual(
      expect.arrayContaining(['release-desc-edit', 'worktrees-add', 'local-deploy-selected']),
    )
  })

  it('keeps env-load off the promise list now that a form, not a required field, owns the headless answer', () => {
    // The description now says "omit config and a form is offered", which is a claim about the seam
    // rather than about this handler's own prompt. Re-matching `PROMISE` would drag the `'refuse'`
    // picker back under the "never refuse" assertion below and red it for the right tool with the
    // wrong reason.
    expect(promiseCarryingTools.has('env-load')).toBe(false)
  })

  it('keeps release-create off the promise list now that a form, not a required field, owns the headless answer', () => {
    // Same shape as `env-load`: the description says "omit releases and a form is offered", a claim
    // about the seam, not a promise of a value from the wizard's six `'refuse'` sites.
    expect(promiseCarryingTools.has('release-create')).toBe(false)
  })

  it('never leaves a promised tool site on a NAMELESS refuse', () => {
    // The `worktrees-add` shape of the defect: the `.describe()` says an MCP caller gets `false`,
    // and the code threw instead. A refusal is not the documented answer, so it breaks a promise
    // the schema itself advertises — and nothing but this compares the two. An `'argument'` refusal
    // is NOT on this list: "required for MCP" is a promise that the field must be passed, and a
    // refusal naming that field keeps it.
    const broken = declared
      .filter((pair) => {
        return promiseCarryingTools.has(pair.tool)
      })
      .flatMap((pair) => {
        return reachableSites
          .filter((site) => {
            return site.key === pair.key && (site.policy === 'refuse' || site.policy === 'default')
          })
          .map((site) => {
            return `${site.where} resolves to refuse, but ${pair.tool} promises otherwise`
          })
      })

    expect(broken).toEqual([])
  })
})
