/**
 * Fixture: a `.ts` config inside a package whose `package.json` declares no `"type"`.
 *
 * Importing this file makes Node emit MODULE_TYPELESS_PACKAGE_JSON. The `export` is what
 * provokes it — drop it and the file parses as CommonJS, Node never warns, and the negative
 * control in node-warnings.test.ts quietly becomes a false green. The type annotation is not
 * load-bearing for the warning (verified); it is here so the fixture also exercises the type
 * stripping that makes these configs loadable at all.
 */
const port: number = 3000

export default { dev: { port } }
