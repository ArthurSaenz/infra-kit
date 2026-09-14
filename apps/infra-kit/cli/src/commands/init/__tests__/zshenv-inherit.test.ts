import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildEnvClearLines } from 'src/commands/env-clear/env-clear'
import { buildEnvLoadFileLines } from 'src/commands/env-load/env-load'

import { buildZshenvBlock } from '../init'

/**
 * The direct proof of the Bash-tool case (docs/session-zshenv-plan.md A.5): a real `/bin/zsh -c`
 * against a scratch `ZDOTDIR` holding nothing but the block, with a SCRUBBED environment — the
 * developer's own session, XDG dirs and loaded env would otherwise make every case pass or fail for
 * reasons the block had nothing to do with. Fixtures come from the real `env-load` / `env-clear`
 * builders so a change to the file shape reaches this test.
 */

const SESSION = 'abcd1234'

const PROBE =
  "printf 'cfg=[%s] FOO=[%s] dir=[%s] load=[%s] clear=[%s] cleared=[%s]\\n' " +
  // eslint-disable-next-line no-template-curly-in-string
  '"${INFRA_KIT_ENV_CONFIG:-}" "${FOO:-}" "${dir:-}" "${load:-}" "${clear:-}" "${INFRA_KIT_ENV_CLEARED:-}"'

const LOADED = 'cfg=[arthur] FOO=[from-load] dir=[D] load=[L] clear=[C] cleared=[]\n'
const CLEARED = 'cfg=[] FOO=[] dir=[] load=[] clear=[] cleared=[1]\n'
const NOTHING = 'cfg=[] FOO=[] dir=[] load=[] clear=[] cleared=[]\n'

interface Scratch {
  root: string
  home: string
  cache: string
  sessionDir: string
}

let scratch: Scratch

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zshenv-inherit-'))
  const home = path.join(root, 'home')
  const cache = path.join(root, 'cache')
  const sessionDir = path.join(cache, 'infra-kit', SESSION)

  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(home, '.zshenv'), `${buildZshenvBlock()}\n`)

  scratch = { root, home, cache, sessionDir }
})

afterEach(() => {
  fs.rmSync(scratch.root, { recursive: true, force: true })
})

/**
 * Only what the block needs to resolve its paths, plus whatever a case deliberately inherits.
 * `PATH` stays so `/bin/sh` and `printf` resolve as they do under the real Bash tool.
 */
const scrubbedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  return {
    HOME: scratch.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ZDOTDIR: scratch.home,
    XDG_CACHE_HOME: scratch.cache,
    INFRA_KIT_SESSION: SESSION,
    ...extra,
  }
}

const withoutSession = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const rest = { ...env }

  delete rest.INFRA_KIT_SESSION

  return rest
}

interface Run {
  stdout: string
  stderr: string
  status: number | null
}

