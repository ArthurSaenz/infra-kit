import process from 'node:process'

/**
 * Node's warning code for "I had to guess this file's module type".
 *
 * Emitted when Node loads a `.ts` (or extensionless-ambiguous) file whose nearest
 * `package.json` declares no `"type"`: it first tries to parse the source as
 * CommonJS, fails on the ESM syntax, then reparses as an ES module and warns
 * about the double parse.
 */
const TYPELESS_PACKAGE_JSON = 'MODULE_TYPELESS_PACKAGE_JSON'

/** Read the warning `code` out of either `emitWarning` overload. */
const readWarningCode = (typeOrOptions: unknown, codeOrCtor: unknown): unknown => {
  // emitWarning(warning, options) — the code lives on the options object.
  if (typeof typeOrOptions === 'object' && typeOrOptions !== null) {
    return (typeOrOptions as { code?: unknown }).code
  }

  // emitWarning(warning, type, code, ctor) — the code is the third argument.
  return codeOrCtor
}

let installed = false

/**
 * Silence Node's `MODULE_TYPELESS_PACKAGE_JSON` warning for the rest of this
 * process, leaving every other warning untouched.
 *
 * The CLI imports config files it does not own — `infra-kit.config.ts` inside a
 * consumer's `apps/<app>/ui` — via `await import()`, relying on Node's native
 * type stripping. When that package declares no `"type"`, Node reparses the
 * config and prints a four-line warning naming a `package.json` that belongs to
 * the consumer, not to us.
 *
 * We swallow it rather than push `"type": "module"` onto consumers, because we
 * are the ones who chose the `.ts` config format and a published tool cannot
 * assume every package it reads a config from is ESM. (In our own repos this is
 * currently rare — 79 of 80 packages carrying an `infra-kit.config.ts` already
 * declare `"type": "module"`. The lone holdout is a Docusaurus app whose
 * `babel.config.js` still needs CommonJS resolution, which is exactly the class
 * of consumer we cannot dictate to.) The double parse of a small config is
 * irrelevant; the noise is not.
 *
 * Idempotent, and safe to call before any config import. Filters at
 * `process.emitWarning` rather than replacing the `'warning'` listener, so
 * unrelated warnings keep Node's native formatting and `--trace-warnings` hint.
 * Install-once and never restored on purpose: `loadDev` is called concurrently
 * (`Promise.all` over apps), so a scoped save/restore around each `await
 * import()` would race — one import's restore would fire while another was still
 * linking, and the warning is emitted during linkage, inside that await window.
 *
 * @example
 * suppressTypelessPackageJsonWarning()
 * // no MODULE_TYPELESS_PACKAGE_JSON banner, even though apps/ui/package.json has no "type"
 * const config = await import(pathToFileURL('apps/ui/infra-kit.config.ts').href)
 */
export const suppressTypelessPackageJsonWarning = (): void => {
  if (installed) return

  installed = true

  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void

  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    if (readWarningCode(rest[0], rest[1]) === TYPELESS_PACKAGE_JSON) return

    emitWarning(warning, ...rest)
  }) as typeof process.emitWarning
}
