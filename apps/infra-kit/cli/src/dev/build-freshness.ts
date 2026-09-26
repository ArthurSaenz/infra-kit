/**
 * @fileoverview
 *
 * What a package's last `tsc -b` run left behind in its `tsconfig.tsbuildinfo`, read after a watch restart:
 * the errors that build carried (it emitted anyway), and the sources it did NOT compile at their current
 * content. Pure file reads — the runner decides what to print and what to rebuild.
 *
 * Shapes measured on TypeScript 6.0.3: a file id is a 1-based index into `fileNames`, whose paths are
 * relative to the buildinfo's directory; `fileInfos[i]` (a string, or an object with `.version`) is the
 * sha256 hex of `fileNames[i]`'s text. A per-file diagnostics entry is `[fileId, diagnostics]`, or a bare
 * `fileId` when the file was never type-checked — what a syntax error leaves in `semanticDiagnosticsPerFile`.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface TsDiagnostic {
  code?: number
  messageText?: string | { messageText?: string }
}

type TsDiagnosticsEntry = number | [number, TsDiagnostic[]]

interface TsBuildInfo {
  fileNames?: string[]
  fileInfos?: Array<string | { version?: string }>
  semanticDiagnosticsPerFile?: TsDiagnosticsEntry[]
  emitDiagnosticsPerFile?: TsDiagnosticsEntry[]
  /** Set by some TypeScript versions for errors no per-file entry records (config, global). */
  errors?: boolean
}

export interface BuildInfo {
  /** The directory `fileNames` are relative to. */
  dir: string
  mtimeMs: number
  data: TsBuildInfo
}

export interface BuildErrors {
  /** Package-relative source path of the first problem, when the buildinfo names one. */
  file?: string
  /** `TS<code> <message>` for a diagnostic; `undefined` for a file that was never type-checked. */
  detail?: string
  total: number
}

export interface StaleSource {
  file: string
  /** sha256 of the file's CURRENT text — what the build would have recorded had it compiled this save. */
  hash: string
}

const buildInfoCandidates = (pkgDir: string): string[] => {
  return [pkgDir, path.join(pkgDir, 'dist')].flatMap((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => {
          return name.endsWith('.tsbuildinfo')
        })
        .map((name) => {
          return path.join(dir, name)
        })
    } catch {
      return []
    }
  })
}

/**
 * The package's most recently written `*.tsbuildinfo` (package root or `dist/`), or `undefined` when there is
 * none or it cannot be parsed — tsc may be mid-write, and a torn read is "unknown", never "broken".
 */
// The NEWEST one, because a package can also hold a buildinfo some other tsconfig (an editor, a ts-check
// script) left behind; the watch build is the one that just wrote.
export const readLatestBuildInfo = (pkgDir: string): BuildInfo | undefined => {
  let latest: { file: string; mtimeMs: number } | undefined

  for (const file of buildInfoCandidates(pkgDir)) {
    try {
      const { mtimeMs } = fs.statSync(file)

      if (!latest || mtimeMs > latest.mtimeMs) latest = { file, mtimeMs }
    } catch {
      // Deleted between readdir and stat.
    }
  }

  if (!latest) return undefined

  try {
    const data = JSON.parse(fs.readFileSync(latest.file, 'utf8')) as TsBuildInfo

    return { dir: path.dirname(latest.file), mtimeMs: latest.mtimeMs, data }
  } catch {
    return undefined
  }
}

/**
 * Did the build that wrote `info` also write these dist files? `tsc -b` writes its buildinfo AFTER its
 * outputs, so a newer output came from somewhere else: a turbo cache hit restores `dist/` but not the
 * buildinfo (not a declared output), which then describes a different source tree than the one serving.
 */
export const buildInfoCoversOutputs = (info: BuildInfo, distFiles: string[]): boolean => {
  return distFiles.every((file) => {
    try {
      return fs.statSync(file).mtimeMs <= info.mtimeMs
    } catch {
      // Unlinked since the event: says nothing about who wrote the rest.
      return true
    }
  })
}

