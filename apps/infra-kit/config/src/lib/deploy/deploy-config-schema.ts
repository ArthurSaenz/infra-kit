import { z } from 'zod'

/**
 * Pure (node-free) schema for a consumer repo's deploy manifest. `infra-kit deploy-sync` reads it and
 * generates the repo's deploy workflows from it, so CI runs plain YAML and never needs the CLI.
 *
 * A separate file rather than a `deploy` key in `infra-kit.json` / `infra-kit.config.ts`: both of those
 * are strict schemas parsed by every installed CLI and by the vite plugin, so a new key would break
 * every teammate and CI build still on an older release. Nothing but `deploy-sync` reads this file.
 */
export const DEPLOY_CONFIG_FILE = 'infra-kit.deploy.ts'

/** Environment and service names end up in job ids, input keys and secret names. */
const kebabName = z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be lower-case kebab-case, e.g. client-be')

/** A reusable workflow in the consumer's own `.github/workflows/`, by file name. */
const localWorkflowFile = z
  .string()
  .regex(/^[\w.-]+\.ya?ml$/, 'must be a workflow file name in .github/workflows, e.g. _deploy-media-jobs.yml')

const secretName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an upper-case secret name, e.g. MONITORING_IP')

/** Service names become dispatch inputs, so they must not shadow the ones every workflow has. */
const RESERVED_SERVICE_NAMES = new Set(['environment'])

export const deployServiceSchema = z.strictObject({
  /** The only environments this service deploys to. Omitted = every environment. */
  envs: z.array(kebabName).nonempty().optional(),
  /** Environments this service never deploys to; every other one is allowed. Exclusive with `envs`. */
  skipEnvs: z.array(kebabName).nonempty().optional(),
  /** GitHub runner label. Omitted = the shared job's default (`ubuntu-24.04-arm`). */
  runner: z
    .string()
    .regex(/^[\w.-]+$/, 'must be a runner label, e.g. macos-14')
    .optional(),
  /**
   * Deploy through this repo's own reusable workflow instead of `devops/scripts/deploy-<service>.sh`
   * in the shared job. It is called with `branch` and `environment` inputs and `secrets: inherit`.
   */
  workflow: localWorkflowFile.optional(),
  /**
   * The service's TypeScript deploy, run by `infra-kit deploy-run`, as a repo-relative path; put it in
   * the app it deploys (`apps/client/api/deploy.ts`) and it defaults to that app. Omitted =
   * `devops/scripts/deploy-<service>.sh`.
   */
  deploy: z
    .string()
    .regex(/^(?!.*\.\.)[\w./-]+\.ts$/, 'must be a repo-relative .ts path, e.g. apps/client/api/deploy.ts')
    .optional(),
  /**
   * `false` leaves the service out of the deploy-all workflow; a list keeps it in deploy-all for those
   * environments only, e.g. `['prod']`. Either way it stays selectable wherever it may deploy.
   */
  deployAll: z.union([z.boolean(), z.array(kebabName).nonempty()]).optional(),
})

export const deployConfigSchema = z
  .strictObject({
    /** The environments the generated workflows offer, in dispatch-menu order. */
    environments: z.array(kebabName).nonempty(),
    /** Preselected in the dispatch menu. Omitted = the first environment. */
    defaultEnvironment: kebabName.optional(),
    /** Every deployable service, keyed by its `devops/scripts/deploy-<name>.sh` suffix, in menu order. */
    services: z.record(kebabName, deployServiceSchema),
    /** Reusable workflows applied before any service deploys; skippable per run. */
    terraform: z.array(localWorkflowFile).optional(),
    /**
     * Reusable workflows run after terraform (applied or skipped) and before any service, e.g. publishing
     * a Lambda layer the services resolve at deploy time. Not skipped with terraform; a failure stops every service.
     */
    preDeploy: z.array(localWorkflowFile).optional(),
    /** Reusable workflow called once every deploy job finished without a failure. */
    notifySuccess: localWorkflowFile.optional(),
    /** Repo secrets exported, under the same name, to every deploy script. */
    extraEnv: z.array(secretName).optional(),
    /**
     * Minutes the deploy step of the shared job may run. Omitted = the shared job's default, 25. A
     * timed-out step fails and keeps its logs, where a job cancelled at GitHub's 360-minute cap loses them.
     */
    deployTimeoutMinutes: z.number().int().min(1).max(360).optional(),
    /**
     * Generate under the v1 names, `deploy-all.yml` and `deploy-selected-services.yml`, replacing the
     * hand-written files. Those are the files `infra-kit release deploy-*` dispatches, so the manifest
     * becomes what the CLI deploys and reads its service gates from. Omitted = the `-v2` pilot files,
     * which the CLI ignores. A repo that delivers prod needs `prod` in `environments` first: delivery
     * dispatches `deploy-all.yml` with it.
     */
    replaceV1: z.boolean().optional(),
  })
  .superRefine((config, ctx) => {
    if (Object.keys(config.services).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['services'], message: 'declare at least one service' })
    }

    for (const [name, service] of Object.entries(config.services)) {
      if (RESERVED_SERVICE_NAMES.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['services', name], message: 'is a dispatch input of its own' })
      }

      if (service.workflow !== undefined && service.deploy !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['services', name], message: 'set workflow or deploy, not both' })
      }

      if (service.envs !== undefined && service.skipEnvs !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['services', name], message: 'set envs or skipEnvs, not both' })
      }
    }

    for (const [index, file] of (config.preDeploy ?? []).entries()) {
      if (config.terraform?.includes(file)) {
        ctx.addIssue({ code: 'custom', path: ['preDeploy', index], message: 'already listed under terraform' })
      }
    }

    if (config.defaultEnvironment !== undefined && !config.environments.includes(config.defaultEnvironment)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultEnvironment'],
        message: `must be one of environments (${config.environments.join(', ')})`,
      })
    }
  })

export type DeployService = z.infer<typeof deployServiceSchema>
export type DeployConfig = z.infer<typeof deployConfigSchema>

/**
 * Identity helper for authoring a type-safe `infra-kit.deploy.ts`.
 *
 * A manifest can equally use `import type { DeployConfig }` with `satisfies DeployConfig`: the type
 * import is erased when the CLI loads the file, so it keeps working against an older installed
 * `@slip-stream-kit/config` that predates this helper.
 *
 * @example
 * export default defineDeployConfig({
 *   environments: ['dev', 'stage'],
 *   services: { 'client-be': {}, 'client-fe': { runner: 'macos-14' } },
 * })
 */
export const defineDeployConfig = (config: DeployConfig): DeployConfig => {
  return config
}
