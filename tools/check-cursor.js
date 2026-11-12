'use strict';
/**
 * Is the Cursor Agent CLI installed and signed in? How fast does a tiny
 * ask-mode prompt come back?
 *
 *   node tools/check-cursor.js
 */
const { cursorStatus, findAgent, CursorEngine } = require('../src/main/cursor');

async function main() {
  const exe = findAgent();
  console.log('Cursor CLI:', exe || '(not found)');
  if (!exe) {
    console.log('Install: https://cursor.com/docs/cli/overview');
    console.log('Then run: agent login');
    process.exit(1);
  }

  const st = cursorStatus(exe);
  console.log('Signed in:', st.signedIn ? 'yes' : 'no');
  if (st.detail) console.log('Status:', st.detail.split('\n')[0]);
  if (!st.signedIn) {
    console.log('Fix: run  agent login  and finish in the browser.');
    process.exit(1);
  }

  const engine = new CursorEngine({ cursorPath: exe });
  engine.setSystem('You are a speed check. Reply with exactly one word.');
  const t0 = Date.now();
  try {
    const text = await engine.send('Reply with exactly: ready', null, { timeoutMs: 90000 });
    console.log('Reply:', JSON.stringify(text));
    console.log('Latency:', (Date.now() - t0) + ' ms');
  } catch (e) {
    console.log('Request failed:', e.message || e);
    process.exit(1);
  }
}

main();
