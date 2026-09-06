#!/usr/bin/env node
/**
 * Feature Validation Script
 *
 * Validates a feature folder for compliance with feature-based architecture rules:
 * - Naming conventions (atoms, components, services)
 * - File structure
 * - No cross-feature imports
 * - Required files (tests, stories)
 * - Public API exports
 *
 * Usage:
 *     node validate_feature.mjs <feature-path>
 *     node validate_feature.mjs features/user-profile
 */
import { existsSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { basename, extname, join, sep } from 'path'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ANSI color codes for terminal output
const Colors = {
  RED: '\x1b[91m',
  GREEN: '\x1b[92m',
  YELLOW: '\x1b[93m',
  BLUE: '\x1b[94m',
  MAGENTA: '\x1b[95m',
  CYAN: '\x1b[96m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
}

const printError = (msg) => {
  console.log(`${Colors.RED}✗ ERROR: ${msg}${Colors.RESET}`)
};

const printWarning = (msg) => {
  console.log(`${Colors.YELLOW}⚠ WARNING: ${msg}${Colors.RESET}`)
};

const printSuccess = (msg) => {
  console.log(`${Colors.GREEN}✓ ${msg}${Colors.RESET}`)
};

const printInfo = (msg) => {
  console.log(`${Colors.CYAN}ℹ ${msg}${Colors.RESET}`)
};

const printHeader = (msg) => {
  console.log(`\n${Colors.BOLD}${Colors.MAGENTA}${'='.repeat(60)}${Colors.RESET}`)
  console.log(`${Colors.BOLD}${Colors.MAGENTA}${msg}${Colors.RESET}`)
  console.log(`${Colors.BOLD}${Colors.MAGENTA}${'='.repeat(60)}${Colors.RESET}\n`)
};

// Recursive file globbing helper
async function* walkFiles(dir, pattern) {
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, pattern)
    } else if (entry.isFile() && pattern.test(entry.name)) {
      yield fullPath
    }
  }
}

/**
 * Splits a path into segments, so callers can test for a directory named
 * `__tests__` rather than for the substring `__tests__` anywhere in the path.
 * A feature living under `/repo/__tests__/fixtures/thing` is a real feature.
 */
const pathSegments = (filePath, rootPath) => {
  const relative = filePath.startsWith(rootPath) ? filePath.slice(rootPath.length) : filePath

  return relative.split(sep).filter(Boolean)
};

/**
 * Walks forward from the end of an `atom` keyword to the `(` that opens its
 * argument list, stepping over an optional generic parameter list so that
 * `atom<Foo | null>(null)` is seen as readily as `atom(null)`.
 *
 * @returns {number} index of the opening paren, or -1
 */
const findCallParen = (content, searchFrom) => {
  let i = searchFrom

  while (i < content.length && /\s/.test(content[i])) i++

  if (content[i] === '<') {
    let depth = 0

    for (; i < content.length; i++) {
      if (content[i] === '<') depth++
      else if (content[i] === '>') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      } else if (content[i] === '(' || content[i] === ';' || content[i] === '\n') {
        // Not a generic parameter list after all.
        return content[i] === '(' ? i : -1
      }
    }

    while (i < content.length && /\s/.test(content[i])) i++
  }

  return content[i] === '(' ? i : -1
};

/**
 * Returns the source text between a balanced pair of delimiters, starting at
 * `openIndex`. Strings, template literals and comments are stepped over so that
 * braces inside them do not affect the depth count.
 *
 * @returns {string|null} inner text, or null when the pair never closes
 */
const balancedSlice = (content, openIndex) => {
  let depth = 0
  let quote = null
  let lineComment = false
  let blockComment = false

  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]

    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }

    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i++
      }
      continue
    }

    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }

    if (ch === '/' && next === '/') {
      lineComment = true
      i++
      continue
    }

    if (ch === '/' && next === '*') {
      blockComment = true
      i++
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      continue
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return content.slice(openIndex + 1, i)
    }
  }

  return null
};

/**
 * Splits an argument list on the commas that sit at nesting depth zero, so that
 * `null, async (get, set, args: T) => {}` yields exactly two arguments.
 */
const splitTopLevelArgs = (argText) => {
  const args = []
  let depth = 0
  let quote = null
  let start = 0

  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i]

    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--
    else if (ch === ',' && depth === 0) {
      args.push(argText.slice(start, i).trim())
      start = i + 1
    }
  }

  const tail = argText.slice(start).trim()
  if (tail) args.push(tail)

  return args
};

