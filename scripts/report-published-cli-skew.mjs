#!/usr/bin/env node
// Reports — never gates — the skew between the plugin's skills at HEAD and the PUBLISHED infra-kit CLI
// (docs/session-env-picker-plan.md §3.6c).
//
// Two clocks: the plugin is git-sourced and unpinned, so a merged skill is live on a consumer's next
// `plugin update`; the CLI is live only on `pnpm add -g`. A skill can therefore name a tool, or lean on
// a schema property, that the build a user actually installs does not have. The gate this replaced
// (`check-workflow-resource-published.mjs`) turned that into a red PR check, which blocked unrelated
// plugin PRs between merge and publish — so this one is `continue-on-error` in plugin-ci and answers
// the question with visibility instead: per skill, every plugin-prefixed tool the published build
// lacks, plus whether `env-load` still REQUIRES `config` (the session skill's form path assumes it does
// not, and its fallback clause is what survives when it does).
//
// Written to `$GITHUB_STEP_SUMMARY` when set, so it is readable on the PR page without opening the
// log; a `continue-on-error` step's stdout is otherwise invisible there.
//
// Usage:  node scripts/report-published-cli-skew.mjs
// Exit:   always 0. A registry or spawn failure is REPORTED, not raised.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = path.join(REPO_ROOT, 'plugins', 'infra-kit', 'skills')
// The one definition of "names a plugin-served tool", shared with the plugin manifest suite and the
// CLI's catalog cross-check so the three scans cannot drift (the fixture's `_pluginToolNameWhy`).
const SCAN_PATTERNS = path.join(REPO_ROOT, 'plugins', 'infra-kit', '__tests__', '__fixtures__', 'scan-patterns.json')
const SPAWN_TIMEOUT_MS = 60_000

const pluginToolNameRe = () => {
  return new RegExp(JSON.parse(fs.readFileSync(SCAN_PATTERNS, 'utf8')).pluginToolName, 'g')
}

/** `{ <skill name>: <SKILL.md text> }` for every skill directory that carries a SKILL.md. */
const readSkillTexts = () => {
  if (!fs.existsSync(SKILLS_DIR)) return {}

  const texts = {}
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    const file = path.join(SKILLS_DIR, entry.name, 'SKILL.md')
    if (entry.isDirectory() && fs.existsSync(file)) texts[entry.name] = fs.readFileSync(file, 'utf8')
  }

  return texts
}

/**
 * The pure half: what the skills name versus what the published build serves.
 *
 * `publishedTools` is the `tools` array of a `tools/list` result (`{ name, inputSchema }` each);
 * `skillTexts` maps a skill name to its SKILL.md text. Returns, per skill, every plugin-prefixed tool
 * name the published build lacks (skills naming none are omitted), and whether `env-load`'s schema
 * still lists `config` as required — `null` when the published build serves no `env-load` at all.
 *
 * No filesystem, no registry, no spawn: a report script whose decision half cannot be unit-tested can
 * print nothing and look healthy, which is worse than no report.
 */
export const collectSkew = (publishedTools, skillTexts) => {
  const toolNameRe = pluginToolNameRe()
  const served = new Set(publishedTools.map((tool) => tool.name))

  const missingBySkill = {}
  for (const [skill, text] of Object.entries(skillTexts)) {
    const named = [...new Set([...text.matchAll(toolNameRe)].map((match) => match[1]))]
    const missing = named.filter((name) => !served.has(name))
    if (missing.length > 0) missingBySkill[skill] = missing
  }

  const envLoad = publishedTools.find((tool) => tool.name === 'env-load')
  const envLoadRequiresConfig = envLoad ? (envLoad.inputSchema?.required ?? []).includes('config') : null

  return { missingBySkill, envLoadRequiresConfig }
}

/** The report as Markdown — one shape for the step summary and for stdout. */
export const renderReport = ({ published, skew, failure }) => {
  const lines = [`## Published CLI skew — infra-kit@${published ?? '(unknown)'}`, '']

  if (failure) {
    lines.push(`Could not read the published build: ${failure}`, '')
    return lines.join('\n')
  }

  const skills = Object.entries(skew.missingBySkill)
  if (skills.length === 0) {
    lines.push('Every plugin-prefixed tool named by a skill is served by the published build.')
  } else {
    lines.push('Tools named by a skill that the published build does NOT serve:', '')
    for (const [skill, missing] of skills) lines.push(`- \`${skill}\`: ${missing.map((m) => `\`${m}\``).join(', ')}`)
  }

  const requires =
    skew.envLoadRequiresConfig === null
      ? '`env-load` is not served by the published build.'
      : skew.envLoadRequiresConfig
        ? '`env-load` still REQUIRES `config` — the session skill takes its fallback on this build.'
        : "`env-load` accepts a missing `config` — the session skill's form path is live."
  lines.push('', requires, '')

  return lines.join('\n')
}

/**
 * Drive the published server over stdio and ask it for its tool list. Hand-rolled JSON-RPC rather
 * than the SDK client: this must observe what a USER's install answers, so it shares as little code
 * with this repo as possible.
 */
const listPublishedTools = async (version) => {
  return await new Promise((resolve, reject) => {
    // `pnpm dlx`, not the npm-family runner: this is a pnpm workspace and the repo's own tooling
    // guard rejects the latter, so using it here would make the report unrunnable by hand.
    const child = spawn('pnpm', ['dlx', `infra-kit@${version}`, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the published server did not answer tools/list within ${SPAWN_TIMEOUT_MS}ms`))
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
          resolve(msg.result.tools ?? [])
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
          clientInfo: { name: 'skew-report', version: '0.0.0' },
          capabilities: {},
        },
      })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  })
}

const publish = (report) => {
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) fs.appendFileSync(summary, `${report}\n`)
  console.log(report)
}

// Guarded so importing this module for its `collectSkew` seam does not hit the registry.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url)

if (isEntrypoint) {
  let published
  try {
    published = execFileSync('pnpm', ['view', 'infra-kit@latest', 'version'], { encoding: 'utf8' }).trim()
    const tools = await listPublishedTools(published)
    publish(renderReport({ published, skew: collectSkew(tools, readSkillTexts()) }))
  } catch (error) {
    // A report that cannot be produced is itself the report; the step stays green either way.
    publish(renderReport({ published, failure: error instanceof Error ? error.message : String(error) }))
  }
}