const run = (shell: string, args: string[], env: NodeJS.ProcessEnv): Run => {
  const result = spawnSync(shell, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

const zsh = (script: string, env: NodeJS.ProcessEnv = scrubbedEnv(), flag = '-c'): Run => {
  return run('/bin/zsh', [flag, script], env)
}

const loadLines = (pairs: Array<[string, string]>, config = 'arthur'): string[] => {
  return buildEnvLoadFileLines({
    pairs,
    config,
    project: 'hulyo',
    projectRoot: '/repo',
    loadedAt: '2026-09-14T00:00:00.000Z',
    autoLoaded: false,
  })
}

// `dir`/`load`/`clear` are the Doppler keys Z11 protects: a bare `local dir` in the block would swallow them.
const STANDARD_PAIRS: Array<[string, string]> = [
  ['FOO', 'from-load'],
  ['dir', 'D'],
  ['load', 'L'],
  ['clear', 'C'],
]

const writeLoad = (dir: string, lines: string[] = loadLines(STANDARD_PAIRS)): string => {
  const file = path.join(dir, 'env-load.sh')

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)

  return file
}

const writeClear = (dir: string): string => {
  const file = path.join(dir, 'env-clear.sh')

  fs.writeFileSync(file, `${buildEnvClearLines(['FOO', 'dir', 'load', 'clear']).join('\n')}\n`)

  return file
}

const T0 = new Date('2026-01-01T00:00:00Z')
const T0_PLUS_5S = new Date(T0.getTime() + 5000)

/** A run that printed exactly `stdout`, nothing on stderr, and exited 0 — the shape every quiet case asserts. */
const clean = (stdout: string): Run => {
  return { stdout, stderr: '', status: 0 }
}

// The one platform skip in this package: the subject IS /bin/zsh, so a runner without it has nothing
// to assert against — this is a missing capability, not unimplemented work.
describe.skipIf(!fs.existsSync('/bin/zsh'))('the ~/.zshenv block, under a real /bin/zsh', () => {
  it('1. load only: the sourced vars, including Doppler keys named like the locals, reach the child', () => {
    writeLoad(scratch.sessionDir)

    expect(zsh(PROBE)).toEqual(clean(LOADED))
  })

  it('2. clear only: vars the child INHERITED are unset and the cleared marker is exported', () => {
    writeClear(scratch.sessionDir)

    const result = zsh(PROBE, scrubbedEnv({ FOO: 'inherited', INFRA_KIT_ENV_CONFIG: 'inherited' }))

    expect(result).toEqual(clean(CLEARED))
  })

  it('3. both present, load newer: the load is sourced', () => {
    const load = writeLoad(scratch.sessionDir)
    const clear = writeClear(scratch.sessionDir)

    fs.utimesSync(clear, T0, T0)
    fs.utimesSync(load, T0_PLUS_5S, T0_PLUS_5S)

    expect(zsh(PROBE)).toEqual(clean(LOADED))
  })

  it('4. both present, clear newer: the clear is sourced and an inherited FOO goes away', () => {
    const load = writeLoad(scratch.sessionDir)
    const clear = writeClear(scratch.sessionDir)

    fs.utimesSync(load, T0, T0)
    fs.utimesSync(clear, T0_PLUS_5S, T0_PLUS_5S)

    expect(zsh(PROBE, scrubbedEnv({ FOO: 'inherited' }))).toEqual(clean(CLEARED))
  })

  it('5. tie: load wins, as the .zshrc precmd gate rules', () => {
    const load = writeLoad(scratch.sessionDir)
    const clear = writeClear(scratch.sessionDir)

    fs.utimesSync(load, T0, T0)
    fs.utimesSync(clear, T0, T0)

    expect(zsh(PROBE)).toEqual(clean(LOADED))
  })

  it('6. no session: nothing is sourced — observable through the decoy at <cache>/infra-kit/env-load.sh', () => {
    // With BOTH guard lines gone `$_ik_dir` expands to `<cache>/infra-kit/`, which the kernel collapses
    // onto this file — the only path an unguarded empty id can reach (plan AC8(b')).
    writeLoad(path.join(scratch.cache, 'infra-kit'), loadLines([['DECOY', '1']], 'DECOY'))

    const probe = `${PROBE}; printf 'DECOY=[%s]\\n' "\${DECOY:-}"`
    const result = zsh(probe, withoutSession(scrubbedEnv()))

    expect(result).toEqual(clean(`${NOTHING}DECOY=[]\n`))
  })

  it("7. login (-lc) and non-login (-c) give the same answer — the Bash tool's flag does not matter", () => {
    writeLoad(scratch.sessionDir)

    const nonLogin = zsh(PROBE)
    const login = zsh(PROBE, scrubbedEnv(), '-lc')

    expect(nonLogin).toEqual(clean(LOADED))
    expect(login).toEqual(clean(LOADED))
  })

  it('8. /bin/sh with the same env sees nothing — the block is a zsh-only boundary', () => {
    writeLoad(scratch.sessionDir)

    expect(run('/bin/sh', ['-c', PROBE], scrubbedEnv())).toEqual(clean(NOTHING))
  })

  it('9. a broken load file: the parse error surfaces, the earlier assignments land, and allexport does not leak', () => {
    // The last `KEY='value'` line loses its closing quote, so `set -a` runs and `set +a` never does.
    const lines = loadLines(STANDARD_PAIRS)
    const lastValueIdx = lines.findLastIndex((line) => {
      return /^[A-Z_]+='.*'$/.test(line)
    })

    lines[lastValueIdx] = lines[lastValueIdx]!.slice(0, -1)
    writeLoad(scratch.sessionDir, lines)

    const script = [
      PROBE,
      "if [[ -o allexport ]]; then printf 'allexport=[on]\\n'; else printf 'allexport=[off]\\n'; fi",
      // Assigned AFTER the block: visible to a grandchild only if allexport survived the function.
      'AFTER_BLOCK=1',
      // eslint-disable-next-line no-template-curly-in-string
      '/bin/sh -c \'printf "after=[%s]\\n" "${AFTER_BLOCK:-}"\'',
    ].join('\n')
    const result = zsh(script)

    expect(result.stderr).toContain("unmatched '")
    expect(result.stdout).toBe(`${LOADED}allexport=[off]\nafter=[]\n`)
  })

  describe('10. a session id of any other shape is treated as no session', () => {
    it('a path-shaped id cannot resolve a file outside the cache root', () => {
      // `<cache>/infra-kit/../../evil` collapses to `<cache>/../evil` — planted there, on purpose.
      writeLoad(path.join(scratch.root, 'evil'), loadLines([['FOO', 'from-load']], 'EVIL'))

      const result = zsh(PROBE, scrubbedEnv({ INFRA_KIT_SESSION: '../../evil' }))

      expect(result).toEqual(clean(NOTHING))
    })

    it.each([
      ['uppercase', 'ABCD1234'],
      ['seven hex digits', 'abcd123'],
      ['nine hex digits', 'abcd12345'],
    ])('%s (%s) is refused even with a real file at the canonical path', (_label, id) => {
      writeLoad(path.join(scratch.cache, 'infra-kit', id), loadLines([['FOO', 'from-load']], 'EVIL'))

      const result = zsh(PROBE, scrubbedEnv({ INFRA_KIT_SESSION: id }))

      expect(result).toEqual(clean(NOTHING))
    })
  })

  it('11. quoting round trip: a value holding \', $(…), backticks and " reads back byte-identical', () => {
    const tricky = `it's $(uname) \`uname\` "quoted" \\back`

    writeLoad(scratch.sessionDir, loadLines([['TRICKY', tricky]]))

    const result = zsh('printf \'%s\\n\' "$TRICKY"')

    expect(result).toEqual(clean(`${tricky}\n`))
  })
})
