import { describe, expect, it } from 'vitest'

import { buildShellBody } from '../init'

describe('buildShellBody', () => {
  const body = buildShellBody()

  it('sources the returned file directly and prints status', () => {
    expect(body).toContain(
      'env-load() { local f; f=$(pnpm exec infra-kit env-load "$@") || return; source "$f"; pnpm exec infra-kit env-status; }',
    )
    expect(body).toContain(
      'env-clear() { local f; f=$(pnpm exec infra-kit env-clear "$@") || return; source "$f"; pnpm exec infra-kit env-status; }',
    )
    expect(body).toContain('env-status() { pnpm exec infra-kit env-status; }')
  })

  it('forwards args on the env-clear wrapper', () => {
    expect(body).toContain('env-clear "$@"')
  })

  it('defines no precmd hook and loads no zsh module', () => {
    expect(body).not.toContain('precmd')
    expect(body).not.toContain('sched')
    expect(body).not.toContain('zmodload')
    expect(body).not.toContain('_INFRA_KIT_')
    expect(body).not.toContain('_infra_kit_')
  })

  it('does NOT define an `ik` alias — the global bin provides it, and an alias would shadow it', () => {
    expect(body).not.toContain('alias ik=')
  })
})
