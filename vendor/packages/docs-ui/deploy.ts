import type { DeployScript } from '@slip-stream-kit/config'
import fs from 'node:fs/promises'

// docs-fe: run by `infra-kit deploy-run docs-fe` in every consumer, so it reads its SSM parameters
// under the manifest's `project` instead of naming the repo. The manifest gates the environments.
const BUILD_DIR = 'vendor/packages/docs-ui/.output/public'

export default (async ({ project, ssm, run, aws, retry }) => {
  if (project === undefined) throw new Error('set `project` in infra-kit.deploy.ts: docs-fe reads /<project>/… SSM')

  const bucketParameter = `/${project}/s3/docs/bucket_name`
  const distributionParameter = `/${project}/cloudfront/docs/id`
  const parameters = await ssm([bucketParameter, distributionParameter])

  // Full checkout, never a prune: the docs aggregate MDX from the whole monorepo (src/lib/docs-aggregation.ts).
  await run('pnpm', ['install', '--frozen-lockfile'])
  await run('pnpm', ['exec', 'turbo', 'build', '--filter=@wl/docs-ui', '--env-mode=loose'])

  // The SPA shell becomes index.html; without it every route would 404.
  await fs.copyFile(`${BUILD_DIR}/_shell.html`, `${BUILD_DIR}/index.html`).catch(() => {
    throw new Error(`${BUILD_DIR}/_shell.html not found — SPA shell missing, aborting deploy`)
  })

  await aws([
    's3',
    'sync',
    BUILD_DIR,
    `s3://${parameters[bucketParameter]}`,
    '--delete',
    '--cache-control',
    'max-age=900',
    '--only-show-errors',
  ])
  await retry('Invalidate CloudFront', () => {
    return aws([
      'cloudfront',
      'create-invalidation',
      '--distribution-id',
      parameters[distributionParameter]!,
      '--paths',
      '/*',
    ])
  })
}) satisfies DeployScript
