import { describe, expect, it } from 'vitest'

import { DevRenderer, formatClock, formatElapsed, resolveEndpointUrl, stripAnsi } from 'src/dev/render'
import type { ReadySummary } from 'src/dev/render'

/**
 * The renderer is pure I/O over injected seams: `write` (terminal), `appendLog` (file tee), `isTTY`
 * (gates spinner + ANSI), and `now` (deterministic clocks). Tests capture both sinks and assert the
 * exact emitted frames. `isTTY: false` disables the spinner + color, so every frame is byte-stable.
 */
const frozen = new Date('2026-07-08T14:02:11.000Z')

/** A renderer wired to string-array sinks; returns the renderer plus its captured `out`/`log`. */
const makeRenderer = (
  over: Partial<{ isTTY: boolean; verbose: boolean; now: () => Date }> = {},
): { r: DevRenderer; out: string[]; log: string[] } => {
  const out: string[] = []
  const log: string[] = []
  const r = new DevRenderer({
    write: (t) => {
      return out.push(t)
    },
    appendLog: (t) => {
      return log.push(t)
    },
    isTTY: over.isTTY ?? false,
    verbose: over.verbose ?? false,
    now:
      over.now ??
      ((): Date => {
        return frozen
      }),
  })

  return { r, out, log }
}

const baseSummary = (over: Partial<ReadySummary> = {}): ReadySummary => {
  return {
    target: 'client',
    watch: true,
    hasUiChild: false,
    release: 'feat-x',
    elapsedMs: 2400,
    endpoints: [{ tag: 'client/api', url: 'https://feat-x.client-api.localhost/api/v1', healthy: true }],
    uiRefs: [{ tag: 'client/ui' }],
    watchSummary: '1 app · 5 packages',
    logPath: '~/.cache/infra-kit/ab12cd34/logs.txt',
    logHref: '/home/u/.cache/infra-kit/ab12cd34/logs.txt',
    ...over,
  }
}

describe('render — pure formatters', () => {
  it('formats a clock as HH:MM:SS and elapsed as Xs', () => {
    expect(formatClock(new Date('2026-07-08T09:07:03.000Z'))).toMatch(/^\d\d:\d\d:\d\d$/)
    expect(formatElapsed(2400)).toBe('2.4s')
    expect(formatElapsed(0)).toBe('0.0s')
  })

  it('renders the aliased hero URL as HTTPS with no port, ever', () => {
    // The proxy serves TLS on 443 — the implicit HTTPS port — so the hero URL is byte-identical to the
    // `dev.proxy` local template the frontend proxies to. The table and the FE cannot drift.
    expect(resolveEndpointUrl({ prefixUrl: '/api/v1', alias: 'feat-x.backend-api.localhost' })).toBe(
      'https://feat-x.backend-api.localhost/api/v1',
    )
    // A UI row: empty prefix + alias.
    expect(resolveEndpointUrl({ prefixUrl: '', alias: 'feat-x.client-ui.localhost' })).toBe(
      'https://feat-x.client-ui.localhost',
    )
  })

  it('never emits a port or a plain-http scheme — the two shapes this design exists to remove', () => {
    // Pinned as a regression: a port suffix would mean the proxy is not on 443 (which `ensureProxy`
    // refuses to start), and an `http://` hero URL against a TLS listener is the silent-failure class
    // that motivated the whole migration.
    const url = resolveEndpointUrl({ prefixUrl: '/api/v1', alias: 'feat-x.backend-api.localhost' })

    expect(url.startsWith('https://')).toBe(true)
    expect(url).not.toMatch(/:\d+/)
  })
})

