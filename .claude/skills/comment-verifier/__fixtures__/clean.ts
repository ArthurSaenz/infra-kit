/** Compact why-comments only. The mechanical pass must report nothing here. */

export type Plan = { services: string[]; environment: string }

/** Kept sorted so two runs over the same set produce the same cache key. */
export function normalizeServices(services: string[]): string[] {
  return [...services].sort()
}

export function planFor(services: string[], environment: string): Plan {
  return { services: normalizeServices(services), environment }
}

export function renderPlan(plan: Plan): string {
  // The CI log viewer collapses tabs, so the separator has to be a literal space.
  return `${plan.services.join(' ')} ${plan.environment}`
}
