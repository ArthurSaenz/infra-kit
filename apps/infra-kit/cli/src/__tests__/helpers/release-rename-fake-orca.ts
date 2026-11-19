import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Type-only, so node's type stripping erases it: a runtime import would need a `.ts` specifier tsc refuses.
import type { FailRule } from './release-rename-fake-gh'

const SCRUBBED_ENV_PATTERN = /^(?:GH_|GITHUB_|JIRA_|DOPPLER_|ORCA_|INFRA_KIT_)/

const collectScrubbedEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return SCRUBBED_ENV_PATTERN.test(entry[0]) && entry[1] !== undefined
    }),
  )
}

const writeJsonAtomic = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`

  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

/**
 * @fileoverview
 * The fake `orca` of the release-rename fixture, run as `node <this file> <config.json> ...argv`. It answers
 * the envelope (`{ ok, result | error }`) `src/integrations/orca/run-orca.ts` reads — errors only in the
 * envelope, as the real CLI does. A worktree selector resolves when its directory exists on disk, so a
 * `terminal create` after the move sees the moved path and not a remembered one.
 */

/** `not-running` is how `probeOrca` reads an app that is closed; `absent` is a missing binary (exit 127). */
export type OrcaMode = 'ready' | 'not-running' | 'absent'

export interface FakeOrcaTerminal {
  handle: string
  title: string
  worktree: string
}

export interface OrcaState {
  mode: OrcaMode
  terminals: FakeOrcaTerminal[]
  repos: { path: string; externalWorktreeVisibility: 'show' | 'hide' }[]
  nextHandle: number
  failOn: FailRule[]
}

export interface FakeOrcaConfig {
  statePath: string
  logPath: string
  unhandledPath: string
  gitBin: string
}

interface Envelope {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface Context {
  state: OrcaState
  config: FakeOrcaConfig
  argv: string[]
  dirty: boolean
}

class Unhandled extends Error {}

const SHELL_COMMAND_NOT_FOUND = 127

const success = (result: unknown): Envelope => {
  return { ok: true, result }
}

const refusal = (code: string, message: string): Envelope => {
  return { ok: false, error: { code, message } }
}

/** `--flag value` pairs after the two verb tokens; a bare boolean flag (`--all`, `--focus`) maps to `''`. */
const BOOLEAN_FLAGS = new Set(['--all', '--focus'])

const readFlags = (tokens: string[]): Map<string, string> => {
  const flags = new Map<string, string>()
  let pending: string | undefined

  for (const token of tokens) {
    if (pending !== undefined) {
      flags.set(pending, token)
      pending = undefined
    } else if (BOOLEAN_FLAGS.has(token)) {
      flags.set(token, '')
    } else if (token.startsWith('--')) {
      pending = token
    } else {
      throw new Unhandled(`unexpected token ${token}`)
    }
  }

  if (pending !== undefined) throw new Unhandled(`flag ${pending} has no value`)

  return flags
}

const flagsOf = (context: Context, skip: number, allowed: string[]): Map<string, string> => {
  const flags = readFlags(context.argv.slice(skip))

  const unknown = [...flags.keys()].filter((flag) => {
    return !allowed.includes(flag)
  })

  if (unknown.length > 0) throw new Unhandled(`unsupported flag(s) ${unknown.join(', ')}`)

  return flags
}

const pathSelector = (selector: string | undefined): string => {
  if (!selector?.startsWith('path:')) throw new Unhandled(`unsupported selector ${selector}`)

  return selector.slice('path:'.length)
}

const status = (context: Context): Envelope => {
  const running = context.state.mode === 'ready'

  return success({ app: { running }, runtime: { reachable: running, appVersion: '1.4.999' } })
}

const terminalsIn = (context: Context, worktree: string): FakeOrcaTerminal[] => {
  return context.state.terminals.filter((terminal) => {
    return terminal.worktree === worktree
  })
}

const terminalList = (context: Context): Envelope => {
  const worktree = pathSelector(flagsOf(context, 2, ['--worktree', '--limit']).get('--worktree'))

  if (!existsSync(worktree)) return refusal('selector_not_found', `no worktree at ${worktree}`)

  return success({
    terminals: terminalsIn(context, worktree).map((terminal) => {
      return { handle: terminal.handle, title: terminal.title, tabId: 'tab-1', connected: true, orphaned: false }
    }),
    truncated: false,
  })
}

const closeAll = (context: Context, worktree: string): Envelope => {
  if (terminalsIn(context, worktree).length > 0) {
    return refusal('terminal_close_incomplete', 'live terminals remain')
  }

  if (!existsSync(worktree)) return refusal('selector_not_found', `no worktree at ${worktree}`)

  return success({ closed: 0 })
}

const terminalClose = (context: Context): Envelope => {
  const flags = flagsOf(context, 2, ['--terminal', '--worktree', '--all'])

  if (flags.has('--worktree') && flags.has('--all')) return closeAll(context, pathSelector(flags.get('--worktree')))

  const handle = flags.get('--terminal')

  if (handle === undefined) throw new Unhandled('terminal close without --terminal or --worktree --all')

  const before = context.state.terminals.length

  context.state.terminals = context.state.terminals.filter((terminal) => {
    return terminal.handle !== handle
  })

  if (context.state.terminals.length === before) return refusal('terminal_not_found', `no terminal ${handle}`)

  context.dirty = true

  return success({ closed: 1 })
}

const addTerminal = (context: Context, worktree: string, title: string): string => {
  const handle = `term-${context.state.nextHandle}`

  context.state.nextHandle += 1
  context.state.terminals.push({ handle, title, worktree })
  context.dirty = true

  return handle
}

const terminalCreate = (context: Context): Envelope => {
  const flags = flagsOf(context, 2, ['--worktree', '--title', '--focus'])
  const worktree = pathSelector(flags.get('--worktree'))

  if (!existsSync(worktree)) return refusal('selector_not_found', `no worktree at ${worktree}`)

  return success({ terminal: { handle: addTerminal(context, worktree, flags.get('--title') ?? '') } })
}

const terminalSplit = (context: Context): Envelope => {
  const flags = flagsOf(context, 2, ['--terminal', '--direction'])

  const parent = context.state.terminals.find((terminal) => {
    return terminal.handle === flags.get('--terminal')
  })

  if (!parent) return refusal('terminal_not_found', `no terminal ${flags.get('--terminal')}`)

  return success({ split: { handle: addTerminal(context, parent.worktree, parent.title) } })
}

const repoList = (context: Context): Envelope => {
  flagsOf(context, 2, [])

  return success({ repos: context.state.repos })
}

const repoAdd = (context: Context): Envelope => {
  const path = flagsOf(context, 2, ['--path']).get('--path')

  if (path === undefined) throw new Unhandled('repo add without --path')

  const repo = { path, externalWorktreeVisibility: 'hide' as const }

  context.state.repos.push(repo)
  context.dirty = true

  return success({ repo })
}

// Read from git, not stored: Orca's sidebar lists what `git worktree list` reports for the repo.
const worktreeList = (context: Context): Envelope => {
  const repo = pathSelector(flagsOf(context, 2, ['--repo', '--limit']).get('--repo'))

  const listing = spawnSync(context.config.gitBin, ['-C', repo, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  })

  if (listing.status !== 0) return refusal('selector_not_found', `no repo at ${repo}`)

  const worktrees = listing.stdout
    .split('\n')
    .filter((line) => {
      return line.startsWith('worktree ')
    })
    .map((line) => {
      return { path: line.slice('worktree '.length) }
    })

  return success({ worktrees })
}

const HANDLERS = new Map<string, (context: Context) => Envelope>([
  ['status', status],
  ['terminal list', terminalList],
  ['terminal close', terminalClose],
  ['terminal create', terminalCreate],
  ['terminal split', terminalSplit],
  ['repo list', repoList],
  ['repo add', repoAdd],
  ['worktree list', worktreeList],
])

const dispatch = (context: Context): Envelope => {
  const [group, verb] = context.argv
  const handler = group === 'status' ? HANDLERS.get('status') : HANDLERS.get(`${group} ${verb}`)

  if (!handler) throw new Unhandled('unsupported command')
  if (group === 'status' && context.argv.length !== 1) throw new Unhandled('status takes no arguments')

  return handler(context)
}

const injectedFailure = (state: OrcaState, joined: string): Envelope | null => {
  const rule = state.failOn.find((candidate) => {
    return joined.includes(candidate.match)
  })

  if (!rule) return null

  if (rule.once)
    state.failOn = state.failOn.filter((candidate) => {
      return candidate !== rule
    })

  return refusal('injected_failure', rule.message ?? `fake orca: injected failure on "${rule.match}"`)
}

const answer = (config: FakeOrcaConfig, argv: string[]): Envelope => {
  const state = JSON.parse(readFileSync(config.statePath, 'utf8')) as OrcaState
  const injected = injectedFailure(state, argv.join(' '))

  if (injected) {
    writeJsonAtomic(config.statePath, state)

    return injected
  }

  if (state.mode === 'not-running' && argv[0] !== 'status') {
    return refusal('runtime_unavailable', 'Orca is not running')
  }

  const context: Context = { state, config, argv, dirty: false }
  const envelope = dispatch(context)

  if (context.dirty) writeJsonAtomic(config.statePath, context.state)

  return envelope
}

const respond = (config: FakeOrcaConfig, argv: string[], logLine: string): void => {
  const state = JSON.parse(readFileSync(config.statePath, 'utf8')) as OrcaState

  if (state.mode === 'absent') {
    process.stderr.write('orca: command not found\n')
    process.exitCode = SHELL_COMMAND_NOT_FOUND

    return
  }

  // Every real call ends in `--json` (run-orca.ts appends it); without it there is no envelope to read.
  if (argv.at(-1) !== '--json') throw new Unhandled('missing trailing --json')

  try {
    process.stdout.write(`${JSON.stringify(answer(config, argv.slice(0, -1)))}\n`)
  } catch (error) {
    if (!(error instanceof Unhandled)) throw error

    appendFileSync(config.unhandledPath, logLine)
    process.stderr.write(`fake orca: unhandled invocation (${error.message}): orca ${JSON.stringify(argv)}\n`)
    process.exitCode = 2
  }
}

const main = (): void => {
  const [configPath, ...argv] = process.argv.slice(2)
  const config = JSON.parse(readFileSync(configPath!, 'utf8')) as FakeOrcaConfig
  const logLine = `${JSON.stringify({ argv, env: collectScrubbedEnv(process.env) })}\n`

  appendFileSync(config.logPath, logLine)

  try {
    respond(config, argv, logLine)
  } catch (error) {
    if (!(error instanceof Unhandled)) throw error

    appendFileSync(config.unhandledPath, logLine)
    process.stderr.write(`fake orca: unhandled invocation (${error.message}): orca ${JSON.stringify(argv)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
