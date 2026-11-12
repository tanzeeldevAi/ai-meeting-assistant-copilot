#!/usr/bin/env node
'use strict';
/*
 * Stands in for the Claude CLI in tests. `auth status --json` reports the
 * state named by FAKE_CLAUDE_STATE (in | out); `auth login` records that it
 * was called by writing FAKE_CLAUDE_MARK, so a test can see the button worked.
 */
const fs = require('fs');
const args = process.argv.slice(2).join(' ');
if (args === 'auth status --json') {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_STATE === 'in', authMethod: 'none' }) + '\n');
} else if (args === 'auth login --claudeai') {
  if (process.env.FAKE_CLAUDE_MARK) fs.writeFileSync(process.env.FAKE_CLAUDE_MARK, args);
} else {
  process.exit(2);
}
