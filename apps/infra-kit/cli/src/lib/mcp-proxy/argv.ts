import { PROTECTED_CHILD_ENV_NAMES } from './protected-env'
import type { ProxySpec } from './upstream'

/** Mirrors the config schema's name rule; re-checked here because the name becomes a cache subdir. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
/** Mirrors `envVarName` in the config schema. */
const ENV_VAR_PATTERN = /^[A-Z_]\w*$/i

export type ParsedArgv = { ok: true; spec: ProxySpec } | { ok: false; problem: string }

interface Flags {
  name: string | null
  env: string[]
  unset: string[]
}

/** Apply one `--flag value` pair, or say why it cannot be applied. */
const applyFlag = (flags: Flags, flag: string, value: string): string | null => {
  if (flag === '--name') {
    if (flags.name !== null) return '--name given twice'
    if (!NAME_PATTERN.test(value)) return `--name "${value}" must be lowercase letters, digits and hyphens`

    flags.name = value

    return null
  }

  if (flag === '--env' || flag === '--unset') {
    if (!ENV_VAR_PATTERN.test(value)) return `${flag} "${value}" is not an environment-variable name`
    // Mirrors the schema refinement, because hand-written argv (the `claude mcp add --scope local`
    // path) never passes through the schema — and `--unset PATH` would blank PATH and ENOENT the spawn.
    if (PROTECTED_CHILD_ENV_NAMES.has(value)) return `${flag} "${value}" is process plumbing, not a credential`

    if (flag === '--env') flags.env.push(value)
    else flags.unset.push(value)

    return null
  }

  return `unknown flag ${flag}`
}

/** Walk the flag half; returns the index of the `--` separator or a problem. */
const readFlags = (argv: readonly string[], flags: Flags): { separator: number } | { problem: string } => {
  let index = 0

  while (index < argv.length) {
    const flag = argv[index]!

    if (flag === '--') return { separator: index }

    // A bare word where a flag belongs is the upstream command arriving early — the separator
    // is what is missing, and that is the more useful thing to say than "cmd needs a value".
    if (!flag.startsWith('--')) return { problem: `missing "--" before the upstream command (saw "${flag}")` }

    const value = argv[index + 1]

    // A value that looks like a flag (`--env --`) would otherwise eat the separator and turn the
    // upstream command into a flag — the case that spawns the wrong binary instead of refusing.
    if (value === undefined || value.startsWith('--')) return { problem: `${flag} needs a value` }

    const problem = applyFlag(flags, flag, value)

    if (problem !== null) return { problem }

    index += 2
  }

  return { problem: 'missing "--" before the upstream command' }
}

/**
 * Parse the argv `ik setup` derived: `--name N (--env V)+ (--unset V)* -- <command> [args...]`.
 *
 * Every flag VALUE is validated, not only `--name`. The first `--` in flag position ends our half;
 * everything after it is the upstream's, verbatim, `--`s and all.
 */
// Node builtins only, on purpose. Pulling commander in here would drag it into the proxy bundle,
// which the chunk-isolation guard forbids — and a four-flag grammar does not need it.
export const parseProxyArgv = (argv: readonly string[]): ParsedArgv => {
  const flags: Flags = { name: null, env: [], unset: [] }
  const walked = readFlags(argv, flags)

  if ('problem' in walked) return { ok: false, problem: walked.problem }
  if (flags.name === null) return { ok: false, problem: 'missing --name' }
  if (flags.env.length === 0) return { ok: false, problem: 'missing --env (at least one variable to read)' }

  const command = argv[walked.separator + 1]

  if (command === undefined || command.length === 0)
    return { ok: false, problem: 'missing upstream command after "--"' }

  return {
    ok: true,
    spec: { name: flags.name, command, args: argv.slice(walked.separator + 2), env: flags.env, unset: flags.unset },
  }
}
