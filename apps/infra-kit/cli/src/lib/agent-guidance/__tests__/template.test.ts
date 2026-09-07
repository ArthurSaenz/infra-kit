import { describe, expect, it } from 'vitest'

import { renderTemplate } from '../template'

describe('renderTemplate — substitution', () => {
  it('replaces every occurrence of a placeholder', () => {
    expect(renderTemplate('{{a}} and {{a}} and {{b}}', { a: 'x', b: 'y' })).toBe('x and x and y')
  })

  it('leaves a template with no placeholders untouched', () => {
    expect(renderTemplate('# infra-kit\n\nplain prose', {})).toBe('# infra-kit\n\nplain prose')
  })

  it('substitutes in a single pass, never re-scanning an injected value', () => {
    // `packageName` comes from a `package.json` on disk, so a value can contain the
    // literal `{{b}}`. Successive `replaceAll` calls would substitute it on the next
    // pass; a single scan must not.
    expect(renderTemplate('{{a}}|{{b}}', { a: '{{b}}', b: 'INJECTED' })).toBe('{{b}}|INJECTED')
  })
})

describe('renderTemplate — drift between a resource and its call site', () => {
  it('throws when the template names a placeholder with no variable', () => {
    expect(() => {
      return renderTemplate('# {{packageName}}', {})
    }).toThrow('{{packageName}}')
  })

  it('throws when a supplied variable is never used by the template', () => {
    // A renamed placeholder would otherwise drop its value silently: the caller keeps
    // passing `readmeBullet` while the file has moved on to `{{readmeText}}`.
    expect(() => {
      return renderTemplate('# fixed', { packageName: '@x/y' })
    }).toThrow('packageName')
  })
})

describe('renderTemplate — the lone-list-item rule', () => {
  const template = '## Read first\n\n- {{readmeBullet}}\n- `infra-kit.config.ts` — the audit rules.'

  it('removes the list item, newline included, when the value is empty', () => {
    expect(renderTemplate(template, { readmeBullet: '' })).toBe(
      '## Read first\n\n- `infra-kit.config.ts` — the audit rules.',
    )
  })

  it('keeps the list item when the value is non-empty', () => {
    expect(renderTemplate(template, { readmeBullet: '`README.md` — what this is.' })).toBe(
      '## Read first\n\n- `README.md` — what this is.\n- `infra-kit.config.ts` — the audit rules.',
    )
  })

  it('is evaluated on the template, so an empty inline placeholder keeps its line', () => {
    // Applied to the rendered result instead, this rule would also match any bullet
    // that merely happened to render empty, and would eat structural blank lines.
    expect(renderTemplate('- prefix {{a}}', { a: '' })).toBe('- prefix ')
  })

  it('never removes a line whose placeholder is not the whole list item', () => {
    expect(renderTemplate('- {{a}} trailing', { a: '' })).toBe('-  trailing')
  })

  it('leaves a bare (non-list) placeholder line in place when empty', () => {
    expect(renderTemplate('above\n{{a}}\nbelow', { a: '' })).toBe('above\n\nbelow')
  })
})

describe('renderTemplate — multi-line values', () => {
  it('permits a multi-line value where the placeholder starts the line', () => {
    expect(renderTemplate('{{block}}\ntail', { block: 'one\ntwo' })).toBe('one\ntwo\ntail')
  })

  it('rejects a multi-line value for an indented placeholder rather than mis-indenting it', () => {
    expect(() => {
      return renderTemplate('  {{block}}', { block: 'one\ntwo' })
    }).toThrow('must start its line')
  })

  it('still permits a single-line value for an indented placeholder', () => {
    expect(renderTemplate('  {{a}}', { a: 'one' })).toBe('  one')
  })
})