/**
 * Classifies a single `atom(...)` call.
 *
 * Write-only atoms are `atom(null, writer)`. Everything else — `atom(value)`,
 * `atom(get => ...)`, `atom(value, writer)` — holds or derives state and so
 * carries the `$` prefix. The distinction is made from the call's own arguments;
 * an earlier version scanned the following ten lines of source, which let the
 * *next* declaration decide the current atom's classification.
 *
 * @returns {{kind: 'state'|'write-only', isAsync: boolean, writer: string|null}|null}
 */
const classifyAtom = (content, keywordEnd) => {
  const paren = findCallParen(content, keywordEnd)
  if (paren === -1) return null

  const argText = balancedSlice(content, paren)
  if (argText === null) return null

  const args = splitTopLevelArgs(argText)
  const isWriteOnly = args.length >= 2 && args[0] === 'null'

  if (!isWriteOnly) return { kind: 'state', isAsync: false, writer: null }

  const writer = args[1]

  return { kind: 'write-only', isAsync: /^async\b/.test(writer), writer }
};

/**
 * True when an import statement introduces no runtime dependency, covering both
 * `import type { X } from '...'` and the inline form `import { type X } from
 * '...'`. A mixed statement such as `import { a, type B }` does bind a value at
 * runtime and is therefore not type-only.
 */
const isTypeOnlyImport = (statement) => {
  if (/^import\s+type\b/.test(statement.trim())) return true

  const braces = statement.match(/\{([^}]*)\}/)
  if (!braces) return false

  // A default or namespace binding outside the braces is always a value.
  if (!/^import\s*\{/.test(statement.trim())) return false

  const specifiers = braces[1]
    .split(',')
    .map((specifier) => specifier.trim())
    .filter(Boolean)

  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s+\S/.test(specifier))
};

/**
 * Extracts the parameter list of a write-only atom's writer function.
 * `async (get, set, args: T) => {}` yields `['get', 'set', 'args: T']`.
 */
const writerParams = (writer) => {
  const paren = writer.indexOf('(')
  if (paren === -1) return []

  const params = balancedSlice(writer, paren)

  return params === null ? [] : splitTopLevelArgs(params)
};

class FeatureValidator {
  constructor(featurePath) {
    this.featurePath = featurePath
    this.featureName = basename(featurePath)
    this.errors = []
    this.warnings = []
    this.successes = []
    this.servicesShadowed = false
  }

  async validate() {
    printHeader(`Validating Feature: ${this.featureName}`)

    // 1. Check feature exists
    if (!existsSync(this.featurePath)) {
      printError(`Feature path does not exist: ${this.featurePath}`)
      return false
    }

    // 2. Validate feature name
    this.validateFeatureName()

    // 3. Check required files
    this.checkRequiredFiles()

    // 3b. Resolve which services variant is in play (must precede the walks)
    this.checkServicesVariants()

    // 4. Validate naming conventions
    await this.validateNamingConventions()

    // 5. Check for cross-feature imports
    await this.checkCrossFeatureImports()

    // 6. Validate public API exports
    await this.validatePublicApi()

    // 7. Check test coverage
    await this.checkTestCoverage()

    // 8. Validate component structure
    await this.validateComponentStructure()

    // Print summary
    this.printSummary()

    return this.errors.length === 0
  }

  validateFeatureName() {
    if (!/^[a-z][a-z0-9-]*$/.test(this.featureName)) {
      this.errors.push(`Feature name '${this.featureName}' must be kebab-case (lowercase with hyphens)`)
    } else {
      this.successes.push(`Feature name '${this.featureName}' is valid`)
    }
  }

  checkRequiredFiles() {
    const requiredFiles = ['index.ts', 'types.ts']

    for (const file of requiredFiles) {
      const filePath = join(this.featurePath, file)
      if (!existsSync(filePath)) {
        this.errors.push(`Missing required file: ${file}`)
      } else {
        this.successes.push(`Required file exists: ${file}`)
      }
    }
  }

