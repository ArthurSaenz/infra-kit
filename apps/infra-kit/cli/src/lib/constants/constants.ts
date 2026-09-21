import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const ENV_LOAD_FILE = 'env-load.sh'
export const ENV_CLEAR_FILE = 'env-clear.sh'

export const INFRA_KIT_SESSION_VAR = 'INFRA_KIT_SESSION'
/**
 * Directory under the user's home that holds all machine-local infra-kit config:
 * the runtime `infra-kit.json` merge layer, per-project overrides, the factory
 * registry (`vendor.json`), and the `portless` package link. Single source of
 * truth for `.infra-kit`.
 *
 * Defined HERE, not in `lib/infra-kit-config`, because that module pulls in zod
 * and the `ik-mcp` proxy bundle must stay Node-builtins-only (guarded in
 * `entry/__tests__/dist-shebang.test.ts`); `lib/infra-kit-config` re-exports it
 * for its existing consumers.
 */
export const USER_CONFIG_DIR_NAME = '.infra-kit'
/**
 * The active environment/config NAME (e.g. `dev`, `arthur`), exported plainly so
 * non-shell consumers can read it from `process.env`. Notably `infra-kit/vite`'s
 * `infraKitDev()` reads this to interpolate the `<env>` placeholder in cloud proxy
 * targets. Mirrors {@link INFRA_KIT_ENV_CONFIG_VAR} (same value) but is the stable,
 * purpose-named handle for tooling rather than the shell session-metadata var.
 */
export const INFRA_KIT_ENV_VAR = 'INFRA_KIT_ENV'
export const INFRA_KIT_ENV_CONFIG_VAR = 'INFRA_KIT_ENV_CONFIG'
export const INFRA_KIT_ENV_PROJECT_VAR = 'INFRA_KIT_ENV_PROJECT'
/**
 * Absolute project root (git top-level) the loaded env belongs to, so a shell can
 * tell whose secrets it is carrying after a `cd` into another project.
 */
export const INFRA_KIT_ENV_PROJECT_ROOT_VAR = 'INFRA_KIT_ENV_PROJECT_ROOT'
export const INFRA_KIT_ENV_LOADED_AT_VAR = 'INFRA_KIT_ENV_LOADED_AT'

/**
 * Matches a line of the form `KEY=...` where KEY is an env-var identifier
 * (letter or underscore, then word chars). Capture group 1 is the name. Shared
 * between env-load (validation, var counting) and parseVarNamesFromEnvFile.
 */
export const ENV_VAR_LINE_PATTERN = /^([A-Z_]\w*)=/i

/**
 * The `unset NAME` line env-clear.sh is made of. Anchored at both ends so a value that merely
 * starts with the word is not a match.
 */
const UNSET_LINE_PATTERN = /^unset ([A-Z_]\w*)$/i

/**
 * Track whether a physical line leaves us inside an open single-quoted value,
 * mirroring how `shellSingleQuote` emits values (`'…'`, with literal quotes as
 * `'\''`). Outside a quote a backslash escapes the next char; inside a quote a
 * `'` closes it. Lets the parser skip the continuation lines of a multiline value.
 */
const advanceSingleQuoteState = (line: string, startInQuote: boolean): boolean => {
  let inQuote = startInQuote

  for (let i = 0; i < line.length; i++) {
    if (!inQuote && line[i] === '\\') {
      i++
      continue
    }

    if (line[i] === "'") {
      inQuote = !inQuote
    }
  }

  return inQuote
}

/** One `KEY=value` assignment recovered from an env file, value already unescaped. */
export interface EnvAssignment {
  name: string
  value: string
}

/**
 * Undo {@link shellSingleQuote}: drop the wrapping quotes, then turn each `'\''`
 * back into a literal `'`. Order matters — unescaping first would let an embedded
 * `'\''` be mistaken for the closing quote.
 */
const decodeSingleQuoted = (raw: string): string => {
  const withoutOpen = raw.startsWith("'") ? raw.slice(1) : raw
  const body = withoutOpen.endsWith("'") ? withoutOpen.slice(0, -1) : withoutOpen

  return body.split("'\\''").join("'")
}

