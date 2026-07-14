// DEFAULT import, deliberately — the same reason config-bootstrap.ts documents: the module is used as
// `fs.readFile(...)` / `fs.mkdir(...)` so every call is a property lookup on the live module object,
// which is what `vi.spyOn(fs, …)` patches. A named import (`import { readFile }`) is bound at import
// time and the spy silently does NOT intercept it — the assertion goes green while the real call
// still hits disk. Do not "modernize" this import.
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { atomicWriteFileSync } from 'src/lib/constants'
import { EnvAuthError } from 'src/lib/errors/env-auth-error'
import { getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
import { tildify } from 'src/lib/path-display'

/**
 * Basename of the token store. A SIBLING of the layer-3 `infra-kit.json`, never a key inside it:
 * `getInfraKitConfig` only ever globs the three hardcoded `infra-kit.json` paths and its schema is
 * `.strict()`, so an unknown key throws at the LAYER parse and bricks every command on every pinned
 * version. A sibling file is structurally invisible to that loader — `config-bootstrap.ts` already
 * relies on exactly this for its `.example.jsonc`. That invisibility is the blast-radius guarantee:
 * a corrupt `tokens.json` can only break the readers below, never `worktrees-list`.
 */
const TOKEN_STORE_FILE = 'tokens.json'

/** Schema version of the on-disk store. Bump only alongside a migration. */
const TOKEN_STORE_VERSION = 1

/** Mode of `tokens.json` itself — owner read/write only. It holds live credentials. */
const TOKEN_FILE_MODE = 0o600

/** Mode of every directory on the way to the store — owner-only traversal. */
const TOKEN_DIR_MODE = 0o700

/**
 * The store's OWN schema: `{ version?: 1, envs: { <env>: <token> } }`. Deliberately NOT derived from
 * `infraKitConfigObject`: this file is not a merge layer, so `.strict()` here is free (a typo is a
 * loud error in three readers, not a bricked CLI).
 *
 * HAND-AUTHORABILITY IS THE CONSTRAINT THIS SHAPE IS CHOSEN FOR, and two earlier fields were dropped
 * for it — do not re-add either without re-deciding that:
 *
 *  - `version` is OPTIONAL (defaulted to 1) because a store typed by a human carries no version key,
 *    and a store the CLI refuses to read is a store the human cannot write.
 *  - `repoRoot` is GONE, and with it the refusal that compared it against the current checkout. That
 *    guard was real: the store directory is keyed on `path.basename(mainRepoRoot)`, so `~/work/api`
 *    and `~/oss/api` share ONE token directory and repo B could load (and then overwrite) repo A's
 *    credentials. It was removed anyway, knowingly: it also made the CLI refuse every hand-written
 *    store, which carries no such field. Hand-authorability wins; the basename-collision risk is
 *    ACCEPTED. A weakened version of the guard (warn-and-continue, or "only check when present") is
 *    NOT the compromise here — it would re-introduce the same refusal for anyone who did write the
 *    field. If you want the guard back, key the store directory on something collision-free instead.
 */
const tokenStoreSchema = z
  .object({
    version: z.literal(TOKEN_STORE_VERSION).default(TOKEN_STORE_VERSION),
    envs: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict()

/** The parsed `tokens.json` shape: `{ version, envs }` — `version` defaulted to 1 when absent on disk. */
export type TokenStore = z.infer<typeof tokenStoreSchema>

/**
 * Absolute path to the per-project token store: `~/.infra-kit/projects/<repo>/tokens.json`.
 *
 * Derived from {@link getInfraKitConfigPaths} rather than re-deriving the home/projects/repo chain —
 * that resolver already keys the directory off the MAIN repo root (so every worktree of a repo shares
 * one store) and memoizes the two `git rev-parse` spawns.
 *
 * @example
 * await getTokenStorePath() // => '/Users/arthur/.infra-kit/projects/infra-kit/tokens.json'
 */
export const getTokenStorePath = async (): Promise<string> => {
  const paths = await getInfraKitConfigPaths()

  return path.join(path.dirname(paths.userProject), TOKEN_STORE_FILE)
}

/**
 * Read the token store, or `null` when it does not exist.
 *
 * ABSENCE IS NOT AN ERROR — a fresh machine has no store, and every caller must be able to say "no
 * tokens yet" without a try/catch. The two things that DO throw are malformed JSON and a schema
 * mismatch: both are states only a human can fix, so both are loud.
 *
 * @example
 * const store = await readTokenStore()
 * store?.envs.dev // => 'dp.st.dev.xxxx' | undefined
 * // no file on disk  => null
 * // garbage on disk  => throws 'Invalid token store at ~/.infra-kit/projects/api/tokens.json: …'
 */
export const readTokenStore = async (): Promise<TokenStore | null> => {
  const storePath = await getTokenStorePath()

  let raw: string

  try {
    raw = await fs.readFile(storePath, 'utf-8')
  } catch {
    return null
  }

  // Every refusal below is an EnvAuthError, not a plain Error. A broken store is the MOST durable
  // env-auth failure there is — it cannot heal on a 30s retry, only a human can fix it — and env
  // auto-load's sticky marker is keyed on that CLASS. Thrown as a plain Error these were classified
  // TRANSIENT, so a corrupt store went silent on the backgrounded shell-startup spawn and the user's
  // env simply stopped loading with nothing ever said. `env` is null: no ONE environment is at fault.
  let parsedRaw: unknown

  try {
    parsedRaw = JSON.parse(raw)
  } catch (err) {
    throw new EnvAuthError(
      `Invalid JSON in the token store at ${tildify(storePath)}: ${(err as Error).message}\n` +
        `Fix or delete the file, then re-add the token with \`infra-kit env-token-set <env>\`.`,
    )
  }

  const result = tokenStoreSchema.safeParse(parsedRaw)

  if (!result.success) {
    throw new EnvAuthError(
      `Invalid token store at ${tildify(storePath)}: ${z.prettifyError(result.error)}\n` +
        `Fix or delete the file, then re-add the token with \`infra-kit env-token-set <env>\`.`,
    )
  }

  return result.data
}

/**
 * Persist the store atomically at 0600, tightening every directory on the way to it to 0700.
 *
 * The chmods are not belt-and-braces: the config bootstrap already seeds
 * `~/.infra-kit/projects/<repo>/` at the default umask (0755), so an EXISTING directory is
 * world-readable and `mkdir`'s mode argument is a no-op for it. The same holds for the file — a
 * hand-written `tokens.json` is 0644 — so the modes of the whole credential path are (re)asserted on
 * EVERY write, not only on the writes that created it. Self-healing by construction: a plain
 * `env-token-set` is enough to fix a store a human typed.
 *
 * @example
 * await writeTokenStore({ version: 1, envs: { dev: 'dp.st.dev.x' } })
 * // ~/.infra-kit/projects/api/tokens.json  -rw-------
 * // ~/.infra-kit/projects/api/             drwx------
 */
export const writeTokenStore = async (store: TokenStore): Promise<void> => {
  const storePath = await getTokenStorePath()

  const projectDir = path.dirname(storePath)
  const projectsDir = path.dirname(projectDir)
  const userConfigDir = path.dirname(projectsDir)

  for (const dir of [userConfigDir, projectsDir, projectDir]) {
    await fs.mkdir(dir, { recursive: true, mode: TOKEN_DIR_MODE })
    await fs.chmod(dir, TOKEN_DIR_MODE)
  }

  atomicWriteFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, TOKEN_FILE_MODE)

  // The rename above already lands a fresh 0600 inode, but the mode of a credential file is not a
  // thing to leave to the umask that happened to be in effect — assert it outright.
  await fs.chmod(storePath, TOKEN_FILE_MODE)
}

/**
 * Add or replace one environment's token, read-modify-write, stamping the current `version`. Inherits
 * {@link readTokenStore}'s refusals: a corrupt store is never silently overwritten.
 *
 * @example
 * await setToken('dev', 'dp.st.dev.xxxxxxxx')
 * // tokens.json => { version: 1, envs: { dev: 'dp.st.dev.xxxxxxxx' } }
 */
export const setToken = async (env: string, token: string): Promise<void> => {
  const existing = await readTokenStore()

  await writeTokenStore({
    version: TOKEN_STORE_VERSION,
    envs: { ...existing?.envs, [env]: token },
  })
}

/**
 * Drop one environment's token. A no-op when the store (or the key) is absent — removing something
 * that is not there is the state the caller asked for.
 *
 * Removing a token here does NOT revoke it in Doppler; callers say so.
 *
 * @example
 * await removeToken('dev')
 * // tokens.json => { version: 1, envs: {} }
 */
export const removeToken = async (env: string): Promise<void> => {
  const existing = await readTokenStore()

  if (!existing || !(env in existing.envs)) return

  const envs = { ...existing.envs }

  delete envs[env]

  await writeTokenStore({
    version: TOKEN_STORE_VERSION,
    envs,
  })
}
