import { describe, expect, it } from 'vitest'

import { dirsUnderSrc, findPackageRoot } from '../package-root'

describe('dirsUnderSrc', () => {
  const root = '/repo/apps/client/ui'

  it('returns an empty list for a file directly in src/', () => {
    expect(dirsUnderSrc(root, `${root}/src/main.tsx`)).toEqual([])
  })

  it('returns every directory between src/ and the file, outermost first', () => {
    expect(dirsUnderSrc(root, `${root}/src/core/a.ts`)).toEqual(['core'])
    expect(dirsUnderSrc(root, `${root}/src/features/user/containers/a.tsx`)).toEqual(['features', 'user', 'containers'])
  })

  it('returns null for a file outside src/', () => {
    expect(dirsUnderSrc(root, `${root}/scripts/build.ts`)).toBeNull()
    expect(dirsUnderSrc(root, `${root}/vite.config.ts`)).toBeNull()
  })

  it('returns null for built output that mirrors src/', () => {
    expect(dirsUnderSrc(root, `${root}/dist/src/core/a.js`)).toBeNull()
  })

  it('returns null for a sibling whose name merely starts with src', () => {
    expect(dirsUnderSrc(root, `${root}/src-legacy/core/a.ts`)).toBeNull()
  })
})

describe('findPackageRoot', () => {
  it('returns null for the virtual filenames ESLint uses for unnamed sources', () => {
    expect(findPackageRoot('<input>')).toBeNull()
    expect(findPackageRoot('<text>')).toBeNull()
  })

  it('returns null for a relative filename', () => {
    expect(findPackageRoot('src/core/a.ts')).toBeNull()
  })
})
