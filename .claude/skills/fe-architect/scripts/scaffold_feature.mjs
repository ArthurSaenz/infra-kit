#!/usr/bin/env node
/**
 * Feature Scaffolder
 *
 * Copies the feature template into a features directory, substitutes every
 * placeholder in both file contents and file names, selects one services
 * variant, and then runs the skill's own validators against the result.
 *
 * Replaces the `cp -r` + hand-editing step, which required substituting four
 * placeholder forms across eleven files and renaming five of them.
 *
 * Usage:
 *     node scaffold_feature.mjs <features-dir> <feature-name> [--complex]
 *     node scaffold_feature.mjs apps/client/src/features user-profile
 *     node scaffold_feature.mjs apps/client/src/features user-profile --complex
 *
 * Options:
 *     --complex    Use the services/ folder variant (3+ endpoints or > 250
 *                  lines). Defaults to the single-file services.ts variant.
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = join(__dirname, '..')
const TEMPLATE_DIR = join(SKILL_DIR, 'assets', 'feature-template')
const VARIANTS_DIR = join(TEMPLATE_DIR, '_variants')

const Colors = {
  RED: '\x1b[91m',
  GREEN: '\x1b[92m',
  YELLOW: '\x1b[93m',
  CYAN: '\x1b[96m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
}

const printError = (msg) => console.log(`${Colors.RED}✗ ${msg}${Colors.RESET}`)
const printSuccess = (msg) => console.log(`${Colors.GREEN}✓ ${msg}${Colors.RESET}`)
const printInfo = (msg) => console.log(`${Colors.CYAN}ℹ ${msg}${Colors.RESET}`)

/**
 * Derives every casing the template uses from the kebab-case feature name.
 * `user-profile` -> { kebab, camel: userProfile, pascal: UserProfile, human: 'User Profile' }
 */
const nameForms = (kebab) => {
  const words = kebab.split('-')

  return {
    kebab,
    camel: words.map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1))).join(''),
    pascal: words.map((word) => word[0].toUpperCase() + word.slice(1)).join(''),
    human: words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' '),
  }
}

/**
 * Placeholder substitutions, longest-first so that `Feature Name` is consumed
 * before the shorter forms can match inside it.
 */
const substitutions = (names) => {
  return [
    ['Feature Name', names.human],
    ['FeatureName', names.pascal],
    ['featureName', names.camel],
    ['feature-name', names.kebab],
  ]
}

const applySubstitutions = (text, subs) => subs.reduce((acc, [from, to]) => acc.split(from).join(to), text)

/** Rewrites contents and renames files, depth-first so renames stay valid. */
const substituteTree = async (dir, subs) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      await substituteTree(path, subs)
    } else {
      const content = await readFile(path, 'utf-8')
      const substituted = applySubstitutions(content, subs)

      if (substituted !== content) await writeFile(path, substituted)
    }

    const newName = applySubstitutions(entry.name, subs)
    if (newName !== entry.name) await rename(path, join(dir, newName))
  }
}

/** Runs one of the sibling validators and resolves to its exit code. */
const runValidator = (script, args) => {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, script), ...args], { stdio: 'inherit' })

    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

const main = async () => {
  const argv = process.argv.slice(2)
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const [featuresDir, featureName] = argv.filter((arg) => !arg.startsWith('--'))
  const complex = flags.includes('--complex')

  if (!featuresDir || !featureName) {
    console.log('Usage: node scaffold_feature.mjs <features-dir> <feature-name> [--complex]')
    console.log('Example: node scaffold_feature.mjs apps/client/src/features user-profile')
    process.exit(1)
  }

  const unknown = flags.filter((flag) => flag !== '--complex')
  if (unknown.length > 0) {
    printError(`Unknown option(s): ${unknown.join(', ')}`)
    process.exit(1)
  }

  if (!/^[a-z][a-z0-9-]*$/.test(featureName)) {
    printError(`Feature name '${featureName}' must be kebab-case (lowercase letters, digits, hyphens)`)
    process.exit(1)
  }

  if (featureName === 'feature-name') {
    printError("Feature name 'feature-name' collides with the template placeholder - pick another name")
    process.exit(1)
  }

  const target = join(featuresDir, featureName)

  if (existsSync(target)) {
    printError(`Target already exists: ${target}`)
    process.exit(1)
  }

  if (!existsSync(TEMPLATE_DIR)) {
    printError(`Feature template not found at ${TEMPLATE_DIR}`)
    process.exit(1)
  }

  const names = nameForms(featureName)
  const variant = complex ? 'complex' : 'simple'

  printInfo(`Scaffolding '${featureName}' (${names.pascal}) into ${featuresDir} using the ${variant} services variant`)

  await mkdir(featuresDir, { recursive: true })

  // Copy the template without the variants directory, then layer the chosen
  // variant on top so the feature ships exactly one services form.
  await cp(TEMPLATE_DIR, target, {
    recursive: true,
    filter: (source) => source !== VARIANTS_DIR && !source.startsWith(VARIANTS_DIR + '/'),
  })
  await cp(join(VARIANTS_DIR, variant), target, { recursive: true })

  await substituteTree(target, substitutions(names))

  printSuccess(`Created ${target}`)
  console.log()

  const validate = await runValidator('validate_feature.mjs', [target])
  const structure = await runValidator('check_structure.mjs', [target])

  if (validate !== 0 || structure !== 0) {
    printError('Scaffolded feature did not pass validation - see the report above')
    process.exit(1)
  }

  printSuccess(`Feature '${featureName}' scaffolded and validated`)
  console.log()
  printInfo('Next: implement Types -> Dumb Components -> Services -> Smart Components -> index.ts')

  process.exit(0)
}

main().catch(async (error) => {
  printError(error.message)
  process.exit(1)
})