const messageOf = (diagnostic: TsDiagnostic): string => {
  const text = diagnostic.messageText

  return typeof text === 'string' ? text : (text?.messageText ?? '')
}

/** The errors the last build recorded, or `undefined` for a clean one. */
export const summarizeBuildErrors = (info: BuildInfo, pkgDir: string): BuildErrors | undefined => {
  const { data } = info
  const fileOf = (fileId: number): string | undefined => {
    const name = data.fileNames?.[fileId - 1]

    return name === undefined ? undefined : path.relative(pkgDir, path.resolve(info.dir, name))
  }
  const diagnosed: BuildErrors[] = []
  const unchecked: BuildErrors[] = []

  for (const entry of [...(data.semanticDiagnosticsPerFile ?? []), ...(data.emitDiagnosticsPerFile ?? [])]) {
    if (typeof entry === 'number') {
      unchecked.push({ file: fileOf(entry), total: 1 })
      continue
    }

    const [fileId, diagnostics] = entry

    for (const diagnostic of diagnostics) {
      diagnosed.push({ file: fileOf(fileId), detail: `TS${diagnostic.code} ${messageOf(diagnostic)}`, total: 1 })
    }
  }

  // A real diagnostic names the fix; an unchecked file only says where to look, so it never leads.
  const all = [...diagnosed, ...unchecked]

  if (all.length === 0) return data.errors === true ? { total: 1 } : undefined

  return { ...all[0], total: all.length }
}

/**
 * One clause for the restart line, e.g.
 * `@pkg/lib-core has type errors: src/version.ts TS2322 Type 'number' is not assignable to type 'string'. (+1 more)`.
 */
export const formatBuildErrors = (pkgName: string, errors: BuildErrors): string => {
  const more = errors.total > 1 ? ` (+${errors.total - 1} more)` : ''

  if (errors.file === undefined) return `${pkgName} has build errors (see the watch log)${more}`
  if (errors.detail === undefined)
    return `${pkgName} has errors: ${errors.file} was not type-checked (syntax error)${more}`

  return `${pkgName} has type errors: ${errors.file} ${errors.detail}${more}`
}

const BOM = String.fromCharCode(0xfeff)

const sha256 = (text: string): string => {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * This package's own sources whose current text is not what the build compiled. Inputs outside `pkgDir`
 * (other packages' `.d.ts`, the TypeScript lib) and anything under `node_modules` are not this build's
 * edits and are never hashed. A file that no longer exists is not stale — it was deleted, not missed.
 */
export const findStaleSources = (info: BuildInfo, pkgDir: string): StaleSource[] => {
  const names = info.data.fileNames ?? []
  const infos = info.data.fileInfos ?? []
  const stale: StaleSource[] = []

  for (const [index, name] of names.entries()) {
    const file = path.resolve(info.dir, name)
    const relative = path.relative(pkgDir, file)

    if (relative.startsWith('..') || path.isAbsolute(relative)) continue
    if (relative.split(path.sep).includes('node_modules')) continue

    const recorded = infos[index]
    const version = typeof recorded === 'string' ? recorded : recorded?.version

    if (version === undefined) continue

    let text: string

    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }

    // TypeScript hashes the text it parsed, and its reader drops a UTF-8 BOM.
    const hash = sha256(text.startsWith(BOM) ? text.slice(1) : text)

    if (hash !== version) stale.push({ file, hash })
  }

  return stale
}

/** The package's `name`, or its directory name when `package.json` is unreadable. */
export const readPackageName = (pkgDir: string): string => {
  try {
    const { name } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { name?: unknown }

    if (typeof name === 'string' && name !== '') return name
  } catch {
    // Fall through to the directory name.
  }

  return path.basename(pkgDir)
}
