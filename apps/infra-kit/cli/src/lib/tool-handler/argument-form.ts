import { acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/server'
import type { InputRequiredResult } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { withDeadline } from 'src/lib/deadline'
import type { ArgumentFormProvider } from 'src/types'

/**
 * @fileoverview
 *
 * The argument-form half of the MCP chokepoint: build the form, read what came back, and refuse
 * anything that came back narrower than it went out.
 *
 * Every function here is TOTAL. The form path runs on two things the handler does not control — a
 * provider written by someone else, and content the client sent back — and the SDK validates
 * neither ("treat them as untrusted input", `«d.mts»:1406`, `:1500`, `:2114`). A throw escaping
 * from here would leave the chokepoint's catch returning a TOOL ERROR on a call that was owed a
 * confirm gate, which is the failure this module exists to prevent. So every provider call and
 * every SDK call below is wrapped, and every failure mode — rejection, deadline, `null`, a thrown
 * `TypeError` — reads as the same single answer: `null`, meaning "no form; fall to the gate".
 */

/**
 * The identifier the form is registered under in `inputRequests`, and the key the client's reply
 * comes back under in `ctx.mcpReq.inputResponses`. One key, one form, one round trip.
 */
// Module-private on purpose. Both sides of the round trip are in this file — `buildArgumentForm`
// registers under it, `readFormAction` and `readAcceptedArgs` read back under it — so the key is an
// internal convention, not a contract anyone outside gets to depend on. Exporting it would invite a
// caller to reach into `inputResponses` themselves and re-derive an action without the totality the
// functions below are built to guarantee.
const FORM_KEY = 'args'

/**
 * How long the chokepoint waits for a provider to produce a schema.
 *
 * A provider may reach the network (the release provider runs `git ls-remote` and a Jira fetch),
 * and those are `Promise.allSettled`-wrapped inside it — so they never FAIL, they only take as long
 * as they take. Without a ceiling a slow remote or an SSH key prompt turns `tools/call` into a call
 * that returns nothing at all: no form, no gate, no error. The deadline converts that into today's
 * behaviour instead.
 */
export const FORM_DEADLINE_MS = 3_000

/**
 * The action a retried request carried for the form, with every non-elicitation response kind
 * folded into `missing`.
 *
 * `inputResponse` is documented TOTAL — a malformed or absent entry reads as `{kind:'missing'}` —
 * and that is also where a key the SDK DROPPED lands: a dropped entry is removed from
 * `inputResponses` and only its name is kept in `droppedInputResponseKeys`, so it reaches us as an
 * absent key. That is why nothing here reads `droppedInputResponseKeys`: the drop is already
 * covered, as a `missing` that is not an accept.
 */
export type FormAction = 'accept' | 'decline' | 'cancel' | 'missing'

/**
 * Read the form's action out of a retried request's responses.
 *
 * `InputResponseView` is a union and `action` exists only on its `kind:'elicit'` member, so the
 * narrowing is load-bearing rather than cosmetic.
 *
 * @example
 * readFormAction({ args: { action: 'decline' } }) // => 'decline'
 * readFormAction(undefined)                       // => 'missing'
 */
export const readFormAction = (responses: Record<string, unknown> | undefined): FormAction => {
  const view = inputResponse(responses, FORM_KEY)

  return view.kind === 'elicit' ? view.action : 'missing'
}

/**
 * The provider's schema for these arguments, or `null` on ANY failure: a rejection, a deadline
 * overrun, a synchronous throw before the promise is even returned, or the provider's own `null`.
 *
 * Called on BOTH rounds. Round 1 needs it to build the form; round 2 needs a schema to validate what
 * came back («d.mts»:1406), and the round-2 `params` are the round-1 arguments the client echoed
 * back, so re-asking the provider reproduces it.
 */
// The REBUILD on round 2 is deliberate, and it is not free. The two rounds are two separate
// `tools/call` requests — round 2 is a re-entry, discriminated by `responses !== undefined` — so this
// runs at most once per request and never twice within one. Across an accepted form that is two
// builds, and for a provider that reaches the network (the release provider runs `git ls-remote` and
// a Jira fetch) four calls where a single build would cost two. Both alternatives are worse.
//
// Reusing round 1's schema is not "threading a value through": nothing in this chokepoint survives a
// request. The gate is stateless BY CONSTRUCTION — round 2 is trusted because it returns an HMAC the
// server minted, not because the server remembered anything — so a reused schema needs either a
// keyed server-side cache with its own eviction, or transport through the client. The second hands
// the client the validator that is the ONLY thing checking the content it just sent. The first
// re-introduces on a long-lived process exactly the per-request state `confirm-token.ts` was built
// to avoid, to save two network calls per human decision.
//
// The rebuild does mean round 2 validates against a MOVED world: a choice that was legal when the
// human made it can fail now, and they lose it. That is the correct direction to fail. A provider
// enumerates candidates precisely because the current world constrains them — the release provider
// lists the versions that already exist so a cut cannot collide — so honouring a stale selection
// executes the collision the enumeration was there to prevent. The loss is not silent either: it
// lands on the `formDiscarded` gate, which names the discard in a field AND in prose. Telling a
// drift-caused failure apart from ordinary invalid content would need round 1's schema to compare
// against, which is the cross-request state above — bought to reword a message, not to change an
// outcome. `f14` in the tests pins the drifted round trip.
const trySchema = async (
  provider: ArgumentFormProvider,
  params: unknown,
  deadlineMs: number,
): Promise<z.ZodObject<z.ZodRawShape> | null> => {
  try {
    return await withDeadline(provider.buildRequestedSchema(params), deadlineMs)
  } catch {
    return null
  }
}

/**
 * The form to send, or `null` meaning "offer no form; fall to the gate".
 *
 * The `elicit()` call is wrapped for a documented reason, not defensively: a Standard Schema it
 * cannot express as the restricted wire shape throws a `TypeError` BEFORE anything is sent
 * («d.mts»:1404-1407) — a nested object property is enough — and a provider can arm that without
 * writing anything the type system objects to.
 *
 * @example
 * await buildArgumentForm(provider, { releases: [] }, 3000)
 * // => { resultType: 'input_required', inputRequests: { args: { method: 'elicitation/create', … } } }
 */
export const buildArgumentForm = async (
  provider: ArgumentFormProvider,
  params: unknown,
  deadlineMs: number,
): Promise<InputRequiredResult | null> => {
  const schema = await trySchema(provider, params, deadlineMs)

  if (schema === null) return null

  try {
    return inputRequired({
      inputRequests: {
        [FORM_KEY]: inputRequired.elicit({ message: provider.message, requestedSchema: schema }),
      },
    })
  } catch {
    return null
  }
}

/**
 * The accepted form content, VALIDATED and merged over the round-1 arguments — or `null` when it
 * cannot be trusted, which the caller reads as "gate with the round-1 arguments".
 *
 * Three untrusted steps, each wrapped: the provider's schema, the SDK's schema-aware validation of
 * the content, and the provider's own merge.
 */
// `acceptedContent`'s schema-aware overload is used because nothing between the client and here has
// checked the content. It throws a `TypeError` on an asynchronously validating schema
// («d.mts»:1468-1470), and `z.ZodObject<z.ZodRawShape>` freely permits `.refine(async …)` — so the
// wrap is the enforcement of a contract the types cannot express. It returns `undefined` both for
// "not an accept" and for "failed validation"; the caller has already discriminated the action, so
// here `undefined` means only the latter. `toArgs` is the one member called on client-supplied
// input: its contract says it never throws, and the wrap is what makes that true rather than promised.
export const readAcceptedArgs = async (
  provider: ArgumentFormProvider,
  params: unknown,
  responses: Record<string, unknown> | undefined,
  deadlineMs: number,
): Promise<Record<string, unknown> | null> => {
  const schema = await trySchema(provider, params, deadlineMs)

  if (schema === null) return null

  let content: Record<string, unknown> | undefined

  try {
    content = acceptedContent(responses, FORM_KEY, schema) as Record<string, unknown> | undefined
  } catch {
    return null
  }

  if (content === undefined) return null

  try {
    return provider.toArgs(content, params)
  } catch {
    return null
  }
}

/** A plain object — not an array, not `null`, not a primitive. */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * True when `after` removed a top-level key of `before`, or CHANGED the length of one of its
 * arrays. The chokepoint refuses such a merge and gates on the round-1 arguments instead.
 *
 * Both array directions are violations, and the growth half is the silent one: an injected entry
 * the caller never supplied stays schema-valid and EXECUTES. Deliberately TOP-LEVEL ONLY — nested
 * removal and equal-shape substitution are OUT of scope and are guarded only by the provider's merge.
 *
 * @example
 * narrowsArgs({ releases: [1, 2] }, { releases: [1] })    // => true  (truncated)
 * narrowsArgs({ releases: [1] }, { releases: [1, 2] })    // => true  (grown)
 * narrowsArgs({ a: 1, b: 2 }, { a: 9, b: 2 })             // => false (substitution is the feature)
 */
// A form narrows a CHOICE; it never withdraws or invents an item the caller listed. So the length
// rule is a ceiling rather than a heuristic — no legitimate provider, present or future, needs it
// relaxed, and one that trips it is wrong by construction. The depth limit is the opposite kind of
// decision: a recursive walk would forbid a human blanking an optional field they no longer want,
// and nothing generic separates "the human cleared this" from "the provider dropped this".
export const narrowsArgs = (before: unknown, after: unknown): boolean => {
  if (!isRecord(before)) return false
  // `before` is a record and `after` is not: EVERY argument was narrowed away.
  if (!isRecord(after)) return true

  for (const [key, value] of Object.entries(before)) {
    if (!(key in after)) return true

    const replacement = after[key]

    if (Array.isArray(value) && (!Array.isArray(replacement) || replacement.length !== value.length)) return true
  }

  return false
}
