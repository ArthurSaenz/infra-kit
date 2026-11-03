/**
 * @fileoverview
 *
 * Read the argv portless's `service install` baked into the OS service file — the launchd plist on
 * macOS, the systemd unit on Linux — so `doctor` can say which node and which `cli.js` the ROOT daemon
 * will run at the next boot.
 *
 * Both grammars deliberately mirror the reader portless itself uses to load its installed service back
 * (`dist/cli.js`: `readInstalledServiceSnapshot`, `parsePlistStrings`, `xmlUnescape`, `parseQuotedWords`),
 * and nothing more: what portless's writer emits is exactly what portless's reader accepts, so a third
 * grammar could only disagree with both. A path containing `&`, `"` or a space must round-trip through
 * `xmlEscape` / `systemdEscape` untouched — the fixture tests assert that.
 */

/** The inverse of portless's `xmlEscape`, in the same order it applies (`&amp;` last so it is never re-expanded). */
export const xmlUnescape = (value: string): string => {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** Every `<string>` in a plist block, unescaped, in document order. */
const parsePlistStrings = (block: string): string[] => {
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => {
    return xmlUnescape(match[1]!)
  })
}

/**
 * `ProgramArguments` of a launchd plist, or `null` when the array is absent. The `<string>` entries are
 * read in order, so the interpreter is `[0]` and the script `[1]` — extra entries (`proxy`, flags) ride
 * along after them exactly as portless wrote them.
 */
export const parseLaunchdProgramArguments = (plist: string): string[] | null => {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)

  return block === null ? null : parsePlistStrings(block[1]!)
}

/**
 * Split a systemd `ExecStart=` value into words the way portless's `parseQuotedWords` does: double
 * quotes toggle quoting (and are dropped), a backslash escapes the next `"` or `\`, and whitespace
 * splits only outside quotes. `""` is a real, empty word.
 */
export const parseQuotedWords = (input: string): string[] => {
  const words: string[] = []
  let current = ''
  let inQuote = false
  let inWord = false
  let escaped = false
  // Iterated by code point, and the lookahead indexes the same array, so a non-BMP character in a
  // path cannot desynchronise the two.
  const chars = [...input]

  for (const [index, char] of chars.entries()) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '"') {
      inQuote = !inQuote
      inWord = true
      continue
    }
    const next = chars[index + 1]

    if (char === '\\' && (next === '"' || next === '\\')) {
      current += next
      inWord = true
      escaped = true
      continue
    }
    if (/\s/.test(char) && !inQuote) {
      if (inWord) {
        words.push(current)
        current = ''
        inWord = false
      }
      continue
    }
    current += char
    inWord = true
  }
  if (inWord) words.push(current)

  return words
}

/** The argv of a systemd unit's `ExecStart=` line, or `null` when the unit has none. */
export const parseSystemdExecStart = (unit: string): string[] | null => {
  const line = unit.split('\n').find((candidate) => {
    return candidate.startsWith('ExecStart=')
  })

  return line === undefined ? null : parseQuotedWords(line.slice('ExecStart='.length))
}

/**
 * The service's argv on the given platform, or `null` when the file cannot be read as one — the
 * caller reports "could not parse" and never throws. Any other platform is `null` too: portless writes
 * a Task Scheduler script there, which this reader does not cover.
 */
export const parseServiceArgv = (platform: NodeJS.Platform, content: string): string[] | null => {
  try {
    if (platform === 'darwin') return parseLaunchdProgramArguments(content)
    if (platform === 'linux') return parseSystemdExecStart(content)

    return null
  } catch {
    return null
  }
}
