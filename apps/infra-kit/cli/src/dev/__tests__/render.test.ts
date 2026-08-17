import { describe, expect, it } from 'vitest'

import { DevRenderer, formatElapsed, resolveEndpointUrl, stripAnsi } from 'src/dev/render'
import type { HealthState, ReadySummary } from 'src/dev/render'

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

    release: 'feat-x',
    elapsedMs: 2400,
    endpoints: [{ tag: 'client/api', url: 'https://feat-x.client-api.localhost/api/v1', health: 'ok' }],
    uiRefs: [{ tag: 'client/ui' }],
    watchSummary: '1 app · 5 packages',
    logPath: '~/.cache/infra-kit/ab12cd34/logs.txt',
    logHref: '/home/u/.cache/infra-kit/ab12cd34/logs.txt',
    ...over,
  }
}

describe('render — pure formatters', () => {
  it('formats elapsed as Xs', () => {
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
    expect(screen).toMatch(/client\/ui\s+no managed port \(vite prints its own URL\)/)
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

    r.ready(
      baseSummary({ endpoints: [{ tag: 'api', url: 'https://feat-x.client-api.localhost/api/v1', health: 'down' }] }),
    )
    const screen = out.join('')

    expect(screen).toContain('● down')
    expect(screen).toContain('https://feat-x.client-api.localhost/api/v1')
  })

  it('renders a UI-only session (no backend rows) without leaving a blank screen', () => {
    const { r, out } = makeRenderer()

    r.ready(baseSummary({ endpoints: [], uiRefs: [{ tag: 'client/ui' }] }))
    const screen = out.join('')

    expect(screen).toContain('client/ui  no managed port (vite prints its own URL)')
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

describe('render — nested per-app proxy list', () => {
  it('paints each frontend proxy as an indented route → source → target line under the app row', () => {
    const { r, out } = makeRenderer()

    r.ready(
      baseSummary({
        endpoints: [
          { tag: 'client/api', url: 'https://feat-x.client-api.localhost/api/v1', health: 'ok' },
          {
            tag: 'client/ui',
            url: 'https://feat-x.client-ui.localhost',
            health: 'ok',
            proxies: [
              { route: '/api', source: 'local', target: 'https://feat-x.client-api.localhost/api/v1' },
              { route: '/media', source: 'cloud', target: 'https://dev.hulyo.co.il/media' },
            ],
          },
        ],
        uiRefs: [],
      }),
    )
    const screen = out.join('')

    // Filled dot = local, hollow = cloud; the last route gets the └ elbow, the rest ├.
    expect(screen).toMatch(/├ \/api\s+● local\s+https:\/\/feat-x\.client-api\.localhost\/api\/v1/)
    expect(screen).toMatch(/└ \/media\s+○ cloud\s+https:\/\/dev\.hulyo\.co\.il\/media/)
  })

  it('attaches the list to a UI reference line too, and prints no URL for a route with no knowable target', () => {
    const { r, out } = makeRenderer()

    r.ready(
      baseSummary({
        endpoints: [],
        uiRefs: [{ tag: 'client/ui', proxies: [{ route: '/api', source: 'local' }] }],
      }),
    )
    const screen = out.join('')

    expect(screen).toContain('client/ui  no managed port')
    expect(screen).toMatch(/└ \/api\s+● local/)
    // No target on the route and no endpoint URL in this frame → the header carries no https origin at all.
    expect(screen).not.toContain('https://')
  })

  it('adds no proxy lines to a backend row or a frontend that declares none', () => {
    const { r, out } = makeRenderer()

    r.ready(
      baseSummary({
        endpoints: [{ tag: 'client/api', url: 'https://feat-x.client-api.localhost/api/v1', health: 'ok' }],
        uiRefs: [{ tag: 'client/ui' }],
      }),
    )
    const screen = out.join('')

    expect(screen).not.toContain('├')
    expect(screen).not.toContain('└')
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
      { tag: 'client/api', url: 'https://feat-x.client-api.localhost/api/v1', health: 'ok' },
      { tag: 'admin/api', url: 'https://feat-x.admin-api.localhost/api/v1', health: 'down' },
      { tag: 'worker/api', url: 'https://feat-x.worker-api.localhost/api/v1', health: 'unknown' },
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
        client/ui         no managed port (vite prints its own URL)
        admin-console/ui  no managed port (vite prints its own URL)

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
        client/ui         no managed port (vite prints its own URL)
        admin-console/ui  no managed port (vite prints its own URL)

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

/**
 * The live fields must live in the FOOTER, and this is the test that would have caught it when they
 * didn't.
 *
 * They were added to the shared endpoint line first. `formatHeaderLines` picked them up and looked
 * right in every unit test — but the header is committed once through Ink's `<Static>`, so it is a
 * photograph: anything painted there is frozen at its boot value forever. The footer, the only region
 * that repaints, kept printing a bare health dot. A real `infra-kit dev` run showed a panel with no
 * uptime, no req/min and no error count at all, while 1,400 tests stayed green.
 *
 * So: assert the live fields on the function that actually repaints.
 */
describe('render — the panel is the FOOTER (the live region), not the header', () => {
  const liveSummary = (): ReadySummary => {
    return {
      target: 'client',
      watch: false,
      elapsedMs: 2400,
      endpoints: [
        {
          tag: 'client/api',
          url: 'https://x.localhost/api/v1',
          health: 'ok',
          uptimeMs: 252_000,
          rpm: 18,
          restarts: 2,
          errors: 3,
        },
      ],
      uiRefs: [{ tag: 'client/ui', errors: 5 }],
      logPath: '~/.cache/infra-kit/s/dev/1',
      logHref: '/home/u/.cache/infra-kit/s/dev/1',
    }
  }

  it('renders uptime, req/min, restarts and the error count in the repainting region', () => {
    const footer = new DevRenderer({ isTTY: false }).formatFooterLines(liveSummary()).join('\n')

    expect(footer).toContain('up 4m12s')
    expect(footer).toContain('18/min')
    expect(footer).toContain('↺2')
    expect(footer).toContain('⚠ 3')
  })

  it('gives a UI with no managed port an error count too — it has no endpoint row to carry one', () => {
    // This row belongs to the app whose vite config never wired `infraKitDev()`: the one most likely to
    // be misconfigured, and the one whose breakage the panel would otherwise be unable to report.
    const footer = new DevRenderer({ isTTY: false }).formatFooterLines(liveSummary()).join('\n')

    expect(footer).toMatch(/client\/ui\s+⚠ 5/)
  })

  it('keeps a probed endpoint on the panel even at zero errors — silence is a claim, so it is stated', () => {
    const summary = liveSummary()

    summary.endpoints[0]!.errors = 0

    expect(new DevRenderer({ isTTY: false }).formatFooterLines(summary).join('\n')).toContain('⚠ 0')
  })
})

/**
 * The degraded-route row: the ONLY thing on screen that can say "the frontend came up healthy and is
 * talking to cloud". Its absence is the whole bug — a `● failed` backend row reads as "that half is
 * broken", never as "the other half is now silently pointed at the shared cloud backend".
 */
describe('degraded-route row', () => {
  const degradedSummary = (): ReadySummary => {
    return {
      target: 'clientLocal',
      watch: true,
      elapsedMs: 2400,
      endpoints: [],
      uiRefs: [],
      failed: [{ tag: 'client/api', reason: "config is missing field: 'connectionURL'" }],
      degraded: [{ route: '/api', tag: 'client/ui', fallback: 'cloud', target: 'https://dev.hulyo.co.il' }],
      logPath: '~/.cache/infra-kit/s/dev/1',
      logHref: '/home/u/.cache/infra-kit/s/dev/1',
    }
  }

  it('names the route, the demotion, and the cloud origin it fell back to', () => {
    const ready = new DevRenderer({ isTTY: false }).formatReadyLines(degradedSummary()).join('\n')

    expect(ready).toContain('client/ui /api')
    expect(ready).toContain('● cloud (local backend down)')
    expect(ready).toContain('https://dev.hulyo.co.il')
  })

  it('repaints on the live panel, not only in the committed header — so it can clear on recovery', () => {
    const footer = new DevRenderer({ isTTY: false }).formatFooterLines(degradedSummary()).join('\n')

    expect(footer).toContain('● cloud (local backend down)')
  })

  it('calls a local fallback a dead alias — saying "cloud" would name a destination traffic never reaches', () => {
    const summary: ReadySummary = {
      ...degradedSummary(),
      degraded: [{ route: '/api', tag: 'client/ui', fallback: 'local' }],
    }
    const footer = new DevRenderer({ isTTY: false }).formatFooterLines(summary).join('\n')

    expect(footer).toContain('● dead alias (local backend down)')
    expect(footer).not.toContain('cloud')
  })

  it('renders nothing when no route is degraded', () => {
    const summary = { ...degradedSummary(), degraded: [] }
    const renderer = new DevRenderer({ isTTY: false })

    expect(renderer.formatFooterLines(summary).join('\n')).not.toContain('local backend down')
    expect(renderer.formatReadyLines(summary).join('\n')).not.toContain('local backend down')
  })
})

/**
 * A UI-only session's panel must be ALIVE.
 *
 * The panel's only repaint rides `livenessTick`, and that timer used to be armed only when a BACKEND was
 * running (`if (this.appServers.length > 0)`). So a UI-only session — an FE-only repo, `--app=<x>/ui`, a
 * UI-only wizard pick — painted once at boot and froze: a `⚠ 0` row held forever while vite piped compile
 * errors into its log and the counter behind the row climbed unread. A green row over a UI that does not
 * compile is the exact lie this design exists to prevent, and it is worse than the tail it replaced —
 * there is nothing else on screen left to contradict it.
 *
 * The runner-side fix is to arm the tick unconditionally. This pins the render half: a UI row must be
 * able to REPORT, not just exist.
 */
describe('render — a UI-only session still has a live panel', () => {
  const uiOnly = (errors: number): ReadySummary => {
    return {
      target: 'client/ui',
      watch: false,
      elapsedMs: 900,
      endpoints: [],
      uiRefs: [{ tag: 'client/ui', errors }],
      logPath: '~/.cache/infra-kit/s/dev/1',
      logHref: '/home/u/.cache/infra-kit/s/dev/1',
    }
  }

  it('renders a UI row on the panel even with no backend endpoint at all', () => {
    const footer = new DevRenderer({ isTTY: false }).formatFooterLines(uiOnly(0))

    expect(footer.join('\n')).toMatch(/client\/ui\s+⚠ 0/)
  })

  it('moves that row when the UI starts failing — the panel is the only signal there is', () => {
    const renderer = new DevRenderer({ isTTY: false })

    expect(renderer.formatFooterLines(uiOnly(0)).join('\n')).toContain('⚠ 0')
    expect(renderer.formatFooterLines(uiOnly(7)).join('\n')).toContain('⚠ 7')
  })
})

/**
 * The heartbeat: a UI-only panel must MOVE.
 *
 * Arming the tick was only half the fix. Ink does not repaint an identical frame — and a UI-only session
 * has no backend, so its rows carry no uptime, no req/min, no restart count. With zero errors, every tick
 * produced a byte-identical frame and the screen sat perfectly still: the panel was verifiably alive and
 * looked exactly like a hung process. A real UI-only run showed precisely that.
 */
/**
 * The five health arms, and WHERE each one may be painted.
 *
 * A dot is a live fact, so it belongs to the region that repaints. The header is committed once through
 * Ink's `<Static>`: anything painted there is a photograph, and a health dot in a photograph is a claim
 * frozen at boot that can never turn red — nor, worse, turn back.
 */
describe('render — the health dot (all five arms)', () => {
  const withHealth = (health: HealthState): ReadySummary => {
    return baseSummary({
      endpoints: [{ tag: 'client/api', url: 'https://feat-x.client-api.localhost/api/v1', health }],
      uiRefs: [],
    })
  }

  const footerFor = (health: HealthState): string => {
    return new DevRenderer({ isTTY: false }).formatFooterLines(withHealth(health)).join('\n')
  }

  it('renders ● ok green, ● down red, ◌ starting and ◍ ? dim — and NOTHING at all for unknown', () => {
    const tty = new DevRenderer({ isTTY: true })

    expect(footerFor('ok')).toContain('● ok')
    expect(footerFor('down')).toContain('● down')
    expect(footerFor('starting')).toContain('◌ starting')
    // Answering, but not with vite's ping. Dim, never red: a non-204 is equally consistent with a broken
    // squatter and a healthy vite behind something that shadows the ping, and a red dot on a coin-flip is
    // how a dot stops being read at all.
    expect(footerFor('unverified')).toContain('◍ ?')

    // Nothing to probe (a UiRef, or `--no-ui-health`) → no dot at all, in any shape.
    const unknown = footerFor('unknown')

    expect(unknown).not.toContain('●')
    expect(unknown).not.toContain('◌')
    expect(unknown).not.toContain('◍')

    // The colours are part of the claim: only a PROOF of failure is allowed to be red.
    expect(tty.formatFooterLines(withHealth('ok')).join('\n')).toContain('\x1B[32m● ok\x1B[0m')
    expect(tty.formatFooterLines(withHealth('down')).join('\n')).toContain('\x1B[31m● down\x1B[0m')
    expect(tty.formatFooterLines(withHealth('starting')).join('\n')).toContain('\x1B[2m◌ starting\x1B[0m')
    expect(tty.formatFooterLines(withHealth('unverified')).join('\n')).toContain('\x1B[2m◍ ?\x1B[0m')
  })

  it('the FOOTER carries a dot for every arm but unknown — it is the only region that can', () => {
    for (const health of ['ok', 'down', 'starting', 'unverified'] as const) {
      expect(footerFor(health)).toMatch(/[●◌◍]/)
    }
    expect(footerFor('unknown')).not.toMatch(/[●◌◍]/)
  })

  it('the HEADER carries no dot for ANY arm — a live state committed to <Static> would freeze there', () => {
    const header = new DevRenderer({ isTTY: false })

    for (const health of ['ok', 'down', 'starting', 'unverified', 'unknown'] as const) {
      expect(header.formatHeaderLines(withHealth(health)).join('\n')).not.toMatch(/[●◌◍]/)
    }
  })

  it('the HEADER never reddens a tag either — it could never turn red later, nor turn back', () => {
    // The tag gutter goes red on a row that has declared an error. In the header that would be a permanent
    // red tag for an error the app has since stopped making, so `tagCell` is footer-only by construction.
    const broken = baseSummary({
      endpoints: [{ tag: 'client/api', url: 'https://x.localhost/api/v1', health: 'ok', errors: 3 }],
      uiRefs: [],
    })
    const tty = new DevRenderer({ isTTY: true })

    expect(tty.formatHeaderLines(broken).join('\n')).not.toContain('\x1B[31mclient/api')
    // The footer, which repaints, DOES redden it — otherwise this would pass vacuously.
    expect(tty.formatFooterLines(broken).join('\n')).toContain('\x1B[31mclient/api')
  })
})

/**
 * `⚠ N` has to win a glance against a green dot two columns away.
 *
 * That is the honest cost of a LIVENESS dot: a frontend that fails to compile still serves and still
 * answers vite's ping, so its row is `● ok  ⚠ 3` — a green dot beside an app that will not load. The
 * counter is the only thing on the screen that says so, so at N > 0 it is bold red and its tag turns red
 * with it. Neither is decoration.
 */
describe('render — the error counter is LOUD (a green dot can sit right next to it)', () => {
  const withErrors = (errors: number): ReadySummary => {
    return baseSummary({
      endpoints: [{ tag: 'client/api', url: 'https://x.localhost/api/v1', health: 'ok', errors }],
      uiRefs: [],
    })
  }

  it('renders a bold-red ⚠ N and a red tag once a row has declared an error', () => {
    const footer = new DevRenderer({ isTTY: true }).formatFooterLines(withErrors(3)).join('\n')

    expect(footer).toContain('\x1B[1m\x1B[31m⚠ 3\x1B[0m')
    expect(footer).toContain('\x1B[31mclient/api')
    // The dot stays honestly green: the app IS alive. The counter is what says it is nevertheless broken.
    expect(footer).toContain('\x1B[32m● ok\x1B[0m')
  })

  it('keeps ⚠ 0 dim and the tag teal — zero is stated, not shouted (and not omitted)', () => {
    const footer = new DevRenderer({ isTTY: true }).formatFooterLines(withErrors(0)).join('\n')

    expect(footer).toContain('\x1B[2m⚠ 0\x1B[0m')
    expect(footer).toContain('\x1B[36mclient/api')
    expect(footer).not.toContain('\x1B[1m\x1B[31m')
  })
})

describe('render — the panel has a heartbeat for every session shape', () => {
  const uiOnlyAt = (uptimeMs: number): ReadySummary => {
    return {
      target: 'client/ui',
      watch: false,
      elapsedMs: 900,
      endpoints: [],
      uiRefs: [{ tag: 'client/ui', errors: 0 }],
      logPath: '~/.cache/infra-kit/s/dev/1',
      logHref: '/home/u/.cache/infra-kit/s/dev/1',
      sessionUptimeMs: uptimeMs,
    }
  }

  it('renders a session uptime even when nothing else on the panel can change', () => {
    const renderer = new DevRenderer({ isTTY: false })
    const first = renderer.formatFooterLines(uiOnlyAt(5_000)).join('\n')
    const later = renderer.formatFooterLines(uiOnlyAt(65_000)).join('\n')

    expect(first).toContain('up 5s')
    expect(later).toContain('up 1m05s')
    // The whole point: consecutive frames must DIFFER, or Ink paints nothing and the screen freezes.
    expect(first).not.toBe(later)
  })
})
