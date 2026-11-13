'use strict';
/* Overlay renderer. No framework on purpose: this window has to repaint while
   a video call is fighting it for a 2-core CPU, so every millisecond of render
   work is one the meeting does not get. */

const $ = (id) => document.getElementById(id);

const dot = $('dot'), statusEl = $('status'), banner = $('banner');
const feed = $('feed'), answer = $('answer'), answerMeta = $('answerMeta');
const suggests = $('suggests'), askInput = $('ask'), opacityEl = $('opacity');
const mThem = $('mThem'), mMe = $('mMe');

let liveLine = null;        // the in-progress "partial" bubble
let activeAnswer = null;    // id of the answer currently streaming
let activeSuggest = null;   // tracked separately: a suggestion must never
                            // hijack or clear the answer the user is reading
let answerStarted = 0;
let answerUserScrolled = false;   // he took control of the answer's scroll
const MAX_LINES = 60;

// ---------------- helpers ----------------

function setStatus(text, cls) {
  statusEl.textContent = text;
  if (cls) dot.className = 'dot ' + cls;
}

function showBanner(msg, kind) {
  banner.textContent = msg;
  banner.className = kind === 'warn' ? 'warn' : '';
  banner.classList.remove('hidden');
}
function hideBanner() { banner.classList.add('hidden'); }

function addLine(role, text, isLive) {
  const el = document.createElement('div');
  el.className = 'line ' + role + (isLive ? ' live' : '');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = role === 'them' ? 'THEM' : 'YOU';
  el.appendChild(who);
  el.appendChild(document.createTextNode(text));
  feed.appendChild(el);
  while (feed.children.length > MAX_LINES) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
  return el;
}

function level(el, v) {
  // Speech RMS lives around 0.005-0.15; log scale makes it actually readable.
  const pct = v <= 0.0008 ? 0 : Math.min(100, Math.max(0, (Math.log10(v / 0.0008) / Math.log10(180)) * 100));
  el.style.width = pct.toFixed(0) + '%';
}

// ---------------- events from main ----------------

const on = window.copilot.on;

on('state', (s) => {
  if (s.authError) {
    showBanner('Claude is not signed in. In a terminal run  claude , type  /login , then restart.');
  } else if (s.mock) {
    showBanner('Offline demo mode - answers are canned, not from the AI.', 'warn');
  }
  if (s.listening) setStatus('listening', 'live');
  else setStatus('idle', 'idle');
  document.getElementById('through').classList.toggle('on', !!s.clickThrough);
  if (s.opacity) opacityEl.value = Math.round(s.opacity * 100);
});

on('status', (m) => {
  if (m.stage === 'loading_models') setStatus('loading speech model…', 'busy');
  if (m.stage === 'models_ready') { setStatus('listening', 'live'); hideBanner(); }
  if (m.stage === 'rebuilding_audio') setStatus('audio device changed…', 'busy');
  if (m.stage === 'paused') setStatus('paused', 'idle');
  if (m.stage === 'resumed') setStatus('listening', 'live');
  if (m.stage === 'keepalive_failed') showBanner('Could not keep the speaker stream awake; the first word of a sentence may be clipped.', 'warn');
});

on('devices', (m) => {
  if (!m.loopback) showBanner('No speaker loopback found - the other person cannot be heard. Check your output device.');
  else if (/hears both sides/.test(m.loopback)) {
    // A Mac older than macOS 13: the mic hears the room, the call included.
    showBanner('Listening through the microphone. Use your speakers, not headphones, so it hears the other person.', 'warn');
    statusEl.title = `hearing: ${m.loopback}`;
  } else statusEl.title = `hearing: ${m.loopback}\nmic: ${m.mic || 'none'}`;
});

on('level', (m) => { level(mThem, m.them || 0); level(mMe, m.me || 0); });

on('lag', () => setStatus('catching up…', 'busy'));

on('error', (e) => showBanner(e.message || 'Something went wrong.'));

on('partial', (m) => {
  if (m.role !== 'them') return;
  if (liveLine) liveLine.remove();
  liveLine = addLine('them', m.text, true);
});

on('turn', (t) => {
  if (liveLine) { liveLine.remove(); liveLine = null; }
  addLine(t.role, t.text, false);
});

// They are mid-flow: sentences are being held so one answer covers the whole
// thought, instead of the panel rewriting itself every few seconds.
on('still-talking', (m) => {
  if (activeAnswer) return;                     // an answer is streaming; leave it alone
  const n = (m && m.held) || 0;
  answerMeta.textContent = n > 1 ? `still talking… (${n} sentences held)` : 'still talking…';
  setStatus('they are still talking', 'busy');
});

on('interim-answer', () => {
  answerMeta.textContent = 'partial - they are still going';
});

on('share', (s) => {
  if (s && s.mode === 'screen') {
    showBanner('You are sharing your WHOLE SCREEN - the panel would show as a grey box, so it hides itself. '
             + 'Share a window or a tab, or read answers on your phone.');
  } else if (s && s.sharing) {
    hideBanner();
  }
});

on('no-answer-needed', () => {
  if (!activeAnswer) answerMeta.textContent = 'no reply needed';
});

