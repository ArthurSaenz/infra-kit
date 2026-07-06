import { describe, expect, it } from 'vitest'

import { buildShellBody } from '../init'

describe('buildShellBody — env auto-load shell-startup block', () => {
  const body = buildShellBody()

  it('defines and invokes the one-shot startup autoload function', () => {
    expect(body).toContain('_infra_kit_startup_autoload()')
    expect(body).toContain('_infra_kit_startup_autoload\n')
  })

  it('gates on a session and skips the spawn only when the env is for THIS project root', () => {
    expect(body).toContain('[[ -z "$INFRA_KIT_SESSION" ]] && return')
    expect(body).toContain('[[ -n "$INFRA_KIT_ENV_CONFIG" && "$dir" == "$INFRA_KIT_ENV_PROJECT_ROOT" ]] && return')
  })

  it('walks up for infra-kit.json with a fixed-point break (no infinite loop on empty $PWD)', () => {
    expect(body).toContain('[[ -f "$dir/infra-kit.json" ]]')
    expect(body).toContain('while [[ -n "$dir" && "$dir" != "$prev" ]]')
  })

  it('spawns env-autoload backgrounded and silenced, passing the canonical --project-dir', () => {
    expect(body).toContain('infra-kit env-autoload --project-dir "$canon" & ) >/dev/null 2>&1')
  })

  it('keeps the precmd hook as a sourcer of env-load.sh', () => {
    expect(body).toContain('add-zsh-hook precmd _infra_kit_autoload')
  })

  it('loads the zsh/sched module used by the startup poll', () => {
    expect(body).toContain('zmodload zsh/sched 2>/dev/null')
  })

  it('defines a startup poll that re-runs the sourcer via sched', () => {
    expect(body).toContain('_infra_kit_poll_autoload()')
    expect(body).toContain('  _infra_kit_autoload\n')
    expect(body).toContain('sched +1 _infra_kit_poll_autoload')
  })

  it('bounds the poll: re-arm only until loaded and within the startup window', () => {
    expect(body).toContain('_INFRA_KIT_AUTOLOAD_WINDOW=6')
    expect(body).toContain(
      // eslint-disable-next-line no-template-curly-in-string
      '  if (( _INFRA_KIT_LAST_LOAD_MTIME < _INFRA_KIT_SHELL_STARTED )) && (( ${EPOCHSECONDS:-0} - _INFRA_KIT_SHELL_STARTED < _INFRA_KIT_AUTOLOAD_WINDOW )); then',
    )
  })

  it('arms the poll from the startup autoload right after the backgrounded spawn', () => {
    const spawnIdx = body.indexOf('infra-kit env-autoload --project-dir "$canon" & ) >/dev/null 2>&1')
    const armIdx = body.indexOf('sched +1 _infra_kit_poll_autoload', spawnIdx)

    // arm line follows the spawn (same startup branch), before its `return`
    expect(spawnIdx).toBeGreaterThanOrEqual(0)
    expect(armIdx).toBeGreaterThan(spawnIdx)
  })
})

describe('buildShellBody — warm cache', () => {
  const body = buildShellBody()

  it('defaults the warm TTL to 7200s (== DEFAULT_WARM_TTL_SECONDS) and exports it', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(body).toContain(': ${_INFRA_KIT_WARM_TTL:=7200}')
    expect(body).toContain('_INFRA_KIT_WARM_TTL')
  })

  it('derives the key with sha256 of the canonical dir (byte-identical to node)', () => {
    expect(body).toContain('_infra_kit_warm_source()')
    expect(body).toContain('printf %s "$canon" | shasum -a 256 | cut -c1-64')
    expect(body).toContain('printf %s "$canon" | sha256sum | cut -c1-64')
  })

  it('gates warm-source on clear-marker (clear wins ties) and TTL', () => {
    expect(body).toContain('(( cm >= wm )) && return')
    // eslint-disable-next-line no-template-curly-in-string
    expect(body).toContain('(( ${EPOCHSECONDS:-0} - wm >= _INFRA_KIT_WARM_TTL )) && return')
  })

  it('sources the warm file but does NOT set _INFRA_KIT_LAST_LOAD_MTIME (so the fresh session file still upgrades)', () => {
    const fnStart = body.indexOf('_infra_kit_warm_source()')
    const fnEnd = body.indexOf('_infra_kit_startup_autoload()')
    const warmFn = body.slice(fnStart, fnEnd)

    expect(warmFn).toContain('source "$warm"')
    expect(warmFn).not.toContain('_INFRA_KIT_LAST_LOAD_MTIME')
  })

  it('warm-sources with the canonical dir BEFORE spawning the refresh', () => {
    const warmCallIdx = body.indexOf('_infra_kit_warm_source "$canon"')
    const spawnIdx = body.indexOf('infra-kit env-autoload --project-dir "$canon"')

    expect(warmCallIdx).toBeGreaterThanOrEqual(0)
    expect(spawnIdx).toBeGreaterThan(warmCallIdx)
  })

  it('forwards args on the env-clear wrapper so `env-clear --purge` reaches the CLI', () => {
    expect(body).toContain('env-clear "$@"')
  })
})

describe('buildShellBody — async notice (prompt-safe printing)', () => {
  const body = buildShellBody()

  it('defines a _infra_kit_notify helper guarded on ZLE that redraws the prompt', () => {
    expect(body).toContain('_infra_kit_notify() {')
    // Guards on ZLE being active: erases the current prompt line, then redraws.
    expect(body).toContain("  zle && print -u2 -n $'\\r\\e[K'")
    expect(body).toContain('  zle && zle reset-prompt')
  })

  it('routes the async notices through _infra_kit_notify (never a bare print at the idle prompt)', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(body).toContain('_infra_kit_notify "infra-kit: auto-loaded vars for ${INFRA_KIT_ENV_CONFIG:-?}"')
    expect(body).toContain('_infra_kit_notify "infra-kit: auto-cleared env"')
    expect(body).toContain(
      // eslint-disable-next-line no-template-curly-in-string
      '_infra_kit_notify "infra-kit: loaded cached vars for ${INFRA_KIT_ENV_CONFIG:-?} (refreshing…)"',
    )
    // No async notice should still use a bare `print -u2 "infra-kit:` form.
    expect(body).not.toContain('print -u2 "infra-kit:')
  })

  it('defines _infra_kit_notify before the startup autoload that (transitively) calls it', () => {
    const notifyIdx = body.indexOf('_infra_kit_notify() {')
    const startupInvokeIdx = body.lastIndexOf('_infra_kit_startup_autoload\n')

    expect(notifyIdx).toBeGreaterThanOrEqual(0)
    expect(startupInvokeIdx).toBeGreaterThan(notifyIdx)
  })
})
