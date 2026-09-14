# What `inputRequired.elicit()` accepts — measured

Measured 2026-09-09 against `@modelcontextprotocol/server@2.0.0`, resolved from
`apps/infra-kit/cli` (pnpm store path
`.../@modelcontextprotocol/server/2.0.0/.../dist/index.cjs`). The probe called
`inputRequired({ inputRequests: { args: inputRequired.elicit({ message, requestedSchema }) } })`
and read back the rendered `requestedSchema`.

These are facts about the SDK, not about infra-kit. They decide the shape of every
`ArgumentFormProvider.buildRequestedSchema` (`src/types.ts:43`), so they are recorded rather than
left to be re-derived.

## Results

| Input shape | Outcome | Rendered / message |
|---|---|---|
| `z.enum(['dev','stage','arthur'])` | **OK** | `{"type":"string","enum":["dev","stage","arthur"]}` |
| `z.array(z.enum(['client-be','client-fe']))` | **OK** | `{"type":"array","items":{"type":"string","enum":[...]}}` |
| `z.array(z.string())` | **THROW** | `TypeError: Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): properties.services` |
| `z.object({ version: z.enum([...]), env: z.enum([...]) })` | **OK** | both properties render |
| `z.enum(['dev']).optional()` | **OK** | renders; omitted from `required` |
| `z.object({ a: z.object({ b: z.string() }) })` | **THROW** | same `TypeError`, `properties.a` |
| `z.enum([])` | **THROW** | same `TypeError`, `properties.env` |
| `z.array(z.enum([]))` | **THROW** | same `TypeError`, `properties.s` |
| `z.enum(['dev']).describe('the target env')` | **OK** | `{"type":"string","description":"the target env","enum":["dev"]}` |
| `z.object({})` | **OK** | `{}`, `required` undefined |

## The four consequences that bind the design

**1. A multi-select is possible, but only as `z.array(z.enum(...))`.** The obvious spelling —
`z.array(z.string())`, which is what `gh-release-deploy-selected`'s own `inputSchema` declares for
`services` — throws. So a services picker is buildable, and the enum is mandatory.

**2. Every throw here degrades SILENTLY to "no form".** `buildArgumentForm` wraps the `elicit()` call
and returns `null` on any throw (`src/lib/tool-handler/argument-form.ts:163-170`), and the handler
reads `null` as "offer no form; fall to the gate". So a provider built with `z.array(z.string())`, or
with a nested object, produces exactly the same observable behaviour as a provider that correctly
decided it had nothing to offer. Any test asserting only "the gate came back" passes against both.
Distinguishing them requires asserting the form was *offered*, not that the gate was *reached*.

**3. An empty candidate list throws, so it must be refused before it is built.** `z.enum([])` is not
an empty dropdown — it is a `TypeError`, caught and flattened into the same silent `null`. A provider
must return `null` explicitly when its enumeration is empty, so that "nothing to offer" is a decision
with a reason rather than a swallowed error. This is not hypothetical at this repo root: neither
`deploy-all.yml` nor `deploy-selected-services.yml` exists here, so `readWorkflowEnvOptions` and
`parseServicesFromWorkflow` both return `[]`.

**4. There are no per-option labels.** Enum members are bare strings on the wire. `.describe()`
attaches at the *field* level only. So a dropdown cannot mark `stage` as shared while leaving
`arthur` unmarked — any per-option annotation has to be encoded into the enum *value* and mapped back
in `toArgs`, which puts a parse step on the authorization-critical path and interacts with
`narrowsArgs`. Any mitigation phrased as "option labels carry the environment's kind" is not
implementable as stated.

## Companion measurement — an unguarded prompt corrupts the stream, it does not hang

Measured the same day, same package. `@inquirer/confirm` invoked with **stdin from `/dev/null` and
stdout redirected to a file** — no TTY on either side:

```
stdout: 54 bytes   ? Open created worktrees in GitHub Desktop? (Y/n)^[[51G
stderr: 0 bytes
```

**The byte count is not a constant, and no assertion should treat it as one.** It is the rendered
message plus an ANSI cursor-position escape, so it tracks the prompt's text: this `worktrees-add`
message measures 54, while `local-deploy`'s *"? Deploy 1 service(s) to arthur from this machine?
(y/N)"* measures 61 under the same conditions. Assert **zero bytes**, which is the actual invariant;
the counts here are evidence that the write happens, not a value to pin.

**Piping does not suppress the write.** Inquirer writes the prompt and an ANSI cursor-position escape
to **stdout**, and under MCP stdio stdout *is* the JSON-RPC channel. So every unguarded `withEscape`
prompt reachable on an MCP path emits protocol garbage into the transport — a parse error or a
desynchronised session, not a hang and not a silent no-op.

This refutes the reasoning that such a defect "will not reproduce under Claude Code because it pipes
stdio". Piping removes the TTY; it does not remove the write. Any pre-mortem or test that assumes a
non-TTY environment is therefore safe is assuming something measurably false — and a manual check
that comes back green under Claude Code proves nothing about it.

## Reproducing

The probe is five lines and must run from inside `apps/infra-kit/cli` — resolving
`@modelcontextprotocol/server` from a scratch directory fails with `ERR_MODULE_NOT_FOUND`.

```js
import { inputRequired } from '@modelcontextprotocol/server'
import { z } from 'zod'

try {
  const r = inputRequired({
    inputRequests: { args: inputRequired.elicit({ message: 'm', requestedSchema: SHAPE }) },
  })
  console.log(JSON.stringify(r.inputRequests.args.params?.requestedSchema))
} catch (e) {
  console.log(`${e.constructor.name}: ${e.message}`)
}
```

## Addendum 2026-09-15 — per-option labels ARE expressible, through a raw JSON schema

Measured against `@modelcontextprotocol/server` 2.0.0 / zod 4.6.2 (V0.2 of
`docs/session-env-picker-plan.md`). Consequence 4 above holds for every ZOD spelling, but not for the
wire's own titled-enum form:

| Input shape | Outcome | Rendered |
|---|---|---|
| `z.union([z.literal('dev').describe('…'), z.literal('stage').describe('…')])` | **THROW** | same flat-primitives `TypeError`, `properties.config` |
| `z.enum(['dev','stage']).meta({ title: 'Environment' })` | OK | `title` at the FIELD level only |
| raw `{ type:'string', oneOf:[{const:'dev', title:'dev — token set'}, …] }` | **OK** | `oneOf` with per-option `title` survives verbatim |
| raw `{ type:'string', enum:[…], enumNames:[…] }` | OK | passes through, but `enumNames` is not in the MCP spec — do not rely on it |
| `fromJsonSchema(raw oneOf)` → `elicit()` → `acceptedContent(responses, key, schema)` | **OK** | the same standard schema validates the re-entry: `{config:'dev'}` → content, `{config:'nope'}` → `undefined` |

So a per-option annotation is buildable as a `TitledSingleSelectEnumSchema` (`oneOf` `const`+`title`,
spec 2025-06-18+) via `fromJsonSchema`, and it validates on round 2. Two things it does NOT settle:
`ArgumentFormProvider.buildRequestedSchema` is typed `z.ZodObject<z.ZodRawShape>` (a `fromJsonSchema`
result is a Standard Schema, not a `ZodObject`), and whether Claude Code RENDERS the `title` is unmeasured
(the 2025-11-25 form dialog may show the `const`). The env picker keeps the token annotation in the
field's `description` (§2.3 of the plan); the titled enum is a follow-up gated on a live render check.
