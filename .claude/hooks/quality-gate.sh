#!/bin/bash
INPUT=$(cat)
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject')

cd "$CLAUDE_PROJECT_DIR" || exit 1

if ! pnpm run qa 2>&1; then
  echo "QA checks not passing (prettier, eslint, typecheck, or tests). Fix before completing: $TASK_SUBJECT" >&2
  exit 2
fi

exit 0
