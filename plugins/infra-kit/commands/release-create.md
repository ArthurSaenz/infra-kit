---
name: release-create
description: Cut one or more release branches through the infra-kit MCP server.
argument-hint: [--hotfix] [--desc <text>] [<version|next|name>]
---

Read the MCP resource `infra-kit://workflow/release-create` and follow it exactly, treating $ARGUMENTS as the release the user asked for.
If that resource cannot be read — this session may expose no resource tools, or the server may predate it: it needs infra-kit 0.5.0 or newer — call the `mcp__infra-kit__release-create` tool directly and let its confirm gate drive the rest.
If the infra-kit MCP server is not connected in this session, say so and stop — do not improvise with git or gh.
