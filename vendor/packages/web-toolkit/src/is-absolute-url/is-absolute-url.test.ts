/* eslint-disable sonarjs/no-clear-text-protocols */
import { describe, expect, it } from 'vitest'

import { isAbsoluteURL } from './is-absolute-url'

describe('isAbsoluteURL', () => {
  it('should return true for standard HTTP URLs', () => {
    expect(isAbsoluteURL('http://example.com')).toBe(true)
    expect(isAbsoluteURL('https://example.com')).toBe(true)
    expect(isAbsoluteURL('https://example.com/')).toBe(true)
    expect(isAbsoluteURL('http://example.com/path/to/resource')).toBe(true)
    expect(isAbsoluteURL('http://example.com/path/to/resource?query=value')).toBe(true)

    expect(isAbsoluteURL('http://subdomain.example.com')).toBe(true)
    expect(isAbsoluteURL('https://sub1.sub2.example.com')).toBe(true)
    expect(isAbsoluteURL('http://multiple.sub.domains.example.com/path')).toBe(true)
    expect(isAbsoluteURL('https://api.service.example.com:8080')).toBe(true)
  })

  it('should return true for other common protocols', () => {
    expect(isAbsoluteURL('ftp://files.example.com')).toBe(true)
    expect(isAbsoluteURL('sftp://secure.example.com')).toBe(true)
    expect(isAbsoluteURL('mailto:user@example.com')).toBe(true)
    expect(isAbsoluteURL('file:///path/to/file')).toBe(true)
  })

  it('should return true for custom protocols', () => {
    expect(isAbsoluteURL('custom+protocol://example.com')).toBe(true)
    expect(isAbsoluteURL('git+ssh://git@github.com/user/repo.git')).toBe(true)
  })

  it('should return false for relative URLs', () => {
    expect(isAbsoluteURL('/path/to/resource')).toBe(false)
    expect(isAbsoluteURL('./relative/path')).toBe(false)
    expect(isAbsoluteURL('../parent/path')).toBe(false)
    expect(isAbsoluteURL('path/to/resource')).toBe(false)
  })

  it('should return false for invalid or malformed URLs', () => {
    expect(isAbsoluteURL('')).toBe(false)
    expect(isAbsoluteURL('://no-protocol.com')).toBe(false)
    expect(isAbsoluteURL('123://invalid-protocol.com')).toBe(false)
    expect(isAbsoluteURL(' http://space-prefix.com')).toBe(false) // INFO: need to be careful with this case
  })
})
