'use strict';
/* Dashboard renderer: prep the brief before, watch the transcript during,
   read the summary after. */

const $ = (id) => document.getElementById(id);
const api = window.copilot;

let current = null;      // the meeting being edited
let listening = false;

// ---------------- tabs ----------------

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  };
}

function showErr(msg) { $('err').textContent = msg; $('err').classList.remove('hidden'); }
function hideErr() { $('err').classList.add('hidden'); }
function flash(el) { el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 1600); }

// ---------------- meeting list ----------------

async function refreshList() {
  const items = await api.listMeetings();
  const list = $('list');
  list.innerHTML = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.style.fontSize = '11.5px';
    d.textContent = 'No meetings yet.';
    list.appendChild(d);
    return;
  }
  for (const m of items) {
    const el = document.createElement('div');
    el.className = 'item' + (current && m.id === current.id ? ' on' : '');
    const b = document.createElement('b');
    b.textContent = m.title;
    const s = document.createElement('span');
    const when = new Date(m.createdAt);
    s.textContent = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${m.turns} turns`;
    el.append(b, s);
    el.onclick = () => load(m.id);
    list.appendChild(el);
  }
}

async function load(id) {
  current = await api.getMeeting(id);
  if (!current) return;
  const b = current.brief;
  $('title').value = b.title || '';
  $('kind').value = b.kind || 'client call';
  $('company').value = b.company || '';
  $('role').value = b.role || '';
  $('otherSide').value = b.otherSide || '';
  $('goal').value = b.goal || '';
  $('background').value = b.background || '';
  $('terms').value = (b.terms || []).join(', ');

  renderTranscript(current.transcript || []);
  renderSummary(current.summary);
  renderNotes(current.notes || []);
  refreshList();
}

$('newMeeting').onclick = async () => {
  current = await api.createMeeting();
  await load(current.id);
};

// ---------------- brief ----------------

function collectBrief() {
  if (!current) return null;
  current.brief = {
    ...current.brief,
    title: $('title').value.trim(),
    kind: $('kind').value,
    company: $('company').value.trim(),
    role: $('role').value.trim(),
    otherSide: $('otherSide').value.trim(),
    goal: $('goal').value.trim(),
    background: $('background').value.trim(),
    terms: $('terms').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  return current;
}

$('saveBrief').onclick = async () => {
  if (!collectBrief()) return;
  current = await api.saveMeeting(current);
  flash($('savedMsg'));
  refreshList();
};

// ---------------- prep questions ----------------

$('clarifyBtn').onclick = async () => {
  if (!collectBrief()) return;
  const btn = $('clarifyBtn');
  btn.disabled = true; btn.textContent = 'Thinking…';
  const r = await api.clarify(current.brief);
  btn.disabled = false; btn.textContent = 'Ask the AI what else it needs';

  if (!r || !r.ok) { showErr(r?.error || 'Could not reach the AI.'); return; }
  if (!r.questions.length) { showErr('The AI says the brief already covers what it needs.'); return; }

  const list = $('prepList');
  list.innerHTML = '';
  for (const q of r.questions) {
    const wrap = document.createElement('label');
    wrap.className = 'full';
    wrap.textContent = q;
    const ta = document.createElement('textarea');
    ta.rows = 2; ta.dataset.q = q; ta.placeholder = 'Your answer…';
    wrap.appendChild(ta);
    list.appendChild(wrap);
  }
  $('prep').classList.remove('hidden');
  hideErr();
};

$('prepSave').onclick = async () => {
  const answered = [...document.querySelectorAll('#prepList textarea')]
    .filter((t) => t.value.trim())
    .map((t) => `Q: ${t.dataset.q}\nA: ${t.value.trim()}`);
  if (!answered.length) { showErr('Nothing filled in yet.'); return; }

  const bg = $('background');
  const existing = bg.value.trim();
  bg.value = (existing ? existing + '\n\n' : '') + answered.join('\n\n');
  collectBrief();
  current = await api.saveMeeting(current);
  $('prep').classList.add('hidden');
  $('prepList').innerHTML = '';
  flash($('savedMsg'));
  hideErr();
};

// ---------------- notes ----------------

async function addNote() {
  const v = $('noteInput').value.trim();
  if (!v) return;
  $('noteInput').value = '';
  const ok = await api.addNote(v);
  if (!ok) { showErr('Notes attach to the meeting that is currently running.'); return; }
  current = await api.getMeeting(current.id);
  renderNotes(current.notes || []);
}
$('noteAdd').onclick = addNote;
$('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });

// ---------------- listening ----------------

/**
 * With almost nothing in the brief the app has no true facts to work from, and a
 * sales question like "have you done this before?" has no safe answer. On
 * 2026-08-31 a 159-character brief led to an invented credential and the client
 * ended the call. Warn before that happens, do not block.
 */
function briefIsThin() {
  const bg = $('background').value.trim();
  return bg.length < 400;
}

$('startBtn').onclick = async () => {
  hideErr();
  if (briefIsThin()) {
    const NL = String.fromCharCode(10);
    const chars = $('background').value.trim().length;
    const go = confirm([
      'Your prepared material is nearly empty (' + chars + ' characters).',
      '',
      'With nothing to draw on, the assistant can only speak in generalities, and it',
      'will refuse to claim any experience, results or prices you have not written',
      'down. If the client asks "have you done this before?", the honest answer',
      'will be no.',
      '',
      'Paste your real experience, past results, prices and prepared lines first.',
      '',
      'Start anyway?',
    ].join(NL));
    if (!go) { $('background').focus(); return; }
  }
  if (!current) current = await api.createMeeting();
  collectBrief();
  current = await api.saveMeeting(current);

  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Starting…';
  const r = await api.startListening(current.id);
  $('startBtn').disabled = false;
  $('startBtn').textContent = 'Start listening';
  if (!r || !r.ok) showErr(r?.error || 'Could not start listening.');
};

$('stopBtn').onclick = async () => {
  await api.stopListening();
};

function setLive(on) {
  listening = on;
  $('liveState').textContent = on ? 'listening' : 'idle';
  $('liveState').className = 'pill ' + (on ? 'live' : 'idle');
  $('startBtn').classList.toggle('hidden', on);
  $('stopBtn').classList.toggle('hidden', !on);
}

// ---------------- live feed ----------------

function renderTranscript(turns) {
  const f = $('liveFeed');
  f.innerHTML = '';
  for (const t of turns) appendTurn(t, false);
}

function appendTurn(t, scroll = true) {
  const el = document.createElement('div');
  el.className = 't ' + t.role;
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = t.role === 'them' ? 'THEM' : 'YOU';
  el.append(w, document.createTextNode(t.text));
  $('liveFeed').appendChild(el);
  if (scroll) $('tab-live').scrollTop = $('tab-live').scrollHeight;
}

function renderNotes(notes) {
  const n = $('notes');
  if (!notes.length) { n.className = 'hint'; n.textContent = 'No notes.'; return; }
  n.className = '';
  n.innerHTML = '';
  for (const x of notes) {
    const d = document.createElement('div');
    d.className = 't';
    d.textContent = '• ' + x.text;
    n.appendChild(d);
  }
}

function renderSummary(s) {
  const box = $('summary');
  if (!s) { box.className = 'hint'; box.textContent = 'No summary yet. Generate one after the meeting.'; return; }
  box.className = '';
  box.innerHTML = '';
  const add = (heading, body) => {
    if (!body || (Array.isArray(body) && !body.length)) return;
    const h = document.createElement('h3'); h.textContent = heading; box.appendChild(h);
    if (Array.isArray(body)) {
      for (const it of body) {
        const d = document.createElement('div'); d.className = 't';
        d.textContent = '• ' + (typeof it === 'string' ? it : `${it.who || ''}: ${it.what || ''}${it.due ? ' (' + it.due + ')' : ''}`);
        box.appendChild(d);
      }
    } else {
      const d = document.createElement('div'); d.className = 't'; d.textContent = body; box.appendChild(d);
    }
  };
  add('Summary', s.summary);
  add('Key points', s.keyPoints);
  add('Decisions', s.decisions);
  add('Action items', s.actionItems);
  add('Questions raised', s.questionsRaised);
  add('Suggested follow-up', s.followUp);
}

$('summariseBtn').onclick = async () => {
  if (!current) return;
  hideErr();
  $('summary').className = 'hint';
  $('summary').textContent = 'Generating…';
  const r = await api.summarise(current.id);          // works on any meeting, live or not
  if (!r || !r.ok) {
    $('summary').textContent = 'No summary yet.';
    showErr(r?.error || 'Could not generate a summary.');
    return;
  }
  current = await api.getMeeting(current.id);
  renderSummary(r.summary);
};

$('docxBtn').onclick = async () => {
  if (!current) return;
  const r = await api.exportDocx(current.id);
  if (r && r.ok) alert('Saved to:\n' + r.path);
  else showErr(r?.error || 'Export failed.');
};

// ---------------- settings ----------------

async function loadSettings() {
  const s = await api.getSettings();
  $('sModel').value = s.brain.model;
  $('sDeepModel').value = s.brain.deepModel || 'sonnet';
  $('sWords').value = s.brain.maxWords;
  $('sBackend').value = s.audio.backend;
  $('sWhisper').value = s.audio.final_model;
  $('sThreads').value = s.audio.cpu_threads;
  $('sKey').value = s.audio.cloud?.api_key || '';
  $('sAnthropicKey').value = s.brain.apiKey || '';
  $('sProvider').value = s.brain.provider || 'claude';
  $('sOpenaiModel').value = s.brain.openaiModel || 'gpt-4o-mini';
  $('sOpenaiKey').value = s.brain.openaiKey || '';
  $('sFallback').checked = s.brain.fallbackToOpenAI !== false;
  $('sAuto').checked = s.brain.autoAnswer;
  $('sSuggest').checked = s.brain.suggestions;
  $('sPartials').checked = s.audio.partials;
  $('sMe').checked = s.audio.listen_me;
  $('sEcho').checked = s.audio.echo_guard;
  $('sMock').checked = s.brain.mock;
}

$('saveSettings').onclick = async () => {
  await api.saveSettings({
    brain: {
      model: $('sModel').value,
      deepModel: $('sDeepModel').value,
      maxWords: parseInt($('sWords').value, 10) || 60,
      autoAnswer: $('sAuto').checked,
      suggestions: $('sSuggest').checked,
      mock: $('sMock').checked,
      apiKey: $('sAnthropicKey').value.trim(),
      provider: $('sProvider').value,
      openaiModel: $('sOpenaiModel').value,
      openaiKey: $('sOpenaiKey').value.trim(),
      fallbackToOpenAI: $('sFallback').checked,
    },
    audio: {
      backend: $('sBackend').value,
      final_model: $('sWhisper').value,
      partial_model: $('sWhisper').value === 'small.en' ? 'tiny.en' : $('sWhisper').value,
      cpu_threads: parseInt($('sThreads').value, 10) || 3,
      partials: $('sPartials').checked,
      listen_me: $('sMe').checked,
      echo_guard: $('sEcho').checked,
      cloud: { api_key: $('sKey').value.trim() },
    },
  });
  flash($('setMsg'));
};

// ---------------- audio devices ----------------

let deviceList = null;

function fillSelect(sel, items, chosen, labelKey) {
  sel.innerHTML = '';
  const sys = document.createElement('option');
  sys.value = '';
  sys.textContent = 'Same as system' + (labelKey ? ' (' + labelKey + ')' : '');
  sel.appendChild(sys);
  for (const d of items) {
    const o = document.createElement('option');
    o.value = d.name;
    o.textContent = d.name + (d.default ? '  • current default' : '');
    sel.appendChild(o);
  }
  sel.value = chosen || '';
}

async function loadDevices() {
  const box = $('dResult');
  const r = await api.listDevices();
  if (!r || !r.ok) {
    box.className = 'hint';
    box.textContent = 'Could not read your audio devices: ' + ((r && r.detail) || 'unknown error');
    return;
  }
  deviceList = r;
  const s = await api.getSettings();
  fillSelect($('dOutput'), r.outputs, s.audio.output_device, r.default_output);
  fillSelect($('dInput'), r.inputs, s.audio.input_device, r.default_input);
}

async function saveDevices() {
  await api.selectDevices({ input: $('dInput').value || null, output: $('dOutput').value || null });
  const box = $('dResult');
  box.className = 'hint';
  box.textContent = listening
    ? 'Saved. Switching the live audio over now…'
    : 'Saved. These are used the next time you start listening.';
}

$('dOutput').onchange = saveDevices;
$('dInput').onchange = saveDevices;
$('dRefresh').onclick = loadDevices;

function showTest(r, busyLabel) {
  const box = $('dResult');
  box.className = '';
  box.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'chk';
  const mark = document.createElement('span');
  mark.className = r.ok ? 'good' : 'fail';
  mark.textContent = r.ok ? '✓' : '✕';
  const txt = document.createElement('span');
  const bits = [r.detail];
  if (r.device) bits.push('(' + r.device + ')');
  if (typeof r.peak === 'number') bits.push('level ' + Math.round(r.peak * 100) + '%');
  txt.textContent = bits.join('  ');
  row.append(mark, txt);
  box.appendChild(row);
}

$('dTestSpeaker').onclick = async () => {
  const b = $('dTestSpeaker');
  b.disabled = true; b.textContent = 'Playing…';
  $('dResult').className = 'hint';
  $('dResult').textContent = 'Playing a chime and listening for it…';
  const r = await api.testSpeaker($('dOutput').value || null);
  b.disabled = false; b.textContent = 'Test speaker';
  showTest(r);
};

$('dTestMic').onclick = async () => {
  const b = $('dTestMic');
  b.disabled = true; b.textContent = 'Listening…';
  $('dResult').className = 'hint';
  $('dResult').textContent = 'Say something — recording for 4 seconds…';
  const r = await api.testMic({
    input: $('dInput').value || null,
    output: $('dOutput').value || null,
    seconds: 4,
    playback: $('dPlayback').checked,
  });
  b.disabled = false; b.textContent = 'Test mic';
  showTest(r);
};

// ---------------- phone companion ----------------

async function refreshCompanion() {
  const info = await api.companionInfo();
  $('cEnabled').checked = !!info.enabled;
  const box = $('cBox');
  box.innerHTML = '';

  if (!info.enabled) { box.className = 'hint'; box.textContent = 'Phone view is switched off.'; return; }
  if (!info.url) { box.className = 'hint'; box.textContent = 'Start listening and the link appears here.'; return; }

  box.className = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:16px;align-items:center;flex-wrap:wrap';

  if (info.qr) {
    const img = document.createElement('img');
    img.src = info.qr;
    img.width = 150; img.height = 150;
    img.style.cssText = 'border-radius:8px;background:#fff;padding:6px';
    wrap.appendChild(img);
  }

  const right = document.createElement('div');
  const a = document.createElement('div');
  a.textContent = info.url;
  a.style.cssText = 'font-size:13px;color:var(--accent);user-select:text;word-break:break-all;margin-bottom:6px';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.style.marginBottom = '0';
  hint.textContent = info.connected
    ? info.connected + ' phone connected. Keep the screen awake with the button on it.'
    : 'Scan with your phone camera, or type the link into its browser. Same WiFi.';
  right.append(a, hint);
  wrap.appendChild(right);
  box.appendChild(wrap);
}

$('cEnabled').onchange = async () => {
  await api.companionToggle($('cEnabled').checked);
  refreshCompanion();
};

api.on('companion', () => refreshCompanion());

// ---------------- doctor ----------------

async function runDoctor() {
  const box = $('doctor');
  box.className = 'hint';
  box.textContent = 'Checking…';
  const d = await api.doctor();
  box.className = '';
  box.innerHTML = '';
  const label = {
    python: 'Audio engine',
    contentProtection: 'Capture protection',
    capture: 'What viewers see',
    claude: 'AI brain',
  };
  const order = ['python', 'claude', 'contentProtection', 'capture'];
  for (const k of order) {
    const v = d[k];
    if (!v) continue;
    const row = document.createElement('div');
    row.className = 'chk';
    const b = document.createElement('b'); b.textContent = label[k] || k;
    const s = document.createElement('span'); s.className = v.ok ? 'good' : 'fail'; s.textContent = v.ok ? '✓' : '✕';
    const t = document.createElement('span'); t.textContent = v.detail;
    row.append(b, s, t);
    box.appendChild(row);
  }
}
$('doctorBtn').onclick = () => {
  document.querySelector('#tabs button[data-tab="settings"]').click();
  runDoctor();
};
$('folderBtn').onclick = () => api.openFolder();

// Recovery: the panel can end up dragged off-screen, or hidden by a hotkey.
$('resetOverlayBtn').onclick = async () => {
  await api.resetOverlay();
  showErr('Panel moved back to the top-right of your screen and made visible.');
  setTimeout(hideErr, 4000);
};

// ---------------- events ----------------

api.on('share', (s) => {
  if (s.mode === 'screen') {
    showErr('You are sharing your ENTIRE SCREEN. On some computers the panel shows there as a dark box, '
          + 'so it has been hidden. Share a window or a tab to get it back, or read the answers on your phone.');
  } else { hideErr(); }
});
api.on('share-hidden', (m) => { if (m && m.reason) showErr(m.reason); });
api.on('state', (s) => { setLive(s.listening); refreshCompanion(); if (s.authError) showErr('Claude is not signed in for this app. Open a terminal, run  claude , type  /login  inside it and finish in the browser, then restart Meeting Copilot.'); });
api.on('error', (e) => showErr(e.message || 'Error'));
api.on('turn', (t) => { appendTurn(t); if (current) (current.transcript = current.transcript || []).push(t); });
api.on('devices', (m) => { $('devices').textContent = m.loopback ? `hearing: ${m.loopback}   |   mic: ${m.mic || 'none'}` : 'No speaker loopback found.'; });
api.on('summary', (s) => renderSummary(s));
api.on('note', () => current && renderNotes(current.notes || []));

// ---------------- AI connection ----------------

const AI_NAMES = { claude: 'Claude', codex: 'ChatGPT', openai: 'OpenAI API' };
let aiWatch = null;

/** Show the connect card until an AI is signed in, and name the one in use. */
async function refreshAI() {
  let d;
  try { d = await api.aiStatus(); } catch { return null; }
  $('connect').classList.toggle('hidden', d.ready);
  $('aiUsing').innerHTML = d.ready ? `AI: <b>${AI_NAMES[d.use] || d.use}</b>` : 'AI: not connected';
  // Name the buttons after what is actually on this computer.
  $('signClaude').textContent = d.claude.installed ? 'Sign in with Claude' : 'Claude not installed';
  $('signClaude').disabled = !d.claude.installed;
  $('signChatgpt').textContent = d.chatgpt.installed ? 'Sign in with ChatGPT' : 'ChatGPT not installed';
  $('signChatgpt').disabled = !d.chatgpt.installed;
  return d;
}

async function startSignIn(which) {
  const r = await api.aiSignIn(which);
  if (!r.ok) { showErr(r.error); return; }
  $('connect').classList.add('waiting');
  $('connectMsg').textContent = 'Finish signing in in the browser window that just opened. This page will notice.';
  clearInterval(aiWatch);
  const started = Date.now();
  aiWatch = setInterval(async () => {
    const d = await refreshAI();
    const done = d && (which === 'claude' ? d.claude.signedIn : d.chatgpt.signedIn);
    if (done) {
      clearInterval(aiWatch);
      await api.aiUse(which === 'claude' ? 'claude' : 'codex');
      $('connect').classList.remove('waiting');
      await refreshAI();
      await loadSettings();
    } else if (Date.now() - started > 5 * 60 * 1000) {
      clearInterval(aiWatch);
      $('connect').classList.remove('waiting');
      $('connectMsg').textContent = 'The sign-in did not finish. Press the button to try again.';
    }
  }, 2500);
}

$('signClaude').onclick = () => startSignIn('claude');
$('signChatgpt').onclick = () => startSignIn('chatgpt');

// ---------------- boot ----------------

(async function boot() {
  await loadSettings();
  refreshAI();
  loadDevices();
  refreshCompanion();
  const items = await api.listMeetings();
  if (items.length) await load(items[0].id);
  else { current = await api.createMeeting(); await load(current.id); }
  const s = await api.state();
  setLive(s.listening);
})();
