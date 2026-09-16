/**
 * A scripted `orca` binary behind zx's `$`. Each test file does
 * `vi.mock('zx', async () => (await import('./orca-cli-mock')).zxModule)` and drives
 * {@link orcaCli} — the factory imports this same module instance, so the state is
 * shared. `runOrca` only ever uses the `$({ nothrow, quiet })` options form, but the
 * plain tagged form is routed too so a stray call fails loudly instead of hanging.
 */

export interface OrcaReply {
  exitCode?: number | null
  stdout?: string
  stderr?: string
  /** Simulate the spawn itself failing (shell-less ENOENT); wins over the other fields. */
  reject?: Error
}

export type OrcaResponder = (argv: string[]) => OrcaReply

interface OrcaCliState {
  calls: string[][]
  respond: OrcaResponder
  reset: () => void
}

/** `{ ok: true, result }` with exit 0. */
export const ok = (result: unknown, exitCode = 0): OrcaReply => {
  return { exitCode, stdout: JSON.stringify({ ok: true, result }) }
}

/** `{ ok: false, error }` — exit 1 unless told otherwise (1.4.203 returned 0). */
export const fail = (code: string, message = code, exitCode = 1, data?: unknown): OrcaReply => {
  return { exitCode, stdout: JSON.stringify({ ok: false, error: { code, message, data } }) }
}

/** The shell's "command not found" shape: exit 127, empty stdout. */
export const absent = (): OrcaReply => {
  return { exitCode: 127, stdout: '', stderr: '/bin/bash: orca: command not found\n' }
}

/**
 * Route by the argv prefix after `orca`, e.g. `{ 'terminal create': ok(...) }`; a
 * key may also be a responder for calls that must vary. Unmatched calls answer
 * `ok({})` so incidental verbs (a `--all` retire) need no script.
 */
export const routes = (table: Record<string, OrcaReply | OrcaResponder>): OrcaResponder => {
  return (argv) => {
    const joined = argv.join(' ')
    const key = Object.keys(table).find((prefix) => {
      return joined.startsWith(prefix)
    })

    if (key === undefined) {
      return ok({})
    }

    const entry = table[key] ?? ok({})

    return typeof entry === 'function' ? entry(argv) : entry
  }
}

const defaultResponder: OrcaResponder = () => {
  return ok({})
}

export const orcaCli: OrcaCliState = {
  calls: [],
  respond: defaultResponder,
  reset() {
    orcaCli.calls = []
    orcaCli.respond = defaultResponder
  },
}

const flattenTemplate = (strings: TemplateStringsArray, values: unknown[]): string[] => {
  const words: string[] = []

  strings.forEach((chunk, index) => {
    words.push(...chunk.split(/\s+/))

    const value = values[index]

    if (Array.isArray(value)) {
      words.push(...value.map(String))
    } else if (value !== undefined) {
      words.push(String(value))
    }
  })

  return words.filter((word) => {
    return word.length > 0
  })
}

const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<Required<Omit<OrcaReply, 'reject'>>> => {
  const words = flattenTemplate(strings, values)

  if (words[0] !== 'orca') {
    return Promise.reject(new Error(`orca-cli-mock: unexpected command ${words.join(' ')}`))
  }

  // `--json` is appended by runOrca; tests script on the verb argv only.
  const argv = words.slice(1).filter((word) => {
    return word !== '--json'
  })

  orcaCli.calls.push(argv)

  const reply = orcaCli.respond(argv)

  if (reply.reject) {
    return Promise.reject(reply.reject)
  }

  return Promise.resolve({ exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' })
}

const $ = (first: unknown, ...rest: unknown[]): unknown => {
  if (Array.isArray(first)) {
    return tag(first as unknown as TemplateStringsArray, ...rest)
  }

  return tag
}

export const zxModule = { $ }