/** File contents, or '' when the path is absent, a directory, or unreadable. */
const readEnvFileContent = (filePath: string): string => {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Walk every assignment in an env-load.sh body, skipping the continuation lines of
 * multiline values. {@link parseVarNamesFromEnvFile}, {@link parseVarsFromEnvFile}
 * and {@link parseUnsetNamesFromEnvFile} all go through here, so they can never
 * disagree about where a value ends — an `unset X` inside a quoted value is a
 * continuation line to every one of them.
 */
const forEachAssignment = (
  content: string,
  visit: (assignment: EnvAssignment) => void,
  visitUnset?: (name: string) => void,
): void => {
  // A trailing CR is stripped per line: a CRLF file would otherwise hand back values
  // ending in '\r' — a token that looks right in a diff and fails every request.
  const lines = content.split('\n').map((line) => {
    return line.endsWith('\r') ? line.slice(0, -1) : line
  })
  let index = 0
  let inQuote = false

  while (index < lines.length) {
    const line = lines[index]!

    // Only a line that starts OUTSIDE a quoted value can be a real assignment;
    // continuation lines of a multiline secret value are skipped.
    if (inQuote) {
      inQuote = advanceSingleQuoteState(line, inQuote)
      index += 1
      continue
    }

    const match = ENV_VAR_LINE_PATTERN.exec(line)

    if (!match) {
      const unset = UNSET_LINE_PATTERN.exec(line)

      if (unset) visitUnset?.(unset[1]!)

      inQuote = advanceSingleQuoteState(line, false)
      index += 1
      continue
    }

    const name = match[1]!
    const rest = line.slice(match[0].length)

    // An unquoted value cannot span lines (`CONNECTION_STRING=host=db;user=admin`).
    if (!rest.startsWith("'")) {
      visit({ name, value: rest })
      inQuote = advanceSingleQuoteState(line, false)
      index += 1
      continue
    }

    const parts = [rest]
    let open = advanceSingleQuoteState(rest, false)

    while (open && index + 1 < lines.length) {
      index += 1
      const continuation = lines[index]!

      parts.push(continuation)
      open = advanceSingleQuoteState(continuation, true)
    }

    visit({ name, value: decodeSingleQuoted(parts.join('\n')) })
    inQuote = open
    index += 1
  }
}

export const parseVarNamesFromEnvFile = (filePath: string): string[] => {
  const names: string[] = []

  forEachAssignment(readEnvFileContent(filePath), ({ name }) => {
    names.push(name)
  })

  return names
}

/**
 * Same walk as {@link parseVarNamesFromEnvFile}, but keeping the values. Later
 * assignments win, matching what `source`ing the file would do.
 */
export const parseVarsFromEnvFile = (filePath: string): Record<string, string> => {
  const vars: Record<string, string> = {}

  forEachAssignment(readEnvFileContent(filePath), ({ name, value }) => {
    vars[name] = value
  })

  return vars
}

/**
 * The names the file `unset`s — everything env-clear.sh does. Absent file → `[]`, like
 * its siblings.
 */
export const parseUnsetNamesFromEnvFile = (filePath: string): string[] => {
  const names: string[] = []

  forEachAssignment(
    readEnvFileContent(filePath),
    () => {},
    (name) => {
      names.push(name)
    },
  )

  return names
}

/**
 * Root cache dir for infra-kit across all sessions. Resolved from
 * $XDG_CACHE_HOME when set, falling back to ~/.cache/infra-kit. Keep in sync
 * with the shell block emitted by `infra-kit setup` (src/commands/init/init.ts).
 */
export const getCacheRoot = (): string => {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.cache')

  return path.join(base, 'infra-kit')
}

export const getSessionCacheDir = (): string => {
  const session = process.env[INFRA_KIT_SESSION_VAR]

  if (!session) {
    throw new Error(
      `${INFRA_KIT_SESSION_VAR} is not set. Run \`infra-kit setup --skip-tools\` then \`source ~/.zshrc\`.`,
    )
  }

  return path.join(getCacheRoot(), session)
}

/**
 * Write content atomically: write to a pid-suffixed temp file in the same
 * directory, then rename. fs.renameSync is atomic on a single filesystem, so
 * concurrent writers can't produce a half-written secret file.
 */
export const atomicWriteFileSync = (filePath: string, content: string, mode: number): void => {
  const tmpPath = `${filePath}.tmp.${process.pid}`

  fs.writeFileSync(tmpPath, content, { mode })

  try {
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    fs.rmSync(tmpPath, { force: true })
    throw error
  }
}

export const WORKTREES_DIR_SUFFIX = '-worktrees'