on('answer:start', (s) => {
  // Suggestions run in the background and must NEVER disturb the answer panel.
  // (They used to clear it, so a suggestion arriving right after an answer wiped
  // the words the user was still reading off the screen.)
  if (s.kind === 'suggest') {
    activeSuggest = s.id;
    suggests.classList.add('loading');
    return;
  }

  activeAnswer = s.id;
  answerStarted = Date.now();
  answerUserScrolled = false;      // a new answer is read from its first word
  answer.scrollTop = 0;
  answer.textContent = '';
  answer.classList.remove('empty');
  answer.classList.add('thinking');
  answerMeta.textContent = 'thinking…';
  setStatus('answering', 'busy');
});

on('answer:delta', (d) => {
  if (d.id !== activeAnswer) return;
  if (d.kind === 'suggest') return;              // rendered whole, on completion
  if (answerMeta.textContent === 'thinking…') {
    answerMeta.textContent = ((Date.now() - answerStarted) / 1000).toFixed(1) + 's';
  }
  answer.textContent = d.full;
  // Deliberately NOT scrolled to the bottom. This is read ALOUD, starting at the
  // first word, and the prompt puts the direct answer in the first sentence.
  // Following the newest text meant a long answer opened mid-sentence and he had
  // to scroll UP to find the beginning. Stay at the top unless he moves it.
  if (!answerUserScrolled) answer.scrollTop = 0;
});

// If he scrolls the answer himself, stop repositioning it under him.
answer.addEventListener('wheel', () => { answerUserScrolled = true; }, { passive: true });
answer.addEventListener('mousedown', () => { answerUserScrolled = true; });

on('answer:superseded', (s) => {
  if (s.id === activeAnswer) answerMeta.textContent = 'superseded';
});

on('answer:done', (d) => {
  if (d.kind === 'suggest') {
    if (d.id !== activeSuggest) return;
    activeSuggest = null;
    suggests.classList.remove('loading');
    const items = d.text.split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 4);
    suggests.innerHTML = '';
    if (!items.length) { suggests.classList.add('hidden'); return; }
    for (const q of items) {
      const c = document.createElement('div');
      c.className = 'chip';
      c.textContent = q;
      c.title = 'Click to copy';
      c.onclick = () => navigator.clipboard && navigator.clipboard.writeText(q);
      suggests.appendChild(c);
    }
    suggests.classList.remove('hidden');
    return;
  }

  if (d.id !== activeAnswer) return;
  answer.classList.remove('thinking');
  setStatus('listening', 'live');

  if (d.skipped) {
    answer.textContent = 'Nothing to answer there.';
    answer.classList.add('empty');
    answerMeta.textContent = '';
  } else {
    answer.textContent = d.text;
    answerMeta.textContent = (d.ms / 1000).toFixed(1) + 's';
  }
  activeAnswer = null;
});

on('answer:error', (e) => {
  suggests.classList.remove('loading');
  answer.classList.remove('thinking');
  answerMeta.textContent = 'failed';
  showBanner(e.message || 'The AI request failed.');
});

on('focus-ask', () => { askInput.focus(); askInput.select(); });

let clickThroughOn = false;

on('overlay:clickThrough', (v) => {
  clickThroughOn = !!v;
  document.getElementById('through').classList.toggle('on', clickThroughOn);
  document.body.classList.toggle('ghost', clickThroughOn);
  if (clickThroughOn) {
    showBanner('Click-through is on - the mouse passes through. The toolbar still works. Ctrl+Shift+X to turn it off.', 'warn');
  } else {
    hideBanner();
    window.copilot.hover(false);
  }
});

// While click-through is on the window ignores the mouse, but still receives
// mousemove (forward: true). Re-enable input only over things you can click,
// so the toolbar and the ask box keep working.
const CONTROLS = '#bar, #foot, #suggests, button, input, .chip';
let lastOverControl = null;
document.addEventListener('mousemove', (e) => {
  if (!clickThroughOn) return;
  const over = !!(e.target.closest && e.target.closest(CONTROLS));
  if (over !== lastOverControl) {
    lastOverControl = over;
    window.copilot.hover(over);
  }
}, { passive: true });

// ---------------- controls ----------------

for (const b of document.querySelectorAll('#sizes button')) {
  b.onclick = () => window.copilot.setSize(b.dataset.size);
}
$('through').onclick = () => {
  const on_ = !$('through').classList.contains('on');
  window.copilot.setClickThrough(on_);
};
opacityEl.oninput = () => window.copilot.setOpacity(opacityEl.value / 100);

$('copyAnswer').onclick = async () => {
  const t = answer.textContent.trim();
  if (!t || answer.classList.contains('empty')) return;
  try { await navigator.clipboard.writeText(t); } catch { return; }
  const b = $('copyAnswer');
  b.classList.add('done'); b.textContent = 'copied';
  setTimeout(() => { b.classList.remove('done'); b.textContent = 'copy'; }, 1200);
};

$('dash').onclick = () => window.copilot.openDashboard();
$('hide').onclick = () => window.copilot.hide();
$('again').onclick = () => window.copilot.repeat();

function send() {
  const q = askInput.value.trim();
  if (!q) return;
  askInput.value = '';
  window.copilot.ask(q);
}
$('askGo').onclick = send;
askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send();
  if (e.key === 'Escape') askInput.blur();
});

// ---------------- boot ----------------

window.copilot.state().then((s) => {
  if (s.opacity) opacityEl.value = Math.round(s.opacity * 100);
  if (s.listening) setStatus('listening', 'live');
  else setStatus('idle - start a meeting from the dashboard', 'idle');
  if (s.authError) showBanner('Claude is not signed in. In a terminal run  claude , type  /login , then restart.');
  else if (s.mock) showBanner('Offline demo mode - answers are canned, not from the AI.', 'warn');
});
