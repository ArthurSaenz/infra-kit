---
name: release-create
description: Cut one or more release branches through the infra-kit MCP server.
argument-hint: [--hotfix] [--desc <text>] [<version|next|name>]
---

Read the MCP resource `infra-kit://workflow/release-create` and follow it exactly, treating $ARGUMENTS as the release the user asked for.
If that resource cannot be read — this session may expose no resource tools, or the server may predate it: it needs infra-kit 0.5.0 or newer — call `mcp__plugin_infra-kit_infra-kit__release-create` directly — or `mcp__infra-kit__release-create` if this repo's `.mcp.json` still registers the server; if neither exists the plugin predates 0.7.7 — say so and stop — and let its confirm gate drive the rest.
If the infra-kit MCP server is not connected in this session, say so and stop — do not improvise with git or gh.
