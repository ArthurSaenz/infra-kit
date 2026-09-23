import { $ } from 'zx'

/**
 * Run git in `cwd` and return stdout untrimmed, because `-z` output ends in a NUL that a trim would keep but a
 * parser must see. `input` feeds stdin for `--pathspec-from-file=-`.
 */
export const runGit = async (cwd: string, args: string[], input?: string): Promise<string> => {
  const result = await $({ cwd, quiet: true, input })`git ${args}`

  return result.stdout
}

/** Split `-z` output into records, dropping the empty tail after the final NUL. */
export const splitNul = (stdout: string): string[] => {
  return stdout.split('\0').filter((record) => {
    return record.length > 0
  })
}
