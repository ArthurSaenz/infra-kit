import { describe, expect, it } from 'vitest'

import { buildDopplerNotFoundMessage, classifyDopplerDownloadError } from '../doppler-errors'

// Verbatim Doppler stderr observed on a not-found download (doppler v3.76.0,
// 2026-06-27). The "[31m" prefix is the real ANSI color on "Doppler Error:".
const PROJECT_NOT_FOUND_STDERR =
  "Unable to download secrets\n[31mDoppler Error:[0m Could not find requested project 'infra-kit'\n"
const CONFIG_NOT_FOUND_STDERR =
  "Unable to download secrets\n[31mDoppler Error:[0m Could not find requested config 'bogus-cfg'\n"

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

  it('names the missing config, its project, and points at environments', () => {
    const msg = buildDopplerNotFoundMessage({
      kind: 'config',
      project: 'nomadream',
      config: 'staging',
      available: ['dev', 'arthur'],
    })

    expect(msg).toContain('Doppler config "staging" not found in project "nomadream"')
    expect(msg).toContain('infra-kit.json → environments')
    expect(msg).toContain('Available configs in "nomadream": dev, arthur.')
  })
})
