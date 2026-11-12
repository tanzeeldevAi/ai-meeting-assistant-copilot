'use strict';
/*
 * Offline tests for the app's logic. No microphone, no speakers, no sign-in,
 * no network: everything that talks to the outside world is replaced by a
 * stand-in, so these run the same on a laptop and in CI on macOS and Windows.
 *
 *   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Brain, needsAnswer, buildSystem, parseJSON } = require('../src/main/brain');
const { TurnBuffer } = require('../src/main/turnbuffer');
const { CodexEngine, explain } = require('../src/main/codex');
const { OpenAIEngine } = require('../src/main/openai');

// ------------------------------------------------------------ a fake codex

/** A command-line tool that is really one of the scripts in test/fixtures/. */
function fakeCli(name, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-${name}-`));
  const script = path.join(__dirname, 'fixtures', fixture);
  if (process.platform === 'win32') {
    const p = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(p, `@"${process.execPath}" "${script}" %*\r\n`);
    return p;
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** A codex binary that is really test/fixtures/fake-codex.js. */
function fakeCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-codex-'));
  const script = path.join(__dirname, 'fixtures', 'fake-codex.js');
  if (process.platform === 'win32') {
    // A .cmd shim, exactly how npm installs the real one on Windows.
    const p = path.join(dir, 'codex.cmd');
    fs.writeFileSync(p, `@"${process.execPath}" "${script}" %*\r\n`);
    return p;
  }
  const p = path.join(dir, 'codex');
  fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** Collect a brain's events until `done` or `error` for request `id`. */
function settle(brain, id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deltas = [];
    const t = setTimeout(() => reject(new Error('no reply in time')), timeoutMs);
    const on = (kind) => (e) => {
      if (e.id !== id) return;
      if (kind === 'delta') { deltas.push(e.text); return; }
      clearTimeout(t);
      resolve({ kind, event: e, deltas });
    };
    brain.on('delta', on('delta'));
    brain.on('done', on('done'));
    brain.on('error', on('error'));
    brain.on('superseded', on('superseded'));
  });
}

// ----------------------------------------------------------- answer gate

test('a real question is answered, backchannel is not', () => {
  for (const q of [
    'How long would a project like this take you?',
    'What would this cost us per month',
    'Can you walk me through how you would handle the migration?',
    'So we have three stores and the stock never matches between them at the end of the month',
  ]) assert.equal(needsAnswer(q), true, q);
  for (const q of ['ok', 'yeah', 'mm-hmm', 'right right', 'sounds good', '']) {
    assert.equal(needsAnswer(q), false, q);
  }
});

// ----------------------------------------------------------- prompt

test('the system prompt carries the brief and the safety rules', () => {
  const s = buildSystem({
    company: 'Acme', goal: 'win the retainer',
    background: 'SAY\n"Our retainer is 2,000 a month."\nNOTE - DON\'T SAY\nOur floor is 1,400.',
  }, { maxWords: 90 });
  assert.match(s, /Acme/);
  assert.match(s, /2,000 a month/);
  assert.match(s, /90 words/);
  assert.match(s, /NEVER CLAIM EXPERIENCE/);
  assert.match(s, /never say aloud/i);
});

test('JSON is recovered from a fenced or chatty reply', () => {
  assert.deepEqual(parseJSON('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepEqual(parseJSON('Sure! Here you go: {"summary":"ok"} hope that helps'), { summary: 'ok' });
  assert.equal(parseJSON('no json here'), null);
});

// ----------------------------------------------------------- turn buffer

test('a finished question is released after a short pause, as one turn', async () => {
  let clock = 0;
  const flushed = [];
  const tb = new TurnBuffer({ now: () => clock, pollMs: 5, onFlush: (t, m) => flushed.push([t, m]) });
  tb.noteLevel(0.1);
  tb.push('How long would this take');
  tb.push('for all three stores?');
  clock += 300;                       // quiet for longer than readyMs (250)
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0][0], 'How long would this take for all three stores?');
  assert.equal(flushed[0][1].parts, 2);
  tb.reset();
});

test('half a sentence is held until they really stop', async () => {
  let clock = 0;
  const flushed = [];
  const tb = new TurnBuffer({ now: () => clock, pollMs: 5, onFlush: (t) => flushed.push(t) });
  tb.noteLevel(0.1);
  tb.push('So what we really need is');
  clock += 300;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(flushed.length, 0, 'a fragment must not be answered after 300 ms');
  clock += 1000;                      // past quietMs (1200)
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(flushed.length, 1);
  tb.reset();
});

// ----------------------------------------------------------- Codex (ChatGPT) engine

test('codex: the prompt goes in on stdin and the reply comes back', async () => {
  const e = new CodexEngine({ codexPath: fakeCodex() });
  assert.equal(e.configured, true);
  e.setSystem('SYSTEM');
  let deltas = 0;
  const reply = await e.send('hello', () => deltas++);
  assert.match(reply, /^heard \d+ characters$/);
  assert.equal(deltas, 1);
});

test('codex: a brief far past the Windows command-line limit still works', async () => {
  const e = new CodexEngine({ codexPath: fakeCodex() });
  const big = 'x'.repeat(60000);
  const reply = await e.send(big);
  const n = Number(reply.match(/\d+/)[0]);
  assert.ok(n > 60000, `only ${n} characters arrived`);
});

test('codex: a sign-in failure is explained in plain words', async () => {
  const e = new CodexEngine({ codexPath: fakeCodex() });
  await assert.rejects(e.send('FAIL_LOGIN'), /codex login/);
  assert.match(explain('429 usage limit reached'), /usage limit/);
});

test('codex: a newer question cancels the old one', async () => {
  const e = new CodexEngine({ codexPath: fakeCodex() });
  const slow = e.send('SLOW');
  setTimeout(() => e.abort(), 300);
  const t0 = Date.now();
  assert.equal(await slow, '');
  assert.ok(Date.now() - t0 < 4000, 'abort did not stop the process');
});

test('codex: a missing binary says how to install it', async () => {
  const e = new CodexEngine({ codexPath: '/nope/codex' });
  e.exe = null;
  assert.equal(e.configured, false);
  await assert.rejects(e.send('hi'), /install line again with ChatGPT/);
});

// ----------------------------------------------------------- OpenAI API engine

test('openai: no key, bad key and no credit each give a clear message', async () => {
  await assert.rejects(new OpenAIEngine({}).send('hi'), /No OpenAI API key/);
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
    await assert.rejects(new OpenAIEngine({ openaiKey: 'sk-test' }).send('hi'), /rejected the API key/);
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'insufficient_quota' });
    await assert.rejects(new OpenAIEngine({ openaiKey: 'sk-test' }).send('hi'), /rate limit or no credit/);
  } finally {
    globalThis.fetch = real;
  }
});

// ----------------------------------------------------------- the Brain

test('brain: offline demo mode answers end to end', async () => {
  const b = new Brain();
  await b.start({}, { mock: true });
  const id = b.answer('What would you do first?', []);
  const r = await settle(b, id);
  assert.equal(r.kind, 'done');
  assert.ok(r.event.text.length > 20);
  assert.ok(r.deltas.length > 1, 'demo mode should stream');
  await b.stop();
});

test('brain: ChatGPT as the main brain answers a question (used to crash)', async () => {
  const b = new Brain();
  const ok = await b.start({ company: 'Acme' }, { provider: 'codex', codexPath: fakeCodex() });
  assert.equal(ok, true);
  const id = b.answer('How long would a project like this take you?', [{ role: 'them', text: 'Hi' }]);
  const r = await settle(b, id);
  assert.equal(r.kind, 'done', JSON.stringify(r.event));
  assert.match(r.event.text, /heard \d+ characters/);
  // The brief travels with every request, since the engine keeps no session.
  assert.ok(Number(r.event.text.match(/\d+/)[0]) > 500);
  await b.stop();
});

test('brain: summary and typed questions work on ChatGPT too', async () => {
  const b = new Brain();
  await b.start({}, { provider: 'codex', codexPath: fakeCodex() });
  const id = b.ask('What should I say about pricing?', []);
  assert.equal((await settle(b, id)).kind, 'done');
  await b.stop();
});

test('brain: if Claude fails mid-meeting the backup answers instead (used to do nothing)', async () => {
  const b = new Brain();
  b.settings = { fallbackToOpenAI: true };
  b.provider = 'claude';
  b.backup = new CodexEngine({ codexPath: fakeCodex() });
  b.backup.setSystem('SYSTEM');
  const req = { id: 7, kind: 'answer', text: '', startedAt: Date.now(), userText: 'THEY JUST SAID: price?' };
  b._inflight.push(req);
  // A Claude session whose next result is an error, as on a rate limit.
  b.session = (async function* () {
    yield { type: 'result', is_error: true, result: 'Claude usage limit reached' };
  })();
  const status = [];
  b.on('status', (s) => status.push(s));
  const done = settle(b, 7);
  await b._pump();
  const r = await done;
  assert.equal(r.kind, 'done', JSON.stringify(r.event));
  assert.ok(status.some((s) => s.fallback === 'codex'), 'the switch to the backup should be reported');
});

test('brain: a failure in the second meeting is reported, not swallowed', async () => {
  const b = new Brain();
  await b.start({}, { mock: true });
  await b.stop();
  await b.start({}, { mock: true });
  assert.equal(b._stopping, false, 'stop() left the error-hiding flag raised');
  await b.stop();
});

// ----------------------------------------------------------- Word export

test('a meeting exports to a real .docx file', async () => {
  const { exportMeeting } = require('../src/main/docx');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docx-'));
  const cwd = process.cwd();
  process.chdir(dir);              // outside Electron the file lands in the working folder
  try {
    const r = await exportMeeting({
      id: 'test', createdAt: new Date().toISOString(),
      brief: { title: 'Discovery call', company: 'Brightside Bakery' },
      summary: { summary: 'Agreed a rebuild.', keyPoints: ['Three shops'], decisions: [],
        actionItems: [{ who: 'me', what: 'Send the proposal', due: 'Friday' }],
        questionsRaised: [], followUp: 'Thanks, Sam.' },
      notes: [{ text: 'Worried about downtime.' }],
      transcript: [{ role: 'them', text: 'How long would it take?' }, { role: 'me', text: 'Two weeks.' }],
    });
    assert.equal(r.ok, true, r.error);
    const head = Buffer.alloc(2);
    const fd = fs.openSync(r.path, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    assert.equal(head.toString(), 'PK', 'a .docx is a zip file');
  } finally {
    process.chdir(cwd);
  }
});

// ----------------------------------------------------------- which AI to use

test('ai: uses ChatGPT when Claude is chosen but only ChatGPT is signed in', () => {
  const ai = require('../src/main/ai');
  process.env.FAKE_CLAUDE_STATE = 'out';
  const d = ai.detect({ provider: 'claude', claudePath: fakeCli('claude', 'fake-claude.js'), codexPath: fakeCodex() });
  assert.equal(d.claude.installed, true);
  assert.equal(d.claude.signedIn, false);
  assert.equal(d.chatgpt.signedIn, true);
  assert.equal(d.use, 'codex');
  assert.equal(d.ready, true);
});

test('ai: stays on Claude when Claude is signed in', () => {
  const ai = require('../src/main/ai');
  process.env.FAKE_CLAUDE_STATE = 'in';
  const d = ai.detect({ provider: 'claude', claudePath: fakeCli('claude', 'fake-claude.js'), codexPath: fakeCodex() });
  assert.equal(d.use, 'claude');
  assert.equal(d.ready, true);
});

test('ai: nothing signed in means not ready, so the app shows Sign in', () => {
  const ai = require('../src/main/ai');
  process.env.FAKE_CLAUDE_STATE = 'out';
  process.env.FAKE_CODEX_STATE = 'out';
  try {
    const d = ai.detect({ provider: 'claude', claudePath: fakeCli('claude', 'fake-claude.js'), codexPath: fakeCodex() });
    assert.equal(d.chatgpt.signedIn, false);
    assert.equal(d.ready, false);
  } finally {
    delete process.env.FAKE_CODEX_STATE;
  }
});

test('ai: the Sign in button starts the CLI sign-in', async () => {
  const ai = require('../src/main/ai');
  const mark = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mark-')), 'called');
  process.env.FAKE_CLAUDE_MARK = mark;
  const r = ai.signIn('claude', { claudePath: fakeCli('claude', 'fake-claude.js') });
  assert.equal(r.ok, true);
  for (let i = 0; i < 50 && !fs.existsSync(mark); i++) await new Promise((x) => setTimeout(x, 100));
  assert.equal(fs.readFileSync(mark, 'utf8'), 'auth login --claudeai');
});

test('ai: only ChatGPT installed means the app offers ChatGPT', () => {
  const ai = require('../src/main/ai');
  process.env.FAKE_CODEX_STATE = 'out';
  try {
    const d = ai.detect({ provider: 'claude', claudePath: '/nope/claude', codexPath: fakeCodex() });
    // findClaude may still find a real Claude on a developer's computer.
    if (!d.claude.installed) assert.equal(d.use, 'codex');
    assert.equal(d.ready, false);
  } finally {
    delete process.env.FAKE_CODEX_STATE;
  }
});

test("codex: the installer's own Node and Codex come first on the CLI's PATH", () => {
  const { codexEnv } = require('../src/main/codex');
  const exe = path.join(os.tmpdir(), 'somewhere', process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const parts = codexEnv(exe).PATH.split(path.delimiter);
  const rt = path.join(__dirname, '..', '.runtime');
  assert.equal(parts[0], path.dirname(exe));
  const node = process.platform === 'win32' ? path.join(rt, 'node') : path.join(rt, 'node', 'bin');
  assert.ok(parts.indexOf(node) > 0 && parts.indexOf(node) < 4, 'own Node is near the front');
});
