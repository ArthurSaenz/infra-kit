import { describe, expect, it } from 'vitest'

import {
  parseLaunchdProgramArguments,
  parseQuotedWords,
  parseServiceArgv,
  parseSystemdExecStart,
  xmlUnescape,
} from '../service-file'
import { launchdPlist, systemdUnit, xmlEscape } from './service-fixtures'

const NODE = '/usr/local/bin/node'
const SCRIPT = '/Users/x/.infra-kit/portless/dist/cli.js'

describe('xmlUnescape', () => {
  it('inverts xmlEscape, including a literal `&amp;` that must not be expanded twice', () => {
    const raw = `/Users/x/R&D <"team's"> & &amp; co`

    expect(xmlUnescape(xmlEscape(raw))).toBe(raw)
  })
})

describe('parseLaunchdProgramArguments', () => {
  it('reads the interpreter, the script and every trailing flag in order', () => {
    const argv = [NODE, SCRIPT, 'proxy', '--port', '443', '--tls']

    expect(parseLaunchdProgramArguments(launchdPlist(argv))).toEqual(argv)
  })

  it('round-trips a path containing `&`', () => {
    const script = '/Users/x/R&D/portless/dist/cli.js'

    expect(parseLaunchdProgramArguments(launchdPlist([NODE, script, 'proxy']))).toEqual([NODE, script, 'proxy'])
  })

  it('answers null when the ProgramArguments array is absent', () => {
    expect(parseLaunchdProgramArguments('<plist><dict><key>Label</key><string>x</string></dict></plist>')).toBeNull()
    expect(parseLaunchdProgramArguments('')).toBeNull()
  })
})

describe('parseQuotedWords', () => {
  it('drops the quotes, keeps quoted whitespace, and unescapes `\\"` and `\\\\`', () => {
    expect(parseQuotedWords(`"/a b/node" "/c/cli.js" proxy "say \\"hi\\"" "back\\\\slash"`)).toEqual([
      '/a b/node',
      '/c/cli.js',
      'proxy',
      'say "hi"',
      'back\\slash',
    ])
  })

  it('keeps an empty quoted word and collapses runs of whitespace', () => {
    expect(parseQuotedWords(`a   ""  b`)).toEqual(['a', '', 'b'])
    expect(parseQuotedWords('')).toEqual([])
  })
})

describe('parseSystemdExecStart', () => {
  it('reads a quoted ExecStart= line back to the argv systemdEscape was given', () => {
    const argv = ['/opt/node bin/node', '/home/x/.infra-kit/portless/dist/cli.js', 'proxy', '--port', '443']

    expect(parseSystemdExecStart(systemdUnit(argv))).toEqual(argv)
  })

  it('round-trips a path containing `&` and a double quote', () => {
    const script = '/home/x/R&D/"q"/portless/dist/cli.js'

    expect(parseSystemdExecStart(systemdUnit([NODE, script, 'proxy']))).toEqual([NODE, script, 'proxy'])
  })

  it('answers null when the unit has no ExecStart= line', () => {
    expect(parseSystemdExecStart('[Service]\nType=simple\n')).toBeNull()
  })
})

describe('parseServiceArgv', () => {
  it('picks the grammar by platform and skips the rest', () => {
    expect(parseServiceArgv('darwin', launchdPlist([NODE, SCRIPT, 'proxy']))).toEqual([NODE, SCRIPT, 'proxy'])
    expect(parseServiceArgv('linux', systemdUnit([NODE, SCRIPT, 'proxy']))).toEqual([NODE, SCRIPT, 'proxy'])
    expect(parseServiceArgv('win32', 'anything')).toBeNull()
  })

  it('never throws on garbage', () => {
    expect(parseServiceArgv('darwin', 'not a plist')).toBeNull()
    expect(parseServiceArgv('linux', 'not a unit')).toBeNull()
  })
})
