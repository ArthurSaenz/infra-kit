#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -qE 'pnpm dev|pnpm run dev'; then
  if ! echo "$COMMAND" | grep -q 'cmux'; then
    echo "Dev servers must run in cmux. Use: cmux new-session -d -s dev \"pnpm dev\"" >&2
    exit 2
  fi
fi

exit 0
