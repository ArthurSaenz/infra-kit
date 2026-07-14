import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * A throwaway consumer package on disk: a `package.json`, an `infra-kit.config.ts` carrying a `dev.proxy`,
 * and the `.infra-kit/dev-context/` directory the runner writes its fragments into.
 *
 * Written to a REAL temp dir rather than mocked, because everything under test reads the filesystem the
 * way vite's config resolution does — `loadDev` imports the `.ts` config through Node's type stripping,
 * and the fragment reader searches upward from cwd. A mocked `fs` would prove none of that still works.
 */
export interface TempRepo {
  /** The package dir — what the plugin is given as `cwd`. */
  dir: string
  /** `<dir>/.infra-kit/dev-context`. */
  fragmentDir: string
  /** Record a package as locally running, at `origin`. */
  writeFragment: (packageName: string, origin: string) => string
  /** Remove a package's fragment, as a stopped runner would. */
  removeFragment: (packageName: string) => void
}

/** The two-route proxy every case here resolves against: both routes prefer `local`, and fall back to cloud. */
const CONFIG_SOURCE = `export default {
  dev: {
    proxy: {
      templates: {
        local: 'https://<release>.<packageName>.localhost',
        cloud: 'https://<env>.example.test',
      },
      routes: {
        '/api': { packageName: 'client-api', from: ['local', 'cloud'], default: 'cloud' },
        '/ws': { packageName: 'client-api', from: ['local', 'cloud'], default: 'cloud' },
      },
    },
  },
}
`

const created: string[] = []

/** Create the temp package. Every repo made this way is removed by {@link cleanupRepos}. */
export const createRepo = (): TempRepo => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-vite-'))
  const fragmentDir = path.join(dir, '.infra-kit', 'dev-context')

  created.push(dir)
  fs.mkdirSync(fragmentDir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'client-ui', type: 'module' }))
  fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), CONFIG_SOURCE)

  const fragmentPath = (packageName: string): string => {
    return path.join(fragmentDir, `${packageName}.json`)
  }

  return {
    dir,
    fragmentDir,
    writeFragment: (packageName, origin) => {
      const file = fragmentPath(packageName)

      // `pid` must be a LIVE process or the reader drops the fragment as stale (a crashed runner must not
      // keep a package pinned `local`), so the test process stands in for the runner.
      fs.writeFileSync(
        file,
        JSON.stringify({
          v: 2,
          package: packageName,
          port: 3110,
          pid: process.pid,
          writtenAt: 1,
          release: 'main',
          alias: `main.${packageName}.localhost`,
          origin,
        }),
      )

      return file
    },
    removeFragment: (packageName) => {
      fs.rmSync(fragmentPath(packageName), { force: true })
    },
  }
}

/** Remove every repo {@link createRepo} made. */
export const cleanupRepos = (): void => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
