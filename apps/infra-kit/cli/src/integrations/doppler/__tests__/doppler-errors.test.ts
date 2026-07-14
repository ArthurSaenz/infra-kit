import { describe, expect, it } from 'vitest'

import {
  buildDopplerAuthFailureMessage,
  buildDopplerNotFoundMessage,
  classifyDopplerDownloadError,
  classifyDopplerFailure,
  isDopplerAuthFailure,
} from '../doppler-errors'

// Verbatim Doppler stderr observed on a not-found download (doppler v3.76.0,
// 2026-06-27). The "[31m" prefix is the real ANSI color on "Doppler Error:".
const PROJECT_NOT_FOUND_STDERR =
  "Unable to download secrets\n[31mDoppler Error:[0m Could not find requested project 'infra-kit'\n"
const CONFIG_NOT_FOUND_STDERR =
  "Unable to download secrets\n[31mDoppler Error:[0m Could not find requested config 'bogus-cfg'\n"

// The two REAL auth-class stderr strings (SPIKE-0 Q1/Q4, live against doppler v3.76.0
// with a service token): a revoked/garbage token, and a token scoped to another config.
const INVALID_TOKEN_STDERR = 'Unable to download secrets\nDoppler Error: Invalid Auth token\n'
const MIS_SCOPED_TOKEN_STDERR =
  "Unable to download secrets\nDoppler Error: This token does not have access to requested config 'dev_personal'\n"

describe('classifyDopplerFailure — auth class', () => {
  it('classifies a revoked/garbage token as "auth"', () => {
    expect(classifyDopplerFailure(INVALID_TOKEN_STDERR)).toBe('auth')
  })

  it('classifies a mis-scoped token as "auth" — NOT as a config not-found', () => {
    expect(classifyDopplerFailure(MIS_SCOPED_TOKEN_STDERR)).toBe('auth')
  })

  it('keeps the not-found kinds distinct from auth, and network/timeout distinct from both', () => {
    expect(classifyDopplerFailure(PROJECT_NOT_FOUND_STDERR)).toBe('project')
    expect(classifyDopplerFailure(CONFIG_NOT_FOUND_STDERR)).toBe('config')
    expect(classifyDopplerFailure('connect ETIMEDOUT')).toBe('unknown')
    expect(classifyDopplerFailure('')).toBe('unknown')
  })

  it('isDopplerAuthFailure is the predicate form of the same lattice', () => {
    expect(isDopplerAuthFailure(INVALID_TOKEN_STDERR)).toBe(true)
    expect(isDopplerAuthFailure(MIS_SCOPED_TOKEN_STDERR)).toBe(true)
    expect(isDopplerAuthFailure(CONFIG_NOT_FOUND_STDERR)).toBe(false)
    expect(isDopplerAuthFailure('network unreachable')).toBe(false)
  })
})

describe('buildDopplerAuthFailureMessage', () => {
  it('names the env, the fix command, and the CI variable', () => {
    const msg = buildDopplerAuthFailureMessage('dev')

    expect(msg).toContain('"dev"')
    expect(msg).toContain('`infra-kit env-token-set dev`')
    expect(msg).toContain('INFRA_KIT_ENV_TOKEN')
  })

  it('never tells the user to run doppler login — account auth no longer exists', () => {
    expect(buildDopplerAuthFailureMessage('dev')).not.toContain('doppler login')
  })
})

describe('classifyDopplerDownloadError', () => {
  it('classifies a project-not-found stderr as "project"', () => {
    expect(classifyDopplerDownloadError(PROJECT_NOT_FOUND_STDERR)).toBe('project')
  })

  it('classifies a config-not-found stderr as "config"', () => {
    expect(classifyDopplerDownloadError(CONFIG_NOT_FOUND_STDERR)).toBe('config')
  })

  it('is color-safe — the markers are matched despite ANSI codes', () => {
    expect(classifyDopplerDownloadError('[31mDoppler Error:[0m Could not find requested project')).toBe('project')
  })

  it('returns "unknown" for unrelated failures (auth, network, timeout)', () => {
    // Auth-class failures collapse to "unknown" HERE on purpose: this classifier's callers
    // enrich with project/config listings, which a rejected token must never trigger.
    expect(classifyDopplerDownloadError(INVALID_TOKEN_STDERR)).toBe('unknown')
    expect(classifyDopplerDownloadError(MIS_SCOPED_TOKEN_STDERR)).toBe('unknown')
    expect(classifyDopplerDownloadError('Doppler Error: you must be logged in')).toBe('unknown')
    expect(classifyDopplerDownloadError('connect ETIMEDOUT')).toBe('unknown')
    expect(classifyDopplerDownloadError('')).toBe('unknown')
  })
})

describe('buildDopplerNotFoundMessage', () => {
  it('names the missing project and points at envManagement.config.name', () => {
    const msg = buildDopplerNotFoundMessage({ kind: 'project', project: 'infra-kit', config: 'dev', available: null })

    expect(msg).toContain('Doppler project "infra-kit" not found')
    expect(msg).toContain('envManagement.config.name')
    expect(msg).toContain('Fix:')
  })

  it('lists available projects when the enrichment list is non-empty', () => {
    const msg = buildDopplerNotFoundMessage({
      kind: 'project',
      project: 'infra-kit',
      config: 'dev',
      available: ['example-project', 'nomadream'],
    })

    expect(msg).toContain('Available projects: example-project, nomadream.')
  })

  it('omits the available line when the list is empty (told: none exist)', () => {
    const msg = buildDopplerNotFoundMessage({ kind: 'project', project: 'infra-kit', config: 'dev', available: [] })

    expect(msg).not.toContain('Available projects')
  })

  it('omits the available line when the list is null (lookup failed)', () => {
    const msg = buildDopplerNotFoundMessage({ kind: 'project', project: 'infra-kit', config: 'dev', available: null })

    expect(msg).not.toContain('Available projects')
  })

  it('names the missing config, its project, and the configs that DO exist', () => {
    const msg = buildDopplerNotFoundMessage({
      kind: 'config',
      project: 'nomadream',
      config: 'staging',
      available: ['dev', 'arthur'],
    })

    expect(msg).toContain('Doppler config "staging" not found in project "nomadream"')
    expect(msg).toContain('Available configs in "nomadream": dev, arthur.')
    expect(msg).toContain('Fix: pass an existing config, or create it in Doppler.')
  })

  // There is no declared env list any more, so there is nowhere in a config file to "fix" a missing
  // config. Pointing the user at `infra-kit.json → environments` would send them to a key that no
  // longer exists — and the schema is `.strict()`, so re-adding it would break every command.
  it('does not send the user to the removed `environments` key', () => {
    const msg = buildDopplerNotFoundMessage({
      kind: 'config',
      project: 'nomadream',
      config: 'staging',
      available: null,
    })

    expect(msg).not.toContain('environments')
  })
})
