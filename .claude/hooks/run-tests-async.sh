#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run tests for source files
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.tsx && "$FILE_PATH" != *.js && "$FILE_PATH" != *.jsx ]]; then
  exit 0
fi

# If the file is a test file, run it directly
if [[ "$FILE_PATH" == *.test.ts || "$FILE_PATH" == *.test.tsx ]]; then
  RESULT=$(pnpm exec vitest run "$FILE_PATH" 2>&1)
else
  # Run only tests related to the changed source file
  RESULT=$(pnpm exec vitest related "$FILE_PATH" --run 2>&1)
fi
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "{\"systemMessage\": \"Tests passed after editing $FILE_PATH\"}"
else
  echo "{\"systemMessage\": \"Tests failed after editing $FILE_PATH: $RESULT\"}"
fi

exit 0