describe('render — ready header (non-TTY, deterministic)', () => {
  it('leads with the endpoint row + health dot, a UI reference line, clickable log path, and rule', () => {
    const { r, out } = makeRenderer()

    r.ready(baseSummary())
    const screen = out.join('')

    expect(screen).toContain('infra-kit dev')
    expect(screen).toContain('client · watch · feat-x')
    expect(screen).toContain('ready in 2.4s')
    expect(screen).toContain('client/api  https://feat-x.client-api.localhost/api/v1  ● ok')
    // The UI is referenced, never given a fabricated URL (tag is space-padded to the widest tag).
    expect(screen).toMatch(/client\/ui\s+→ starting below \(vite prints its URL\)/)
    expect(screen).not.toMatch(/client\/ui\s+http/)
    // The redundant scheme legend is gone — the endpoint rows already show the concrete URLs.
    expect(screen).not.toContain('scheme')
    expect(screen).not.toContain('<release>.<package>.localhost')
    expect(screen).toContain('watching 1 app · 5 packages          logs → ~/.cache/infra-kit/ab12cd34/logs.txt')
    expect(screen).toContain('─'.repeat(60))
    // Non-TTY: no ANSI escapes (SGR colors) and no OSC-8 hyperlink escapes at all.
    expect(screen).not.toContain('\x1B[')
    expect(screen).not.toContain('\x1B]8')
  })

  it('renders a ● down dot for an unhealthy endpoint (URL still shown — provenance is honest)', () => {
    const { r, out } = makeRenderer()

    r.ready(baseSummary({ endpoints: [{ tag: 'api', url: 'https://feat-x.client-api.localhost/api/v1', healthy: false }] }))
    const screen = out.join('')

    expect(screen).toContain('● down')
    expect(screen).toContain('https://feat-x.client-api.localhost/api/v1')
  })

  it('renders a UI-only session (no backend rows) without leaving a blank screen', () => {
    const { r, out } = makeRenderer()

    r.ready(baseSummary({ endpoints: [], uiRefs: [{ tag: 'client/ui' }] }))
    const screen = out.join('')

    expect(screen).toContain('client/ui  → starting below (vite prints its URL)')
    expect(screen).toContain('logs → ~/.cache/infra-kit/ab12cd34/logs.txt')
  })

  it('keeps the release in the header meta even without a proxy — but never as a scheme legend', () => {
    // Regression: the footer used to advertise `<release>.<package>.localhost`, duplicating both the
    // concrete endpoint URLs and the release already shown in the meta line. It is gone entirely now.
    const { r, out } = makeRenderer()

    r.ready(baseSummary({ release: 'feat-x' }))
    const screen = out.join('')

    expect(screen).not.toContain('scheme')
    expect(screen).not.toContain('<release>.<package>.localhost')
    // The release still decorates the header meta line — real context, just not a URL promise.
    expect(screen).toContain('client · watch · feat-x')
  })

  it('emits no OSC-8 hyperlink escapes when piped', () => {
    const piped = makeRenderer({ isTTY: false })

    piped.r.ready(baseSummary())
    expect(piped.out.join('')).not.toContain('\x1B]8')
  })
})

describe('render — ready header (TTY: color + clickable log link)', () => {
  it('wraps the log path in an OSC-8 hyperlink on a TTY (cmd-clickable)', () => {
    const tty = makeRenderer({ isTTY: true })

    tty.r.ready(baseSummary())
    const ttyScreen = tty.out.join('')

    // Visible label is the home-shortened path; the href is the absolute file:// URI behind it.
    expect(ttyScreen).toContain('\x1B]8;;file:///home/u/.cache/infra-kit/ab12cd34/logs.txt\x1B\\')
    expect(ttyScreen).toContain('~/.cache/infra-kit/ab12cd34/logs.txt')
    expect(ttyScreen).toContain('\x1B]8;;\x1B\\')
  })

  it('percent-encodes a href containing spaces / `#` so the file:// URI stays valid', () => {
    const tty = makeRenderer({ isTTY: true })

    tty.r.ready(baseSummary({ logHref: '/home/my user/c#che/logs.txt', logPath: '~/c#che/logs.txt' }))
    const screen = tty.out.join('')

    expect(screen).toContain('\x1B]8;;file:///home/my%20user/c%23che/logs.txt\x1B\\')
    // The visible label is NOT encoded — it stays human-readable.
    expect(screen).toContain('~/c#che/logs.txt')
  })

  it('tees the ready header to the log file as plain text, even when the terminal frame is a TTY', () => {
    // Regression: both renderers format ready lines once (colored + hyperlinked) and tee that same
    // string. Escape bytes must be stripped at the tee seam so `logs.txt` stays greppable.
    const { r, log } = makeRenderer({ isTTY: true })

    r.ready(baseSummary())
    const file = log.join('')

    expect(file).not.toContain('\x1B[')
    expect(file).not.toContain('\x1B]8')
    // The hyperlink's visible label survives the strip — only the escapes are removed.
    expect(file).toContain('logs → ~/.cache/infra-kit/ab12cd34/logs.txt')
    expect(file).toContain('client/api')
  })
})

