import { $ } from 'zx'

export interface RunGitOptions {
  /** Fed to stdin, for `--pathspec-from-file=-`. */
  input?: string
  /** Return `''` on a non-zero exit instead of throwing, for probes where failure is an answer. */
  allowFailure?: boolean
}

/**
 * Run git in `cwd` and return stdout untrimmed, because `-z` output ends in a NUL that a trim would keep but a
 * parser must see.
 */
export const runGit = async (cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> => {
  const { input, allowFailure = false } = options
  const result = await $({ cwd, quiet: true, input, nothrow: allowFailure })`git ${args}`

  return result.exitCode === 0 ? result.stdout : ''
}

/** @example shortSha('a1b2c3d4e5') // => 'a1b2c3d' */
export const shortSha = (sha: string): string => {
  return sha.slice(0, 7)
}

/** Split `-z` output into records, dropping the empty tail after the final NUL. */
export const splitNul = (stdout: string): string[] => {
  return stdout.split('\0').filter((record) => {
    return record.length > 0
  })
}
