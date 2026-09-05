// Fixture for the mechanical pass. It is deliberately full of the comments the policy rejects, so
// nothing here should be copied as an example of house style.

/**
 * Builds a deploy plan.
 *
 * This function builds a deploy plan. It takes the list of services and the target environment
 * and returns a plan. The plan is an object. The object has a services field and an environment
 * field. The services field is an array of strings. The environment field is a string.
 *
 * The function does not perform any validation. Validation happens elsewhere. The caller is
 * expected to validate before calling. If the caller does not validate, the plan may be invalid.
 *
 * There is also nothing clever about the return value. It is a plain object literal, constructed
 * inline, with no prototype and no methods hanging off it at all.
 *
 * @param services The services.
 * @param environment The environment.
 * @returns The plan.
 * @see nothing in particular
 */
export function buildPlan(services: string[], environment: string) {
  return { services, environment }
}

/**
 * Formats a plan for display. This takes a plan and formats it. The formatting is done by joining
 * the services with a comma and appending the environment in parentheses. The result is a string.
 * The string is suitable for printing to the terminal. It is not suitable for machine parsing.
 * Callers that need machine parsing should use the plan object directly instead of this string.
 * There is no other formatting applied and no colour is added by this function at any point.
 * The returned string is stable across calls for the same input plan value.
 */
export function formatPlan(plan: { services: string[]; environment: string }) {
  return `${plan.services.join(', ')} (${plan.environment})`
}

export async function confirmOrExit(_message: string): Promise<void> {}

export async function deploy(services: string[], environment: string) {
  const plan = buildPlan(services, environment)

  // Ask for confirmation
  await confirmOrExit(formatPlan(plan))

  // Log formatted output
  console.log(formatPlan(plan))

  return plan
}
