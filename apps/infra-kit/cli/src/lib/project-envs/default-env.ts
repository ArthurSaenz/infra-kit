import { getInfraKitConfig } from 'src/lib/infra-kit-config'

/**
 * The environment `env-load` takes when none is named: the merged `defaultEnv` (the per-project
 * override wins over the user-global file, which wins over the committed one), or `null` when no
 * layer sets it.
 *
 * NEVER THROWS. An unreadable or rejected config resolves to `null`, so the caller falls back to
 * asking instead of failing on a preference.
 *
 * @example
 * await readDefaultEnv() // ~/.infra-kit/projects/api/infra-kit.json holds { "defaultEnv": "roman" } => 'roman'
 * await readDefaultEnv() // no layer sets it => null
 */
export const readDefaultEnv = async (): Promise<string | null> => {
  try {
    return (await getInfraKitConfig()).defaultEnv ?? null
  } catch {
    return null
  }
}
