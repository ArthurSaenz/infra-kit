import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { discoverServices, resolveSsmPrefix } from '../service-discovery'

/**
 * The refusal paths of `resolveSsmPrefix`, each in its own repo.
 *
 * Separate tmp dirs rather than one shared fixture because every case here is a repo that is
 * WRONG in a different way, and a shared dir would need every other case's scripts removed first.
 * The happy path lives in `service-discovery.test.ts`, on the fixture that mirrors the consumers.
 */
const repos: string[] = []

const SSM_READ = (name: string): string => {
  return `DEPLOY_STAGE=$(aws ssm get-parameter --name ${name} --query 'Parameter.Value' --output text)\n`
}

const repoWith = async (scripts: Record<string, string>): Promise<string> => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-ssm-prefix-'))

  repos.push(repo)

  await fs.mkdir(path.join(repo, 'devops/scripts'), { recursive: true })

  for (const [file, body] of Object.entries(scripts)) {
    await fs.writeFile(path.join(repo, 'devops/scripts', file), `#!/bin/bash\n${body}`, 'utf-8')
  }

  return repo
}

const resolveIn = async (repo: string): Promise<string> => {
  return resolveSsmPrefix(await discoverServices(repo))
}

afterAll(async () => {
  await Promise.all(
    repos.map((repo) => {
      return fs.rm(repo, { recursive: true, force: true })
    }),
  )
})

describe('resolveSsmPrefix', () => {
  it('refuses when no script reads the environment parameter, counting the scripts it looked at', async () => {
    const repo = await repoWith({
      'deploy-a.sh': 'echo a\n',
      'deploy-b.sh': SSM_READ('"/hulyo/api_gateway/website/restId"'),
    })

    await expect(resolveIn(repo)).rejects.toThrow(/none of 2 deploy scripts reads/)
  })

  it('refuses when the scripts disagree, naming every prefix and the scripts behind each', async () => {
    const repo = await repoWith({
      'deploy-a.sh': SSM_READ('"/hulyo/environment"'),
      'deploy-b.sh': SSM_READ('"/travelist/environment"'),
    })

    const failure = await resolveIn(repo).catch((error: unknown) => {
      return error as Error
    })

    expect(failure).toBeInstanceOf(Error)

    const { message } = failure as Error

    expect(message).toContain('hulyo')
    expect(message).toContain('travelist')
    expect(message).toContain('deploy-a.sh')
    expect(message).toContain('deploy-b.sh')
  })

  // Both forms DO read the environment parameter — through shell the parser cannot evaluate — so
  // neither may degrade to "no script reads it": the refusal has to point at the line.
  it.each([
    // Shell syntax on purpose — the `${…}` is what the script would write, not a missed template.
    // eslint-disable-next-line no-template-curly-in-string
    ['an expansion inside the path', 'PROJECT=hulyo\n', '"/${PROJECT}/environment"'],
    ['a bare variable holding the whole name', 'PARAM=/x/environment\n', '"$PARAM"'],
  ])('refuses %s, naming script:line and asking for a literal', async (_label, prelude, name) => {
    const repo = await repoWith({ 'deploy-x.sh': `${prelude}${SSM_READ(name)}` })

    // Line 1 is the shebang, line 2 the prelude, line 3 the read.
    await expect(resolveIn(repo)).rejects.toThrow(/deploy-x\.sh:3\b/)
    await expect(resolveIn(repo)).rejects.toThrow(/literal/)
  })
})
