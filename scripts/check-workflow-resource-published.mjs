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
const COMMAND_FILE = path.join(REPO_ROOT, 'plugins', 'infra-kit', 'commands', 'release-create.md')
const REQUIRED_URI = 'infra-kit://workflow/release-create'
const SPAWN_TIMEOUT_MS = 60_000

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

/**
 * The floor is read out of the command body rather than duplicated here. There is exactly one
 * statement of it, so the check can never drift from the sentence the user actually reads.
 */
const readFloor = () => {
  const body = fs.readFileSync(COMMAND_FILE, 'utf8')
  const match = /it needs infra-kit (\d+\.\d+\.\d+) or newer/.exec(body)
  if (!match) {
    fail(
      `could not find the version floor in ${path.relative(REPO_ROOT, COMMAND_FILE)} — has the fallback line changed?`,
    )
  }

  return match[1]
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

const floor = readFloor()
const published = execFileSync('pnpm', ['view', 'infra-kit@latest', 'version'], { encoding: 'utf8' }).trim()

console.log(`floor from the command body: ${floor}`)
console.log(`published infra-kit@latest:  ${published}`)

if (!isAtLeast(published, floor)) {
  fail(
    `infra-kit@latest is ${published}, below the floor ${floor} the command body names. ` +
      `Publish the CLI that serves ${REQUIRED_URI} before merging the command.`,
  )
}

const resources = await listPublishedResources(published)
const uris = resources.map((r) => r.uri)

if (!uris.includes(REQUIRED_URI)) {
  fail(
    `infra-kit@${published} does not serve ${REQUIRED_URI}. Its resources: ${uris.join(', ') || '(none)'}. ` +
      `The version floor is satisfied but the bundle does not carry the body — check the ?raw import survived the build.`,
  )
}

console.log(`OK: infra-kit@${published} serves ${REQUIRED_URI}`)
