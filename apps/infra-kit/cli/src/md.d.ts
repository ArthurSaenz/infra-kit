/**
 * Markdown imported for its text, not parsed: `import body from './body.md?raw'`.
 *
 * The `?raw` suffix is the one spelling that is correct in all three toolchains
 * this package builds with. Vitest resolves it through Vite, where `?raw` is the
 * native "give me the file as a string" query and a bare `.md` import is an
 * unknown asset type. Esbuild strips the query before resolving and applies the
 * `.md` text loader wired in `scripts/build.js`. Tsc needs only this declaration.
 * A bare `.md` specifier would build but fail under vitest, which would make the
 * test suite exercise different bytes than the shipped bundle.
 */
declare module '*.md?raw' {
  const content: string

  export default content
}
