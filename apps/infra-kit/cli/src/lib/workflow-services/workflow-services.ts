import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'

/** Where GitHub keeps dispatchable workflows. The only place we look for service declarations. */
const WORKFLOWS_DIR = '.github/workflows'

/**
 * A `workflow_dispatch` boolean that is a flag, not a service — the one exclusion from the list.
 *
 * Named here rather than at the call site because the exclusion is a property of the WORKFLOW's
 * input vocabulary, not of whoever is reading it: both readers (the command's validation and the
 * argument form's picker) must drop exactly the same key or the form offers a "service" the command
 * then refuses as invalid.
 */
const SKIP_TERRAFORM_INPUT = 'skip_terraform_deploy'

/**
 * The services a workflow can deploy: its `workflow_dispatch` boolean inputs, minus the flags that
 * are not services.
 *
 * Returns `[]` rather than throwing when the workflow is missing or unreadable — callers turn that
 * into a sentence (the command) or into "no form" (the argument-form provider). Previously an absent
 * file (bridge has no `deploy-selected-services.yml`) escaped as a raw `ENOENT` from `fs.readFile`,
 * and a workflow with no `workflow_dispatch` as a `TypeError` on `parsed.on.workflow_dispatch`.
 *
 * @example
 * await parseServicesFromWorkflow('/repo', 'deploy-selected-services.yml') // => ['client-be', 'client-fe']
 * await parseServicesFromWorkflow('/repo', 'absent.yml')                   // => []
 */
// Extracted out of `gh-release-deploy-selected.ts`, where it was module-private, for the same reason
// `workflow-gates.ts` was extracted: the argument-form provider needs the identical list, and the
// provider is wired INTO that command's tool definition. Importing it back from the command would
// close a cycle (`command → lib/deploy-form → command`), and re-deriving it would put a second YAML
// reader in the tree, free to drift from the validation the command performs on what the form
// returns — the form would offer a name the handler then calls invalid.
export const parseServicesFromWorkflow = async (projectRoot: string, workflowFile: string): Promise<string[]> => {
  const workflowPath = path.resolve(projectRoot, WORKFLOWS_DIR, workflowFile)

  let parsed: unknown

  try {
    parsed = yaml.parse(await fs.readFile(workflowPath, 'utf-8'))
  } catch {
    return []
  }

  const on = (parsed as { on?: unknown } | null)?.on
  const inputs = (on as { workflow_dispatch?: { inputs?: unknown } } | undefined)?.workflow_dispatch?.inputs

  if (typeof inputs !== 'object' || inputs === null) return []

  return Object.entries(inputs)
    .filter(([key, value]) => {
      return (value as { type?: string } | null)?.type === 'boolean' && key !== SKIP_TERRAFORM_INPUT
    })
    .map(([key]) => {
      return key
    })
}