describe('render — formatter byte-equality guard', () => {
  // Pins the EXACT output of the two pure header formatters (non-TTY → plain text) so the
  // formatHeaderLines/formatReadyLines unification cannot drift a single byte. Covers a healthy,
  // a down, and an unprobed endpoint plus two UI refs (widest-tag padding + dot branches).
  const guardSummary = baseSummary({
    endpoints: [
      { tag: 'client/api', url: 'https://feat-x.client-api.localhost/api/v1', healthy: true },
      { tag: 'admin/api', url: 'https://feat-x.admin-api.localhost/api/v1', healthy: false },
      { tag: 'worker/api', url: 'https://feat-x.worker-api.localhost/api/v1', healthy: null },
    ],
    uiRefs: [{ tag: 'client/ui' }, { tag: 'admin-console/ui' }],
  })

  it('formatHeaderLines is byte-stable (no health dots)', () => {
    const { r } = makeRenderer()

    expect(r.formatHeaderLines(guardSummary).join('\n')).toMatchInlineSnapshot(`
      "
        infra-kit dev  client · watch · feat-x   ready in 2.4s

        client/api        https://feat-x.client-api.localhost/api/v1
        admin/api         https://feat-x.admin-api.localhost/api/v1
        worker/api        https://feat-x.worker-api.localhost/api/v1
        client/ui         → starting below (vite prints its URL)
        admin-console/ui  → starting below (vite prints its URL)

        watching 1 app · 5 packages          logs → ~/.cache/infra-kit/ab12cd34/logs.txt
        ────────────────────────────────────────────────────────────"
    `)
  })

  it('formatReadyLines is byte-stable (health dots on probed endpoints only)', () => {
    const { r } = makeRenderer()

    expect(r.formatReadyLines(guardSummary).join('\n')).toMatchInlineSnapshot(`
      "
        infra-kit dev  client · watch · feat-x   ready in 2.4s

        client/api        https://feat-x.client-api.localhost/api/v1  ● ok
        admin/api         https://feat-x.admin-api.localhost/api/v1  ● down
        worker/api        https://feat-x.worker-api.localhost/api/v1
        client/ui         → starting below (vite prints its URL)
        admin-console/ui  → starting below (vite prints its URL)

        watching 1 app · 5 packages          logs → ~/.cache/infra-kit/ab12cd34/logs.txt
        ────────────────────────────────────────────────────────────"
    `)
  })
})

describe('render — stripAnsi', () => {
  it('removes SGR colors and OSC-8 wrappers while keeping the visible label', () => {
    expect(stripAnsi('\x1B[2mdim\x1B[0m')).toBe('dim')
    expect(stripAnsi('\x1B]8;;file:///a/b.txt\x1B\\b.txt\x1B]8;;\x1B\\')).toBe('b.txt')
    expect(stripAnsi('\x1B[2mlogs → \x1B]8;;file:///a\x1B\\~/a\x1B]8;;\x1B\\\x1B[0m')).toBe('logs → ~/a')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here')
  })
})

