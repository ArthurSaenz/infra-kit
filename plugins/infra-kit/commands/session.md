---
name: session
description: Switch this terminal's context — load a named environment through the infra-kit MCP server.
argument-hint: [--clear] [<environment>]
---

Read the MCP resource `infra-kit://workflow/session` and follow it exactly, treating $ARGUMENTS as the environment and flags the user asked for.
If that resource cannot be read — this session may expose no resource tools, or the server may predate it: it needs infra-kit 0.5.2 or newer — call `mcp__infra-kit__env-list` to see the environments, ask the user which one, and load the Doppler environment with `mcp__infra-kit__env-load`.
If the infra-kit MCP server is not connected in this session, say so and stop — do not improvise with the doppler CLI or by exporting variables in Bash.
