#!/usr/bin/env node
'use strict';
/*
 * Stands in for the Cursor CLI (`agent`) in tests. Accepts the same flags the
 * real engine passes and prints a plain-text answer on stdout.
 *
 * Behaviour is chosen by a marker in the prompt:
 *   FAIL_LOGIN  -> exit 1 with a not-authenticated message
 *   SLOW        -> waits 5 s before answering
 *   anything    -> answers "heard <n> characters"
 */
const args = process.argv.slice(2);

if (args[0] === 'status') {
  if (process.env.FAKE_AGENT_STATE === 'out') {
    if (args.includes('--format') && args.includes('json')) {
      process.stdout.write(JSON.stringify({ authenticated: false }) + '\n');
    } else {
      process.stdout.write('Not logged in\n');
    }
    process.exit(1);
  }
  if (args.includes('--format') && args.includes('json')) {
    process.stdout.write(JSON.stringify({ authenticated: true, user: { email: 'test@example.com' } }) + '\n');
  } else {
    process.stdout.write('Logged in as test@example.com\n');
  }
  process.exit(0);
}

if (args[0] === 'login') {
  if (process.env.FAKE_AGENT_MARK) {
    require('fs').writeFileSync(process.env.FAKE_AGENT_MARK, 'login');
  }
  process.exit(0);
}

// Print-mode request: find the prompt (last non-flag-looking arg, or the
// first arg that is not a known option value).
const flagsWithValue = new Set([
  '--output-format', '--mode', '--model', '--workspace', '--api-key',
  '--sandbox', '--header', '-H',
]);
let prompt = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-p' || a === '--print' || a === '--trust' || a === '--force' || a === '--yolo') continue;
  if (flagsWithValue.has(a)) { i += 1; continue; }
  if (a.startsWith('-')) continue;
  prompt = a; // last wins; the engine puts the prompt last
}

if (!args.includes('-p') && !args.includes('--print')) {
  process.stderr.write('expected: -p / --print\n');
  process.exit(1);
}

if (!args.includes('--mode=ask') && !(args.includes('--mode') && args.includes('ask'))) {
  process.stderr.write('expected: --mode=ask\n');
  process.exit(1);
}

// If the engine fell back to a prompt file, load it so length checks still work.
const fs = require('fs');
const path = require('path');
const fileRef = prompt.match(/file named (\S+\.txt)/i);
if (fileRef) {
  const wsIdx = args.indexOf('--workspace');
  const ws = wsIdx >= 0 ? args[wsIdx + 1] : process.cwd();
  try { prompt = fs.readFileSync(path.join(ws, fileRef[1]), 'utf8'); } catch { /* keep short prompt */ }
}

if (prompt.includes('FAIL_LOGIN')) {
  process.stderr.write('Error: Not authenticated. Run agent login.\n');
  process.exit(1);
}

const answer = () => {
  process.stdout.write(`heard ${prompt.length} characters`);
  process.exit(0);
};
if (prompt.includes('SLOW')) setTimeout(answer, 5000);
else answer();
