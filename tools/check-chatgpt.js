'use strict';
/**
 * Can Meeting Copilot reach ChatGPT through the Codex CLI, and how fast?
 *
 *   node tools/check-chatgpt.js
 */
const store = require('../src/main/store');
const { CodexEngine, codexStatus } = require('../src/main/codex');

function line() { console.log('  ' + '-'.repeat(66)); }

(async () => {
  console.log('');
  console.log('  Meeting Copilot - ChatGPT connection check');
  line();
  const s = store.getSettings().brain;
  const st = codexStatus(s.codexPath);
  if (!st.installed) {
    console.log('  The Codex CLI is not installed.');
    console.log('');
    console.log('  To use your ChatGPT subscription, run the install line again with');
    console.log('  ChatGPT chosen (README, "Pay for ChatGPT, not Claude?"), then press');
    console.log('  Sign in with ChatGPT in the dashboard.');
    console.log('');
    process.exit(1);
  }
  console.log('  Codex CLI  :', st.exe);
  console.log('  signed in  :', st.signedIn ? 'yes, with ChatGPT' : 'NO');
  line();
  if (!st.signedIn) {
    console.log('  Press  Sign in with ChatGPT  in the dashboard and finish in the browser.');
    console.log('');
    process.exit(1);
  }

  const e = new CodexEngine(s);
  e.setSystem('You help someone answer live in a meeting. Reply in one short spoken sentence.');
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    try {
      const text = await e.send('THEY JUST SAID: Can you start next week?\nWrite what my person should say back.');
      console.log(`  answer ${i + 1}: ${Date.now() - t0} ms  "${text.slice(0, 80)}"`);
    } catch (err) {
      console.log('  RESULT: cannot reach ChatGPT');
      console.log('  reason:', err.message);
      console.log('');
      process.exit(1);
    }
  }
  line();
  console.log('  RESULT: ChatGPT is working.');
  console.log('  Answers arrive whole rather than word by word, so they take a few');
  console.log('  seconds longer than Claude. Fine for prep and summaries; usable live.');
  console.log('');
})();
