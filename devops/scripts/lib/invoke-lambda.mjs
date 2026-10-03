#!/usr/bin/env node
// Post-deploy Lambda invocation for CI/CD — replaces `serverless invoke` with a direct
// `aws lambda invoke`. Zero npm deps (Node stdlib + ../invoke-groups.mjs, where the groups
// are declared). Usage: node invoke-lambda.mjs --group <group> --stage <stage>
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { GROUPS } from '../invoke-groups.mjs'

const execFileAsync = promisify(execFile)

const REGION = 'eu-west-1'
const VERSION = 'v1' // matches serverless-config; part of the physical function name
const DEFAULT_PAYLOAD = '{"source":"aws.events"}' // gate: handlers reject other event sources
const READ_TIMEOUT_SECONDS = 960 // finite, > Lambda's 900s max, so CI can't hang forever
const CONNECT_TIMEOUT_SECONDS = 60
const MAX_BUFFER = 10 * 1024 * 1024

export const buildFunctionName = (entry, stage) => `${entry.serviceBase}-${VERSION}-${stage}-${entry.fn}`

export const parseArgs = (argv) => {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--group') args.group = argv[++i]
    else if (argv[i] === '--stage') args.stage = argv[++i]
  }
  return args
}

const truncate = (value, max = 500) => {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// `aws lambda invoke` exits 0 even when the handler throws — the only failure signal is
// `FunctionError` in the stdout metadata. Fail-closed on CLI error or unparseable metadata.
export const detectFailure = (result) => {
  if (!result.ok) {
    return { failed: true, reason: `aws CLI invocation failed: ${truncate(result.error?.message)}` }
  }
  let meta
  try {
    meta = JSON.parse(result.stdout)
  } catch {
    return { failed: true, reason: `unparseable invoke metadata: ${truncate(result.stdout)}` }
  }
  if (meta.FunctionError) {
    return { failed: true, reason: `FunctionError=${meta.FunctionError}` }
  }
  return { failed: false }
}

// Spawns the aws CLI, writing the response to a unique temp file (safe under concurrency).
export const defaultInvoker = async ({ functionName, payload }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lambda-invoke-'))
  const outFile = join(dir, 'response.json')
  const readBody = () => {
    try {
      return readFileSync(outFile, 'utf8')
    } catch {
      return undefined
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'aws',
      [
        'lambda',
        'invoke',
        '--function-name',
        functionName,
        '--region',
        REGION,
        '--cli-binary-format',
        'raw-in-base64-out',
        '--payload',
        payload,
        '--cli-read-timeout',
        String(READ_TIMEOUT_SECONDS),
        '--cli-connect-timeout',
        String(CONNECT_TIMEOUT_SECONDS),
        outFile,
      ],
      { maxBuffer: MAX_BUFFER },
    )
    return { ok: true, stdout, body: readBody() }
  } catch (error) {
    return { ok: false, error, body: readBody() }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

const fmtDuration = (ms) => `${(ms / 1000).toFixed(1)}s`

const invokeOne = async (entry, { stage, invoker }) => {
  const functionName = buildFunctionName(entry, stage)
  const payload = entry.payload ?? DEFAULT_PAYLOAD
  const start = Date.now()
  const result = await invoker({ functionName, payload })
  const durationMs = Date.now() - start
  return { functionName, durationMs, body: result.body, ...detectFailure(result) }
}

const logBestEffort = (logger, outcome) => {
  if (outcome.status === 'rejected') {
    logger.warn(
      `[invoke-lambda] best-effort invoke threw (continuing): ${truncate(outcome.reason?.message ?? outcome.reason)}`,
    )
    return
  }
  const r = outcome.value
  if (r.failed) {
    logger.warn(
      `[invoke-lambda] best-effort ${r.functionName} failed (${fmtDuration(r.durationMs)}, continuing): ${r.reason}`,
    )
    if (r.body) logger.warn(`[invoke-lambda] response body: ${truncate(r.body)}`)
  } else {
    logger.log(`[invoke-lambda] best-effort ${r.functionName} OK (${fmtDuration(r.durationMs)})`)
  }
}

// Runs a group's invocations and returns the process exit code (0 ok, 1 failure).
export const runGroup = async (group, stage, { invoker = defaultInvoker, logger = console } = {}) => {
  const config = GROUPS[group]
  if (!config) {
    logger.error(`[invoke-lambda] Unknown --group "${group}". Known groups: ${Object.keys(GROUPS).join(', ')}`)
    return 1
  }
  if (!stage) {
    logger.error('[invoke-lambda] Missing or empty --stage')
    return 1
  }

  // Phase A — blocking: sequential, fail-fast (any failure fails the deploy).
  for (const entry of config.blocking) {
    const r = await invokeOne(entry, { stage, invoker })
    if (r.failed) {
      logger.error(
        `[invoke-lambda] BLOCKING ${r.functionName} FAILED (${fmtDuration(r.durationMs)}) — failing deploy: ${r.reason}`,
      )
      if (r.body) logger.error(`[invoke-lambda] response body: ${truncate(r.body)}`)
      return 1
    }
    logger.log(`[invoke-lambda] blocking ${r.functionName} OK (${fmtDuration(r.durationMs)})`)
  }

  // Phase B — best-effort: ordered steps, concurrent within a step; never fails the deploy.
  for (const step of config.steps) {
    const settled = await Promise.allSettled(step.map((entry) => invokeOne(entry, { stage, invoker })))
    for (const outcome of settled) logBestEffort(logger, outcome)
  }

  return 0
}

export const main = async (argv = process.argv.slice(2)) => {
  const { group, stage } = parseArgs(argv)
  return runGroup(group, stage)
}

// Run only when executed directly, not when imported by tests. exitCode (not process.exit)
// lets stdout/stderr flush first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code
  })
}
