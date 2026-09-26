// Shared by the release scripts: the four packages in publish order, the six version fields the
// bump commit must move together, and the registry probe every step gates on.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APPS = path.join(REPO_ROOT, 'apps', 'infra-kit')

// `config` first: the other three depend on it (`workspace:^`, packed as `^<version>`), so a
// consumer installing them must already find the same config on the registry.
export const PACKAGES = [
  { name: '@slip-stream-kit/config', dir: path.join(APPS, 'config') },
  { name: 'infra-kit', dir: path.join(APPS, 'cli') },
  { name: '@slip-stream-kit/eslint-plugin', dir: path.join(APPS, 'eslint-plugin') },
  { name: '@slip-stream-kit/vite', dir: path.join(APPS, 'vite') },
]

const ESLINT_PLUGIN_META = path.join(APPS, 'eslint-plugin', 'src', 'index.ts')
const PLUGIN_MANIFEST = path.join(REPO_ROOT, 'plugins', 'infra-kit', '.claude-plugin', 'plugin.json')

/** Everything the release bump must have moved together; a mismatch means the bump is half done. */
export const VERSION_FIELDS = [
  ...PACKAGES.map((pkg) => {
    return {
      file: path.join(pkg.dir, 'package.json'),
      read: (text) => JSON.parse(text).version,
      write: (text, version) => text.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`),
    }
  }),
  {
    file: PLUGIN_MANIFEST,
    read: (text) => JSON.parse(text).version,
    write: (text, version) => text.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`),
  },
  {
    file: ESLINT_PLUGIN_META,
    read: (text) => /version:\s*'([^']+)'/.exec(text)?.[1],
    write: (text, version) => text.replace(/(version:\s*)'[^']+'/, `$1'${version}'`),
  },
]

export const fail = (message) => {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

export const log = (line) => {
  console.log(`\n▶ ${line}`)
}

/** The one version every field agrees on; exits when the bump commit is half done. */
export const resolveVersion = () => {
  const seen = VERSION_FIELDS.map((field) => {
    return { file: path.relative(REPO_ROOT, field.file), version: field.read(fs.readFileSync(field.file, 'utf8')) }
  })
  const versions = new Set(
    seen.map((entry) => {
      return entry.version
    }),
  )
  if (versions.size !== 1) {
    fail(
      `the version fields disagree — finish the bump first:\n${seen
        .map((entry) => {
          return `    ${entry.version ?? '(missing)'}  ${entry.file}`
        })
        .join('\n')}`,
    )
  }
  return [...versions][0]
}

/**
 * Asked of the registry directly: `pnpm view` / `npm view` answer from a metadata cache that is
 * never revalidated, and `time[version]` exists the moment a publish has been processed.
 */
export const isPublished = async (name, version) => {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`registry answered ${response.status} for ${name}`)
  const body = await response.json()
  return Boolean(body.time?.[version])
}