  /**
   * True for files that carry no production rules, or that a sibling services
   * variant already covers. Segments are compared relative to the feature root,
   * so a feature nested under a `__tests__/` directory elsewhere on disk is
   * still scanned in full.
   */
  shouldSkipFile(filePath, { skipTests = true } = {}) {
    const segments = pathSegments(filePath, this.featurePath)

    if (skipTests && segments.some((segment) => segment === '__tests__' || segment === '__stories__')) {
      return true
    }

    // When both services variants exist the conflict is reported once by
    // checkServicesVariants(); scanning both would double every finding.
    return this.servicesShadowed && segments.length === 1 && segments[0] === 'services.ts'
  }

  checkServicesVariants() {
    const hasFile = existsSync(join(this.featurePath, 'services.ts'))
    const hasFolder = existsSync(join(this.featurePath, 'services'))

    this.servicesShadowed = hasFile && hasFolder

    if (this.servicesShadowed) {
      this.errors.push(
        'Feature has both services.ts and a services/ folder - keep exactly one (services.ts for < 3 endpoints and < 250 lines, services/ otherwise)',
      )
    }
  }

  async validateNamingConventions() {
    const tsPattern = /\.tsx?$/

    for await (const tsFile of walkFiles(this.featurePath, tsPattern)) {
      if (this.shouldSkipFile(tsFile)) {
        continue
      }

      await this.validateFileNaming(tsFile)
    }
  }

  async validateFileNaming(filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      const fileName = basename(filePath)

      // `atom` followed by an optional generic list, e.g. atom<Foo | null>(null)
      const atomRegex = /export\s+const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*atom\b/g
      let match

      while ((match = atomRegex.exec(content)) !== null) {
        const atomName = match[1]
        const atom = classifyAtom(content, match.index + match[0].length)

        if (!atom) {
          this.warnings.push(`Could not parse the atom call for '${atomName}' in ${fileName}`)
          continue
        }

        if (atom.kind === 'write-only') {
          // Write-only atoms: async must have Fx, sync must have Atom
          if (atom.isAsync && !atomName.endsWith('Fx')) {
            this.errors.push(`Async write-only atom '${atomName}' in ${fileName} must have 'Fx' suffix`)
          }

          // Rule 5 applies only to atoms that actually take an argument; a
          // no-argument reset atom is not required to invent one.
          const params = writerParams(atom.writer)
          const payload = params[2]

          if (payload && !/:\s*([A-Z]\w*|\{)/.test(payload)) {
            this.warnings.push(
              `Write-only atom '${atomName}' in ${fileName} should use object arguments with typed interface`,
            )
          }
        } else {
          // State or derived atoms must have $ prefix
          if (!atomName.startsWith('$')) {
            this.errors.push(`State/derived atom '${atomName}' in ${fileName} must have '$' prefix`)
          } else {
            this.successes.push(`Atom '${atomName}' has correct naming`)
          }
        }
      }

      // Check component naming
      if (filePath.includes('-component.tsx')) {
        this.validateComponentExport(filePath, content, 'Component')
      } else if (filePath.includes('-container.tsx')) {
        this.validateComponentExport(filePath, content, 'Container')
      }
    } catch (e) {
      this.warnings.push(`Could not validate ${basename(filePath)}: ${e.message}`)
    }
  }

  validateComponentExport(filePath, content, suffix) {
    // Extract expected component name from file name
    const fileNameWithoutExt = basename(filePath, extname(filePath))
    const words = fileNameWithoutExt.split('-')
    const expectedName = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')

    // Look for export const ComponentName
    const exportRegex = new RegExp(`export\\s+const\\s+(${expectedName})\\s*=`)
    const exportMatch = content.match(exportRegex)

    if (!exportMatch) {
      this.errors.push(`Component in ${basename(filePath)} should export '${expectedName}'`)
    } else {
      this.successes.push(`Component '${expectedName}' correctly named`)
    }
  }