describe('render — verbose narration + file tee', () => {
  it('narrate() reaches the terminal only in verbose, but always the log file', () => {
    const quiet = makeRenderer({ verbose: false })

    quiet.r.narrate('📂 Monorepo root: /x')
    expect(quiet.out.join('')).toBe('')
    expect(quiet.log.join('')).toContain('📂 Monorepo root: /x')

    const loud = makeRenderer({ verbose: true })

    loud.r.narrate('📂 Monorepo root: /x')
    expect(loud.out.join('')).toContain('📂 Monorepo root: /x')
    expect(loud.log.join('')).toContain('📂 Monorepo root: /x')
  })

  it('log() debug is terminal-only under verbose, but always tee’d', () => {
    const quiet = makeRenderer({ verbose: false })

    quiet.r.log('🔐 Doppler', 'debug')
    expect(quiet.out.join('')).toBe('')
    expect(quiet.log.join('')).toContain('[DEBUG] 🔐 Doppler')
  })

  it('the file tee carries an ISO timestamp + level for every line (completeness invariant)', () => {
    const { r, log } = makeRenderer()

    r.log('hello', 'warn')
    expect(log.join('')).toMatch(/^\[2026-07-08T14:02:11\.000Z\] \[WARN\] hello\n$/)
  })
})

describe('render — DevUi seams (teeOnly, dispose)', () => {
  it('teeOnly appends the canonical [iso] [LEVEL] line to the file WITHOUT any terminal write', () => {
    const { r, out, log } = makeRenderer()

    r.teeOnly('file only', 'warn')
    expect(out.join('')).toBe('')
    expect(log.join('')).toMatch(/^\[2026-07-08T14:02:11\.000Z\] \[WARN\] file only\n$/)
  })

  it('teeOnly and the log() tee share one format (log() writes the same shape teeOnly does)', () => {
    const viaTeeOnly = makeRenderer()

    viaTeeOnly.r.teeOnly('same message', 'info')

    const viaLog = makeRenderer()

    viaLog.r.log('same message', 'info')

    expect(viaLog.log.join('')).toBe(viaTeeOnly.log.join(''))
  })

  it('dispose() is a no-op for the plain renderer and idempotent', () => {
    const { r, out, log } = makeRenderer()

    expect(() => {
      r.dispose()
      r.dispose()
    }).not.toThrow()
    expect(out.join('')).toBe('')
    expect(log.join('')).toBe('')
  })
})

describe('render — tagged tail', () => {
  it('prints a timestamped, tagged tail line and tees a plain form', () => {
    const { r, out, log } = makeRenderer()

    r.event({ tag: 'client/api', text: 'GET /api/v1/ping 200 12ms' })
    // Clock renders in local time; assert against the same formatter rather than a hardcoded zone.
    expect(out.join('')).toContain(`${formatClock(frozen)}  client/api  GET /api/v1/ping 200 12ms`)
    expect(log.join('')).toContain('client/api GET /api/v1/ping 200 12ms')
  })
})

describe('render — spinner (TTY vs piped) + warn interleave', () => {
  it('non-TTY bootStep prints a plain phase line with no cursor ANSI', () => {
    const { r, out } = makeRenderer({ isTTY: false })

    r.bootStep('building api apps')
    const screen = out.join('')

    expect(screen).toContain('building api apps')
    expect(screen).not.toContain('\x1B[')
  })

  it('tTY bootStep paints an ANSI spinner frame; a mid-boot log clears and repaints it', () => {
    const { r, out } = makeRenderer({ isTTY: true })

    r.bootStep('building api apps')
    // A warning arrives while the spinner is live: it must clear the line, print, then repaint.
    r.log('⚠️  heads up', 'warn')
    r.stopSpinner()
    const screen = out.join('')

    expect(screen).toContain('\x1B[2K') // the clear-line sequence (spinner erase / repaint)
    expect(screen).toContain('⚠️  heads up')
    // The warning is not swallowed by the spinner and a spinner frame char is present.
    expect(screen).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })
})
