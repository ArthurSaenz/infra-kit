import { describe, expect, it } from 'vitest'

import { equivalentLine } from '../equivalent'

describe('equivalentLine', () => {
  it('defaults reproducible to true', () => {
    expect(equivalentLine('infra-kit vendor check')).toEqual({
      line: 'infra-kit vendor check',
      reproducible: true,
    })
  })

  it('carries an explicit reproducible flag', () => {
    expect(equivalentLine('infra-kit dev --app=client', false)).toEqual({
      line: 'infra-kit dev --app=client',
      reproducible: false,
    })
  })
})
