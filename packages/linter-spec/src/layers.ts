import type { LayerModel, SegmentModel } from '#root/types'

/**
 * Derive whether `from` may depend on `to` under a model's ordered layers +
 * `direction`, honouring same-order policy and explicit exceptions. Pure data
 * projection — this is how the hand-authored O(n²) matrix is avoided.
 */
export function isDependencyAllowed(model: LayerModel, from: string, to: string): boolean {
  const exception = model.exceptions?.find((rule) => {
    return rule.from === from && rule.to === to
  })

  if (exception) {
    return exception.allowed
  }

  const fromLayer = model.layers.find((layer) => {
    return layer.name === from
  })
  const toLayer = model.layers.find((layer) => {
    return layer.name === to
  })

  if (!fromLayer || !toLayer) {
    return false
  }

  if (fromLayer.order === toLayer.order) {
    return model.allowSameOrder ?? false
  }

  // `direction: 'downward'` — a layer may depend only on lower-order layers.
  return fromLayer.order < toLayer.order
}

/**
 * GENERIC backend template. Classic onion: the controller (outermost) may reach
 * inward to service → repository → domain (innermost); inner layers never reach
 * out. Portable — contains no project-specific names.
 */
export const backendLayerModel: LayerModel = {
  id: 'generic-backend',
  title: 'Generic backend layers',
  description: 'Controller → service → repository → domain. Dependencies point inward only.',
  generic: true,
  direction: 'downward',
  allowSameOrder: false,
  layers: [
    { name: 'controller', order: 0, description: 'HTTP/transport entrypoints; orchestrates services.' },
    { name: 'service', order: 1, description: 'Use-case/business logic; coordinates repositories.' },
    { name: 'repository', order: 2, description: 'Persistence access; hides storage details.' },
    { name: 'domain', order: 3, description: 'Pure domain entities/value objects; no outward deps.' },
  ],
}

/**
 * GENERIC frontend template. `app` composes `feature`s; both may use `shared`
 * and `ui`; features never import each other (no same-order edges). Portable.
 */
export const frontendSegmentModel: SegmentModel = {
  id: 'generic-frontend',
  title: 'Generic frontend segments',
  description: 'App → feature → shared → ui. Sideways feature-to-feature imports are forbidden.',
  generic: true,
  direction: 'downward',
  allowSameOrder: false,
  layers: [
    { name: 'app', order: 0, description: 'Composition root; wires features and routing.' },
    { name: 'feature', order: 1, description: 'Self-contained feature; imported only via its public API.' },
    { name: 'shared', order: 2, description: 'Cross-feature utilities/hooks; depends only on ui.' },
    { name: 'ui', order: 3, description: 'Presentational primitives; no outward deps.' },
  ],
}

/**
 * CONCRETE, non-generic instance: infra-kit's own CLI structure, used to
 * exercise the model against a real codebase. NOT portable.
 *
 * `apps/infra-kit/cli/src/`: entry → commands → integrations/mcp → lib.
 */
export const infraKitSegmentModel: SegmentModel = {
  id: 'infra-kit-cli',
  title: 'infra-kit CLI layers (concrete instance)',
  description: 'entry → commands → integrations → lib. A real-world instance, not a portable template.',
  generic: false,
  direction: 'downward',
  allowSameOrder: false,
  layers: [
    { name: 'entry', order: 0, description: 'CLI/MCP entrypoints (entry/, mcp/); parse args, dispatch.' },
    { name: 'commands', order: 1, description: 'One folder per command; orchestrates lib + integrations.' },
    { name: 'integrations', order: 2, description: 'Adapters to external systems (cmux, gh, etc.).' },
    { name: 'lib', order: 3, description: 'Pure reusable utilities; the innermost layer.' },
  ],
}

/** All generic layer/segment templates. */
export const layerModels: readonly LayerModel[] = [backendLayerModel, frontendSegmentModel]

/** Every model, generic templates plus concrete instances. */
export const segmentModels: readonly SegmentModel[] = [backendLayerModel, frontendSegmentModel, infraKitSegmentModel]
