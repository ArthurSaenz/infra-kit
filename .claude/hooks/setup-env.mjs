#!/usr/bin/env node
//
// SessionStart hook — currently a no-op. To export env vars into the session, append shell lines
// to the file named by CLAUDE_ENV_FILE, e.g.:
//
//   import { appendFileSync } from 'node:fs';
//   const envFile = process.env.CLAUDE_ENV_FILE;
//   if (envFile) {
//     appendFileSync(envFile, 'export NODE_ENV=development\n');
//     appendFileSync(envFile, 'export PATH="$PATH:./node_modules/.bin"\n');
//   }

process.exit(0);
