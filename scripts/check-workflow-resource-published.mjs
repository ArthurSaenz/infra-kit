#!/usr/bin/env node
// PM-C, part 3 — the only part of the mitigation that actually ENFORCES the ordering.
//
// `plugins/infra-kit/commands/release-create.md` opens by telling the agent to read the MCP resource
// `infra-kit://workflow/release-create`. That resource ships in the separately published `infra-kit`
// npm package; the command ships through the marketplace entry, which sources `./plugins/infra-kit`
// from git and pins no version. Two clocks. Merging the command before the CLI that serves the
// resource is published puts EVERY user in the broken window — not an edge case, the default — where
// the command's entire first instruction points at a 404.
//
// The command's fallback line and its version floor make that window survivable. This check is what
// stops it opening in the first place, and it is deliberately a script rather than inline YAML so it
// can be run by hand before a release.
//
// Two assertions, both required:
//   1. the published `infra-kit@latest` is at or above the floor named in the command body, and
//   2. that published build actually ANSWERS `resources/list` with the URI — because a version
//      number is a claim, and the bundle inlining the markdown is the thing that can silently fail
//      (E-D covers this on our own build; here it is checked against what a user would install).
//
// Usage:  node scripts/check-workflow-resource-published.mjs
// Red:    run it before the CLI publishes → exits non-zero and PR E cannot merge.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMANDS_DIR = path.join(REPO_ROOT, 'plugins', 'infra-kit', 'commands')
const SPAWN_TIMEOUT_MS = 60_000

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

// Enumerated, never a literal. The first spelling of this check hardcoded `release-create.md` and
// one URI, so the SECOND command to be added would have shipped completely unchecked — the gate
// would have stayed green while reintroducing the exact broken window it exists to prevent. A gate
// that only guards the example it was written for is worse than none, because it reads as coverage.
const readCommands = () => {
  if (!fs.existsSync(COMMANDS_DIR)) return []

  return fs
    .readdirSync(COMMANDS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const file = path.join(COMMANDS_DIR, entry.name)
      const body = fs.readFileSync(file, 'utf8')
      const name = entry.name.replace(/\.md$/, '')

      return {
        name,
        rel: path.relative(REPO_ROOT, file),
        // Both read out of the body rather than duplicated here, so the check cannot drift from the
        // sentences the user actually reads, and deleting either one fails loudly instead of
        // silently disabling the gate for that command.
        floor: /it needs infra-kit (\d+\.\d+\.\d+) or newer/.exec(body)?.[1] ?? null,
        uri: /infra-kit:\/\/workflow\/[a-z0-9-]+/.exec(body)?.[0] ?? null,
      }
    })
}

/**
 * The pure half: given what the commands claim and what the published build serves, list every
 * violation. No filesystem, no registry, no spawn — so the gate's logic is testable without a
 * network round trip, which the previous all-in-one shape made impossible.
 *
 * Returns ALL violations rather than the first. Fail-fast was a real hazard here and not a style
 * point: the gate is red today for `release-create` (floor 0.5.0, published 0.4.0), so an early
 * `exit` on that known redness would mean a newly added second command was never examined at all.
 */
export const collectViolations = ({ commands, published, servedUris }) => {
  const violations = []

  for (const command of commands) {
    if (command.floor === null) {
      violations.push(
        `${command.rel}: no version floor found — has the "it needs infra-kit X.Y.Z or newer" line changed?`,
      )
      continue
    }

    if (command.uri === null) {
      violations.push(`${command.rel}: names no infra-kit://workflow/... resource — what is this command's body?`)
      continue
    }

    if (!isAtLeast(published, command.floor)) {
      violations.push(
        `${command.rel}: infra-kit@latest is ${published}, below the floor ${command.floor} its body names. ` +
          `Publish the CLI that serves ${command.uri} before merging this command.`,
      )
      continue
    }

    if (!servedUris.includes(command.uri)) {
      violations.push(
        `${command.rel}: infra-kit@${published} does not serve ${command.uri}. ` +
          `Served: ${servedUris.join(', ') || '(none)'}. The floor is satisfied but the bundle does not carry the ` +
          `body — check the ?raw import survived the build.`,
      )
    }
  }

  return violations
}

/** Numeric semver compare, enough for the x.y.z the floor and the registry both use. */
const isAtLeast = (version, floor) => {
  const [a, b] = [version, floor].map((v) => v.split('.').map(Number))
  for (const [i, floorPart] of b.entries()) {
    if (a[i] > floorPart) return true
    if (a[i] < floorPart) return false
  }

  return true
}

/**
 * Drive the published server over stdio and ask it for its resource list. Hand-rolled JSON-RPC
 * rather than the SDK client: this must test what a USER's install answers, so it should share as
 * little code with this repo as possible.
 */
const listPublishedResources = async (version) => {
  return await new Promise((resolve, reject) => {
    // `pnpm dlx`, not the npm-family runner: this is a pnpm workspace and the repo's own tooling
    // guard rejects the latter, so using it here would make the check unrunnable by hand.
    const child = spawn('pnpm', ['dlx', `infra-kit@${version}`, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the published server did not answer resources/list within ${SPAWN_TIMEOUT_MS}ms`))
    }, SPAWN_TIMEOUT_MS)

    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer)
          child.kill()
          resolve(msg.result.resources ?? [])
        }
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'pmc-check', version: '0.0.0' },
          capabilities: {},
        },
      })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' })}\n`)
  })
}

// Guarded so importing this module for its `collectViolations` seam does not hit the registry.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url)

if (isEntrypoint) {
  const commands = readCommands()

  if (commands.length === 0) {
    console.log('no plugin commands to check')
    process.exit(0)
  }

  const published = execFileSync('pnpm', ['view', 'infra-kit@latest', 'version'], { encoding: 'utf8' }).trim()

  console.log(`published infra-kit@latest: ${published}`)
  for (const command of commands) {
    console.log(`  ${command.name}: floor ${command.floor ?? '(none found)'} → ${command.uri ?? '(no URI found)'}`)
  }

  // ONE spawn for every command, not one each. The resource list is a property of the published
  // build, so asking it N times would cost N cold `pnpm dlx` installs to learn the same answer.
  // Skipped entirely when no command's floor is met — there is nothing the list could tell us that
  // the floor has not already decided, and the spawn is the expensive half.
  const anyFloorMet = commands.some((command) => {
    return command.floor !== null && isAtLeast(published, command.floor)
  })
  const servedUris = anyFloorMet ? (await listPublishedResources(published)).map((r) => r.uri) : []

  const violations = collectViolations({ commands, published, servedUris })

  if (violations.length > 0) {
    for (const violation of violations) console.error(`FAIL: ${violation}`)
    fail(`${violations.length} command(s) would ship ahead of the CLI that serves their resource`)
  }

  console.log(`OK: infra-kit@${published} serves every command's workflow resource`)
}
