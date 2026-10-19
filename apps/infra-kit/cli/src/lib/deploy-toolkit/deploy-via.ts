/**
 * Set by `local deploy-*` on the scripts it spawns. It has already run its own gates (the AWS account
 * matches the environment, prod refused, the human confirmed), so an agent's run that reaches
 * `deploy-run` through it is not a raw deploy.
 */
export const DEPLOY_VIA_LOCAL_DEPLOY = 'local-deploy'
