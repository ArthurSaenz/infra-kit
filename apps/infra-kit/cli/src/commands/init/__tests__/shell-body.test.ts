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

  it('spawns env-autoload backgrounded and silenced (precmd does the sourcing)', () => {
    expect(body).toContain('infra-kit env-autoload & ) >/dev/null 2>&1')
  })

  it('keeps the precmd hook as the sole sourcer of env-load.sh', () => {
    expect(body).toContain('add-zsh-hook precmd _infra_kit_autoload')
  })
})