  async checkCrossFeatureImports() {
    const tsPattern = /\.tsx?$/

    for await (const tsFile of walkFiles(this.featurePath, tsPattern)) {
      if (this.shouldSkipFile(tsFile)) {
        continue
      }

      try {
        const content = await readFile(tsFile, 'utf-8')

        // Look for imports from features/
        const importRegex = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|[\w,\s]+)\s+from\s+['"]([^'"]+)['"]/g
        let match

        while ((match = importRegex.exec(content)) !== null) {
          const importPath = match[1]

          // Check if it's importing from features/ but not current feature
          if (importPath.includes('features/') || importPath.includes('/features/')) {
            // Check if it's NOT the current feature
            if (!importPath.includes(this.featureName)) {
              // Type-only imports carry no runtime dependency and are allowed
              if (!isTypeOnlyImport(match[0])) {
                this.errors.push(
                  `Cross-feature import in ${basename(tsFile)}: ${importPath} (Only type-only imports allowed)`,
                )
              } else {
                this.successes.push(`Type-only cross-feature import in ${basename(tsFile)} (OK)`)
              }
            }
          }
        }
      } catch (e) {
        this.warnings.push(`Could not check imports in ${basename(tsFile)}: ${e.message}`)
      }
    }
  }

  async validatePublicApi() {
    const indexPath = join(this.featurePath, 'index.ts')

    if (!existsSync(indexPath)) {
      return // Already reported as error
    }

    try {
      const content = await readFile(indexPath, 'utf-8')

      // Check for service export
      const serviceExportRegex = /export\s+\*\s+as\s+(\w+Service)\s+from\s+['"]\.\/services['"]/
      const serviceMatch = content.match(serviceExportRegex)

      if (serviceMatch) {
        const serviceName = serviceMatch[1]

        // Validate naming: should be {featureName}Service
        const words = this.featureName.split('-')
        const expectedServiceName =
          words.map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join('') + 'Service'

        if (serviceName !== expectedServiceName) {
          this.errors.push(`Service export name '${serviceName}' should be '${expectedServiceName}'`)
        } else {
          this.successes.push(`Service export '${serviceName}' correctly named`)
        }
      }

      // Check for container exports
      if (content.includes('export {') && content.includes('Container')) {
        this.successes.push('Container exports found in index.ts')
      }
    } catch (e) {
      this.warnings.push(`Could not validate index.ts: ${e.message}`)
    }
  }

  /**
   * Story coverage is deliberately NOT checked here. `@wl/require-component-stories`
   * from `@slip-stream-kit/eslint-plugin` enforces it at `error`, with the same
   * defaults this convention uses (`__stories__/`, `.stories`, `-component`), and it
   * runs on every lint pass. Duplicating it here only produced a second, weaker
   * (warning-level) report of a failure lint already blocks on.
   */
  async checkTestCoverage() {
    const testsDir = join(this.featurePath, '__tests__')

    // Check dumb components
    const componentsDir = join(this.featurePath, 'components')

    if (existsSync(componentsDir)) {
      const entries = await readdir(componentsDir, { withFileTypes: true })
      const components = entries.filter((e) => e.isFile() && e.name.endsWith('-component.tsx'))

      for (const component of components) {
        const testName = component.name.replace('.tsx', '.test.tsx')
        const testPath = join(testsDir, testName)

        if (!existsSync(testPath)) {
          this.warnings.push(`Missing test for component: ${component.name} (expected at __tests__/${testName})`)
        } else {
          this.successes.push(`Test exists for ${component.name}`)
        }
      }
    }

    // Check containers
    const containersDir = join(this.featurePath, 'containers')

    if (existsSync(containersDir)) {
      const entries = await readdir(containersDir, { withFileTypes: true })
      const containers = entries.filter((e) => e.isFile() && e.name.endsWith('-container.tsx'))

      for (const container of containers) {
        const testName = container.name.replace('.tsx', '.test.tsx')
        const testPath = join(testsDir, testName)

        if (!existsSync(testPath)) {
          this.warnings.push(`Missing test for container: ${container.name} (expected at __tests__/${testName})`)
        } else {
          this.successes.push(`Test exists for ${container.name}`)
        }
      }
    }
  }

  /**
   * Resolves whether a dumb component accepts `className`, following the props
   * interface into the feature's types.ts when the component only references it
   * by name - which is what the skill's own conventions prescribe.
   */
  async acceptsClassName(content) {
    if (/className\s*[?:]/.test(content)) return true

    const propsType = content.match(/\(\s*(?:props|\{[^}]*\})\s*:\s*([A-Za-z_$][\w$]*)/)
    if (!propsType) return false

    const typesPath = join(this.featurePath, 'types.ts')
    if (!existsSync(typesPath)) return false

    const types = await readFile(typesPath, 'utf-8')
    const declaration = types.search(new RegExp(`\\b(?:interface|type)\\s+${propsType[1]}\\b`))
    if (declaration === -1) return false

    const brace = types.indexOf('{', declaration)
    if (brace === -1) return false

    const body = balancedSlice(types, brace)

    return body !== null && /className\s*[?:]/.test(body)
  }

  async validateComponentStructure() {
    // Check dumb components don't import from services
    const componentsDir = join(this.featurePath, 'components')

    if (existsSync(componentsDir)) {
      const entries = await readdir(componentsDir, { withFileTypes: true })
      const components = entries.filter((e) => e.isFile() && e.name.endsWith('-component.tsx'))

      for (const component of components) {
        try {
          const componentPath = join(componentsDir, component.name)
          const content = await readFile(componentPath, 'utf-8')

          // Check for forbidden imports in dumb components
          if (content.includes("from '../services'") || content.includes('from "../services"')) {
            this.errors.push(`Dumb component ${component.name} imports from services (forbidden)`)
          }

          if (content.includes('useAtomValue') || content.includes('useSetAtom') || content.includes('useAtom')) {
            this.errors.push(`Dumb component ${component.name} uses Jotai hooks (forbidden)`)
          }

          // Check for className prop. Rule 6 is blocking, so this is an error
          // rather than a warning - but the props interface usually lives in the
          // feature's types.ts, which has to be consulted before concluding the
          // prop is absent.
          if (await this.acceptsClassName(content)) {
            this.successes.push(`Component ${component.name} has className prop`)
          } else {
            this.errors.push(`Component ${component.name} must accept a className prop (rule 6)`)
          }
        } catch (e) {
          this.warnings.push(`Could not validate ${component.name}: ${e.message}`)
        }
      }
    }

    // Check containers handle loading/error/empty states
    const containersDir = join(this.featurePath, 'containers')

    if (existsSync(containersDir)) {
      const entries = await readdir(containersDir, { withFileTypes: true })
      const containers = entries.filter((e) => e.isFile() && e.name.endsWith('-container.tsx'))

      for (const container of containers) {
        try {
          const containerPath = join(containersDir, container.name)
          const content = await readFile(containerPath, 'utf-8')

          // Check for state handling
          const hasLoading = content.includes('isLoading') || content.includes('loading')
          const hasError = content.includes('error')

          if (!hasLoading) {
            this.warnings.push(`Container ${container.name} should handle loading state`)
          }

          if (!hasError) {
            this.warnings.push(`Container ${container.name} should handle error state`)
          }
        } catch (e) {
          this.warnings.push(`Could not validate ${container.name}: ${e.message}`)
        }
      }
    }
  }

  printSummary() {
    printHeader('Validation Summary')

    if (this.successes.length > 0) {
      console.log(`${Colors.GREEN}✓ Successes (${this.successes.length}):${Colors.RESET}`)
      const displaySuccesses = this.successes.slice(0, 10)
      for (const success of displaySuccesses) {
        console.log(`  ${Colors.GREEN}✓${Colors.RESET} ${success}`)
      }
      if (this.successes.length > 10) {
        console.log(`  ... and ${this.successes.length - 10} more`)
      }
      console.log()
    }

    if (this.warnings.length > 0) {
      console.log(`${Colors.YELLOW}⚠ Warnings (${this.warnings.length}):${Colors.RESET}`)
      for (const warning of this.warnings) {
        console.log(`  ${Colors.YELLOW}⚠${Colors.RESET} ${warning}`)
      }
      console.log()
    }

    if (this.errors.length > 0) {
      console.log(`${Colors.RED}✗ Errors (${this.errors.length}):${Colors.RESET}`)
      for (const error of this.errors) {
        console.log(`  ${Colors.RED}✗${Colors.RESET} ${error}`)
      }
      console.log()
    }

    // Final verdict
    if (this.errors.length > 0) {
      console.log(`${Colors.RED}${Colors.BOLD}❌ VALIDATION FAILED${Colors.RESET}`)
      console.log(`   ${this.errors.length} error(s) must be fixed`)
    } else {
      console.log(`${Colors.GREEN}${Colors.BOLD}✅ VALIDATION PASSED${Colors.RESET}`)
      if (this.warnings.length > 0) {
        console.log(`   ${this.warnings.length} warning(s) to review`)
      }
    }

    console.log()
  }
}

const main = async () => {
  if (process.argv.length < 3) {
    console.log('Usage: node validate_feature.mjs <feature-path>')
    console.log('Example: node validate_feature.mjs features/user-profile')
    process.exit(1)
  }

  const featurePath = process.argv[2]
  const validator = new FeatureValidator(featurePath)
  const success = await validator.validate()

  process.exit(success ? 0 : 1)
};

main()
