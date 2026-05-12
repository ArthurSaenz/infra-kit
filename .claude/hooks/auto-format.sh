#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.scss|*.mjs|*.cjs)
    pnpm exec prettier --log-level silent --write "$FILE_PATH" 2>/dev/null
    ;;
esac

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx)
    pnpm exec eslint --quiet --fix "$FILE_PATH" 2>/dev/null
    ;;
esac

exit 0
