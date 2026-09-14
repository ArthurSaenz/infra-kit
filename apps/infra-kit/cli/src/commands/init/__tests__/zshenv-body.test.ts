import { describe, expect, it } from 'vitest'

import { MARKER_END, MARKER_START, buildZshenvBlock, buildZshenvBody } from '../init'

// String guards on the authored lines (docs/session-zshenv-plan.md, "The literal clauses", Z1–Z11).
// Z9 and Z10 guard lines whose failure modes a string test cannot see — a permanent no-op, an
// `allexport` leak — so each has a real-zsh twin in zshenv-inherit.test.ts.
describe('buildZshenvBody — the ~/.zshenv session-env block', () => {
  const body = buildZshenvBody()

  it('z1: is a no-op in a fresh terminal, and the `:-` survives nounset', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(body).toContain('if [[ -n "${INFRA_KIT_SESSION:-}" ]]; then')
  })

  it('z2: resolves the session dir exactly as getCacheRoot does', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(body).toContain('${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION')
  })

  it('z3: load wins a tie with clear, and an unreadable load falls through', () => {
    expect(body).toContain('[[ -r "$_ik_load" && ! "$_ik_clear" -nt "$_ik_load" ]]')
  })

  it('z4: sources the clear file so inherited vars are unset', () => {
    expect(body).toContain('elif [[ -r "$_ik_clear" ]]; then')
  })

  it('z5: prints nothing of its own', () => {
    expect(body).not.toContain('print')
    expect(body).not.toContain('echo')
    expect(body).not.toContain('zle')
  })

  it('z6: loads no module, registers no hook, spawns nothing', () => {
    expect(body).not.toContain('zmodload')
    expect(body).not.toContain('sched')
    expect(body).not.toContain('add-zsh-hook')
    expect(body).not.toContain('pnpm')
    // `infra-kit` may appear as the cache path segment Z2 pins and in the comments — never as a command.
    const code = body.split('\n').filter((line) => {
      return !line.trimStart().startsWith('#')
    })

    for (const line of code) {
      expect(line.replaceAll('/infra-kit/', '')).not.toContain('infra-kit')
    }
  })

  it("z7: writes none of the .zshrc block's remembered-mtime or started state", () => {
    expect(body).not.toContain('_INFRA_KIT_LAST_')
    expect(body).not.toContain('_INFRA_KIT_SHELL_STARTED')
  })

  it('z8: the block is the body between the same markers the .zshrc block uses', () => {
    expect(buildZshenvBlock()).toBe(`${MARKER_START}\n${body}\n${MARKER_END}`)
  })

  it('z9: emulate -L zsh -o extendedglob is the first line inside the anonymous function', () => {
    expect(body).toContain('  () {\n    emulate -L zsh -o extendedglob\n')
  })

  it('z10: honours only the canonical lowercase 8-hex id', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(body).toContain('[[ "${INFRA_KIT_SESSION:-}" == [0-9a-f](#c8) ]] || return')
  })

  it('z11: every local is _ik_-prefixed so a Doppler key named dir/load/clear survives the function', () => {
    const localNames = body
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('local ')
      })
      .flatMap((line) => {
        // Each `name="value"` carries no spaces in this body, so a plain split is exact here.
        return line
          .trim()
          .slice('local '.length)
          .split(' ')
          .map((assignment) => {
            return assignment.split('=')[0]
          })
      })

    expect(localNames.length).toBeGreaterThan(0)
    for (const name of localNames) {
      expect(name).toMatch(/^_ik_/)
    }
    expect(body).not.toMatch(/\blocal (dir|load|clear)\b/)
  })
})
