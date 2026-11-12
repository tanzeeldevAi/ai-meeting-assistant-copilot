'use strict';
/**
 * The Claude layer.
 *
 * One warm session per meeting. Spinning up the CLI costs seconds, so we start
 * it once and feed turns into it -- the first answer of a meeting is slow, every
 * answer after it is fast.
 *
 * Two things this file is careful about:
 *
 *  1. It answers THEM, never ME. That is enforced upstream by which wire the
 *     audio came from, and again here by `needsAnswer` refusing to fire on
 *     acknowledgements ("yeah", "okay", "sounds good") that would otherwise
 *     spam the overlay mid-conversation.
 *
 *  2. It must not invent facts. The system prompt makes not-knowing an explicit,
 *     safe option, because a confident wrong answer read aloud in a real meeting
 *     is far worse than "let me check and come back to you".
 */

const { EventEmitter } = require('events');
const { OpenAIEngine } = require('./openai');
const { CodexEngine } = require('./codex');

/**
 * Environment for the spawned Claude CLI.
 *
 * Two jobs:
 *
 * 1. If the user supplied an API key, hand it over. Claude Code normally uses
 *    the subscription via a stored OAuth token, but that token is not always on
 *    disk -- on this machine the Desktop app keeps its session in memory and
 *    `~/.claude/.credentials.json` holds empty tokens, so a separately-launched
 *    app gets "OAuth session expired". A key is the reliable fallback (it bills
 *    per token rather than using the subscription).
 *
 * 2. Strip the CLAUDE_CODE_* variables of a parent Claude session. If this app
 *    is ever started FROM inside Claude Code, the child inherits session state
 *    that points at a host auth channel it cannot reach, and fails confusingly.
 */
function spawnEnv(settings = {}) {
  const env = process.platform === 'darwin' ? macBaseEnv() : {};
  const key = (settings.apiKey || '').trim();
  if (key) env.ANTHROPIC_API_KEY = key;

  for (const k of Object.keys(process.env)) {
    if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE' || k === 'CLAUDE_AGENT_SDK_VERSION') {
      env[k] = undefined;                    // undefined removes it for the child
    }
  }
  return env;
}

/**
 * Claude Code indexes its working directory in the background. An app opened
 * from Finder runs with cwd "/", and indexing the whole disk ran the Claude
 * process out of memory ~20 s into a meeting. Give it an empty folder instead;
 * that also keeps any CLAUDE.md from leaking into the answers.
 */
function claudeCwd() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'data', 'claude-cwd');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fall back below */ }
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * macOS: run the installed Claude Code rather than the copy bundled in the SDK.
 * The bundled one loads the whole of ~/.claude/projects in the background; on
 * the Mac that is ~10 GB of history and it died of out-of-memory ~20 s into
 * every meeting. The current native build stays flat at ~230 MB.
 */
let exeCache;
function claudeExe() {
  if (exeCache !== undefined) return exeCache;
  exeCache = {};
  if (process.platform !== 'darwin') return exeCache;
  const fs = require('fs');
  const path = require('path');
  const home = process.env.HOME || '';
  for (const p of [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try {
      const real = fs.realpathSync(p);
      if (!real.endsWith('.js')) { exeCache = { pathToClaudeCodeExecutable: real }; break; }
    } catch { /* not installed there */ }
  }
  return exeCache;
}

/**
 * macOS: the SDK uses `env` as the child's WHOLE environment and launches
 * `node cli.js` through PATH. An app opened from Finder has a bare PATH with no
 * node on it, so put a `node` shim first that runs whatever is running us:
 * node itself, or Electron in node mode.
 */
let shimDir = null;
function macBaseEnv() {
  if (!shimDir) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'data', 'bin');
    const isNode = path.basename(process.execPath) === 'node';
    const body = '#!/bin/sh\n' + (isNode ? '' : 'ELECTRON_RUN_AS_NODE=1 ') +
      'exec "' + process.execPath + '" "$@"\n';
    try {
      fs.mkdirSync(dir, { recursive: true });
      const shim = path.join(dir, 'node');
      if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf8') !== body) fs.writeFileSync(shim, body, { mode: 0o755 });
      shimDir = dir;
    } catch { shimDir = ''; }
  }
  const env = { ...process.env };
  env.PATH = [shimDir, process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    .filter(Boolean).join(':');
  return env;
}

// Utterances that are conversational glue, not questions to answer.
const FILLER = new Set([
  'yeah', 'yes', 'yep', 'no', 'nope', 'okay', 'ok', 'right', 'sure', 'exactly',
  'got it', 'mm hmm', 'mhm', 'uh huh', 'i see', 'sounds good', 'perfect',
  'great', 'nice', 'cool', 'thanks', 'thank you', 'alright', 'all right',
  'hello', 'hi', 'hey', 'good morning', 'good afternoon', 'one second',
  'one moment', 'can you hear me', 'you are on mute', "you're on mute",
]);

const QUESTION_WORDS = /\b(what|how|why|when|where|which|who|whom|whose|can|could|would|will|do|does|did|is|are|was|were|have|has|should|shall|tell me|walk me|explain|describe|talk me through|any|do you)\b/i;

/**
 * Should this turn get an answer? Cheap gate that runs before we spend a
 * request. Deliberately permissive -- a missed answer is worse than an extra.
 */
function needsAnswer(text) {
  const t = String(text || '').trim();
  if (t.length < 3) return false;

  const bare = t.toLowerCase().replace(/[^a-z\s']/g, '').trim();
  if (FILLER.has(bare)) return false;
  // Short and no question signal at all -> almost certainly backchannel.
  if (bare.split(/\s+/).length <= 3 && !t.includes('?')) return false;

  if (t.includes('?')) return true;
  if (QUESTION_WORDS.test(t)) return true;
  // A long statement usually still deserves a response in a meeting.
  return t.split(/\s+/).length >= 8;
}

function buildSystem(brief, settings) {
  const b = brief || {};
  const maxWords = settings?.maxWords || 60;
  const lines = [];

  lines.push(
    'You are helping someone during a LIVE meeting. They are genuinely skilled at their work,',
    'but English is not their first language, so forming answers quickly under pressure is hard.',
    '',
    'You will be given what the OTHER person just said. You reply with the words YOUR PERSON',
    'should say back. They will read your reply out loud, more or less as written.',
    '',
    'HOW TO WRITE',
    `- First person, as them. Never "you could say" or "try telling them". Just the words.`,
    `- Aim for 50-${maxWords} words: a real answer with substance, not a one-liner.`,
    '- Give the reasoning or the specifics that make it convincing, not just the conclusion.',
    '- Go SHORT (a sentence or two) only when the moment genuinely calls for it:',
    '  small talk, a yes/no, agreeing, or saying goodbye.',
    `- Never exceed ${maxWords + 40} words. They have to say this out loud.`,
    '- Plain, natural, spoken English. Everyday words. Short sentences.',
    '- Warm and human, not stiff or robotic. Contractions are good.',
    '- No bullet points, no headings, no markdown, no emoji. Just what they say.',
    '- No preamble. Start with the actual reply.',
    '',
    'THE FIRST SENTENCE IS THE ONE THAT MATTERS',
    '- My person starts reading the moment words appear, while you are still writing.',
    '  So the FIRST sentence must already answer the question directly and be safe to',
    '  say on its own. Put the answer first, the reasoning after.',
    '- Do not open with a wind-up: not "That is a great question", not "Absolutely",',
    '  not "So basically", not restating what they asked. Those waste the seconds they',
    '  are standing there in silence.',
    '- Good: "Yes, about three weeks. We start with the listings that already get views."',
    '  Bad:  "That is a really good question. Let me explain how our timeline works."',
    '',
    'THE PREPARED MATERIAL IS YOUR SCRIPT - WORK IN TWO MODES',
    '',
    'MODE 1 - a prepared line covers what they just said:',
    '- Use that line as close to WORD FOR WORD as you can.',
    '- Change only what the moment forces: a name, a connecting word, dropping a',
    '  sentence that no longer applies, joining two prepared lines that both fit.',
    '- Do NOT rewrite it in your own words. They chose that wording on purpose and',
    '  they are about to read it out loud.',
    '- Prepared lines are usually marked "SAY", an arrow, a bullet or quotation marks.',
    '',
    'MODE 2 - they asked something the material does not cover:',
    '- Still answer it, but stay INSIDE the world of the prepared material.',
    '- Use only the facts, numbers, prices, services, claims and examples that appear',
    '  there. Match its voice, its vocabulary and its level of detail.',
    '- Never introduce a capability, price, promise or statistic that is not in it.',
    '- If the honest answer genuinely is not in the material, say you will confirm',
    '  after the call. Do not fill the gap with something plausible.',
    '',
    'The prepared material is the single source of truth for BOTH what to say and',
    'what is true. Treat anything outside it as something you do not know.',
    '- Once a prepared line has clearly been used, move on; do not repeat it later.',
    '',
    'PRIVATE NOTES - NEVER SAY THESE OUT LOUD',
    '- The brief may also contain private reminders to my person: coaching, stage',
    '  directions, or anything marked "DO NOT SAY", "DON\'T SAY", "NOTE", "reminder",',
    '  "private", or similar.',
    '- Those are instructions TO my person, never words FOR them. Never put them in your',
    '  reply. Use them to decide what to write, then write the spoken words only.',
    '- Examples of what to never say aloud: "Stop here, let them talk", "these are private',
    '  reminders", "only read the lines under SAY".',
    '',
    'NEVER CLAIM EXPERIENCE THAT IS NOT IN THE BRIEF',
    '',
    'This rule cost a real deal. Asked "do you have experience with kids products?"',
    'with an empty brief, the reply was "Yes, I have experience... we have seen',
    'good results running campaigns for similar stores." There was no such experience.',
    'The client asked for the case study, none existed, and he ended the call saying',
    '"you do not have any results, but you have mentioned that."',
    '',
    '- If they ask "have you done X / worked with Y / do you have results", you may only',
    '  say yes if the brief SAYS SO. Not if it is merely plausible. Not to be encouraging.',
    '- If the brief does not cover it, do NOT claim it and do NOT promise to send proof',
    '  that may not exist. Give an honest reply that still sells the thinking, such as:',
    '  admitting this exact niche is new, then showing how you would approach it, or',
    '  naming what you HAVE done according to the brief.',
    '- An honest "not in that exact niche, but here is how I would attack it" keeps the',
    '  meeting alive. A claim they can ask you to prove and you cannot ends it.',
    '- Never invent a case study, a past client, a metric, or a number of years.',
    '- Do not invent an EXCUSE either. "My past work is under NDA", "the client asked me',
    '  not to share", "I would need to check with legal" - if the brief does not say that,',
    '  it is a fabrication too, and it implies past clients that may not exist. It also',
    '  invites the follow-up question they cannot answer.',
    '- The safe honest shape is: say plainly what you do not have, then move the',
    '  conversation to what you would actually DO for them. Never dress a gap up as a',
    '  restriction.',
    '',
    'ACCURACY - THIS MATTERS MOST',
    '- Only state facts you were given in the brief below, or that are genuinely general knowledge.',
    '- NEVER invent a number, date, price, budget, client name, feature or commitment.',
    '- If you give any figure, it must come from the brief. If they push for a price or a',
    '  budget that is not there, say you will send exact numbers after the call.',
    '- Check any arithmetic you do write. A daily budget times thirty is the monthly one;',
    '  a previous answer said "2,000 to 5,000 daily, roughly 600 to 1,500 monthly", which',
    '  is both invented and wrong, in front of a client who knew the numbers.',
    '- If the honest answer is not knowable, write a natural way of saying so -- for example',
    '  offering to confirm after the call. That is always better than a confident guess.',
    '- If they ask something only your person can answer (their salary, their availability),',
    '  give a natural, non-committal reply that keeps control with your person.',
    '',
    'IF NO REPLY IS NEEDED',
    '- If the other person was only acknowledging, joking, or making small talk that needs no',
    '  substantive answer, reply with exactly: ---',
  );

  const has = (v) => v && String(v).trim();
  const ctx = [];
  if (has(b.kind)) ctx.push(`Type of meeting: ${b.kind}`);
  if (has(b.title)) ctx.push(`Meeting: ${b.title}`);
  if (has(b.company)) ctx.push(`Company / client: ${b.company}`);
  if (has(b.role)) ctx.push(`My person's role or position: ${b.role}`);
  if (has(b.otherSide)) ctx.push(`Who they are talking to: ${b.otherSide}`);
  if (has(b.goal)) ctx.push(`What a good outcome looks like: ${b.goal}`);
  if (has(b.background)) {
    // The label matters. Called "background facts", a real call used 1 of 166
    // prepared lines. Called prepared material, it uses them.
    ctx.push('MY PERSON\'S PREPARED MATERIAL - their prepared lines, their facts, and their\n'
      + 'private notes. This is the FIRST place to look for what to say:\n'
      + b.background);
  }
  if (Array.isArray(b.docs) && b.docs.length) {
    ctx.push('Reference material:\n' + b.docs.map((d) => `- ${d.title || 'note'}: ${d.text}`).join('\n'));
  }
  if (Array.isArray(b.terms) && b.terms.length) {
    ctx.push(`Names and jargon likely to come up: ${b.terms.join(', ')}`);
  }

  if (ctx.length) {
    lines.push('', 'BRIEF FOR THIS MEETING', ...ctx);
  } else {
    lines.push('', 'BRIEF FOR THIS MEETING', '(none given - stay general and do not invent specifics)');
  }

  return lines.join('\n');
}

/**
 * One-shot request outside the live session.
 *
 * Used for work that happens when no meeting is running -- prepping the brief
 * beforehand, or summarising a meeting you reopen days later. The live Brain
 * keeps a warm session for speed; this trades that for not needing one at all.
 */
async function askOnce(system, user, settings = {}) {
  if (settings.mock) {
    return { ok: true, text: settings.mockText || 'Mock response.' };
  }
  try {
    // One-shot: if another brain is chosen, use it here too so prep and
    // summaries do not silently fall back to a Claude session that may not exist.
    const provider = (settings.provider || 'claude').toLowerCase();
    if (provider === 'openai' || provider === 'codex') {
      const engine = makeStateless(provider, settings);
      if (!engine.configured) return { ok: false, error: notConfigured(provider) };
      engine.setSystem(system);
      try {
        const text = await engine.send(user, null, { maxTokens: 1200, temperature: 0.3 });
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const q = query({
      prompt: user,
      options: {
        systemPrompt: system,
        allowedTools: [],
        // Not latency-critical (nobody is waiting mid-sentence), so use the
        // stronger model here even though live answers use the fast one.
        model: settings.deepModel || 'sonnet',
        permissionMode: 'bypassPermissions',
        env: spawnEnv(settings),
        cwd: claudeCwd(),
        ...claudeExe(),
      },
    });

    let text = '';
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const c of (m.message?.content || [])) if (c.type === 'text') text += c.text;
      }
      if (m.type === 'result') {
        if (m.is_error) {
          const msg = String(m.result || 'request failed');
          return { ok: false, error: msg, auth: /api key|login|authenticate|oauth|expired/i.test(msg) };
        }
        if (!text) text = String(m.result || '');
      }
    }
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Strip a ```json fence if the model added one, then parse. */
function parseJSON(text) {
  const cleaned = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return null;
}

/**
 * Before the meeting: what does Claude still need to know?
 *
 * This is the feature that makes the brief actually good. People write two
 * lines and think they are prepared; these questions surface the specifics
 * that would otherwise become an invented answer live on the call.
 */
async function clarifyBrief(brief, settings = {}) {
  const b = brief || {};
  const known = [
    ['Meeting type', b.kind], ['Title', b.title], ['Company', b.company],
    ['My role', b.role], ['Talking to', b.otherSide], ['Goal', b.goal],
    ['Background', b.background], ['Terms', (b.terms || []).join(', ')],
  ].filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join('\n');

  const system =
    'You prepare someone for a live meeting where an assistant will draft their answers in real time. ' +
    'Your job is to find the gaps in their brief that would force the assistant to guess.';

  const user = [
    'Here is what I know about the meeting so far:',
    '', known || '(almost nothing yet)', '',
    'Ask me the 4-6 most useful questions whose answers would most improve the live answers.',
    'Prioritise concrete specifics that cannot be guessed: numbers, names, prices, dates,',
    'constraints, my actual experience, and anything I must NOT commit to.',
    'Skip anything already answered above.',
    '',
    'Return ONLY a JSON array of strings, no code fence. Each question under 18 words.',
  ].join('\n');

  const r = await askOnce(system, user, {
    ...settings,
    mockText: JSON.stringify([
      'What is your budget or price range for this?',
      'Which specific results can you cite from past work?',
      'What must you avoid committing to on this call?',
      'Who else is involved in the decision?',
    ]),
  });
  if (!r.ok) return r;
  const list = parseJSON(r.text);
  return { ok: true, questions: Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 8) : [] };
}

/** After the meeting: summary, decisions, action items. Works with no live session. */
async function summariseTranscript(transcript, brief, settings = {}) {
  const body = (transcript || []).map((t) => `${t.role === 'me' ? 'ME' : 'THEM'}: ${t.text}`).join('\n');
  if (!body.trim()) return { ok: false, error: 'Nothing was recorded in this meeting.' };

  const system = 'You write concise, accurate meeting notes. Never invent anything that is not in the transcript.';
  const user = [
    brief?.title ? `Meeting: ${brief.title}` : '',
    brief?.company ? `Company: ${brief.company}` : '',
    brief?.goal ? `My goal was: ${brief.goal}` : '',
    '', 'TRANSCRIPT (ME = my person, THEM = the other side):', body, '',
    'Return ONLY valid JSON, no code fence, with exactly these keys:',
    '{"summary": "3-5 sentence plain-English summary",',
    ' "keyPoints": ["..."],',
    ' "decisions": ["..."],',
    ' "actionItems": [{"who": "me|them", "what": "...", "due": ""}],',
    ' "questionsRaised": ["..."],',
    ' "followUp": "a short friendly follow-up message my person could send"}',
  ].filter(Boolean).join('\n');

  const r = await askOnce(system, user, {
    ...settings,
    mockText: JSON.stringify({
      summary: 'Mock summary - sign in to Claude for a real one.',
      keyPoints: ['Mock key point'], decisions: [], actionItems: [],
      questionsRaised: [], followUp: 'Mock follow-up.',
    }),
  });
  if (!r.ok) return r;
  const parsed = parseJSON(r.text);
  return parsed ? { ok: true, summary: parsed } : { ok: true, summary: { summary: r.text } };
}

/** The brains that keep no session: every request carries its own context. */
function makeStateless(provider, settings) {
  return provider === 'codex' ? new CodexEngine(settings, () => {}) : new OpenAIEngine(settings, () => {});
}

function notConfigured(provider) {
  return provider === 'codex'
    ? 'ChatGPT is selected but the Codex CLI is not installed. Run the install line again with ChatGPT chosen (see the README).'
    : 'OpenAI is selected but no API key is set (Dashboard - Settings).';
}

class Brain extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    // Requests in flight, oldest first. The SDK answers in the order messages
    // were sent, so results are matched by position. A single `pending` slot
    // used to be overwritten when a question arrived during the warm-up, and
    // the question then received the WARM-UP's reply.
    this._inflight = [];
    this.gen = 0;
    this.ready = false;
    this.authError = null;
    this.mock = false;
    this.brief = null;
    this.settings = null;
    this._pushMsg = null;
    this._queue = [];
    this._history = [];
  }

  /** Anything awaiting a reply? Used to avoid stacking suggestion requests. */
  get pending() { return this._inflight.length ? this._inflight[0] : null; }

  _begin(req) {
    this._inflight.push(req);
    return req;
  }

  // ---------- session ----------

  async start(brief, settings) {
    await this.stop();
    // stop() raises this so the teardown's own "exited with code 143" is not
    // reported. It used to stay raised for the whole of the next meeting, which
    // hid every real failure: a session that died mid-call just went silent.
    this._stopping = false;
    this.brief = brief;
    this.settings = settings || {};
    this.mock = !!this.settings.mock;
    this.authError = null;
    this._history = [];

    if (this.mock) {
      this.ready = true;
      this.emit('status', { ready: true, mock: true });
      return true;
    }

    this.provider = (this.settings.provider || 'claude').toLowerCase();
    const system = buildSystem(brief, this.settings);

    // The backup brain: what answers if Claude fails mid-meeting, so a rate
    // limit or a lapsed login does not leave the overlay silent. An OpenAI API
    // key if there is one, otherwise ChatGPT through the Codex CLI if it is
    // installed.
    this.backup = null;
    if (this.provider === 'claude' && this.settings.fallbackToOpenAI !== false) {
      const openai = new OpenAIEngine(this.settings, () => {});
      const codex = openai.configured ? null : new CodexEngine(this.settings, () => {});
      this.backup = openai.configured ? openai : (codex && codex.configured ? codex : null);
      if (this.backup) this.backup.setSystem(system);
    }

    if (this.provider === 'openai' || this.provider === 'codex') {
      this.engine = makeStateless(this.provider, this.settings);
      if (!this.engine.configured) {
        this.ready = false;
        this.emit('error', { message: notConfigured(this.provider) });
        return false;
      }
      this.engine.setSystem(system);
      // Every request goes straight to the engine. (This path used to set no
      // sender at all, so the first question of the meeting threw.)
      this._pushMsg = (text) => this._sendStateless(this.engine, this._inflight[this._inflight.length - 1], text);
      this.ready = true;
      this.emit('status', { ready: true, provider: this.provider, model: this.engine.model || 'default' });
      return true;
    }

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    let resolveNext = null;
    const queue = this._queue = [];
    this._pushMsg = (text) => {
      // Kept on the request so the backup brain can resend it if Claude fails.
      const req = this._inflight[this._inflight.length - 1];
      if (req && req.kind !== 'prewarm') req.userText = text;
      const msg = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      };
      if (resolveNext) { const r = resolveNext; resolveNext = null; r(msg); }
      else queue.push(msg);
    };

    async function* input() {
      while (true) {
        if (queue.length) { yield queue.shift(); continue; }
        yield await new Promise((res) => { resolveNext = res; });
      }
    }

    this._abort = new AbortController();
    this.session = query({
      prompt: input(),
      options: {
        abortController: this._abort,
        systemPrompt: buildSystem(brief, this.settings),
        allowedTools: [],                 // pure text: no tool round-trips, lowest latency
        includePartialMessages: true,     // token streaming
        model: this.settings.model || 'haiku',
        // Measured: extended thinking added ~500 ms before the first word and
        // bought nothing for 2-3 sentence spoken replies. See docs/BENCHMARKS.md.
        maxThinkingTokens: 0,
        permissionMode: 'bypassPermissions',
        env: spawnEnv(this.settings),
        cwd: claudeCwd(),
        ...claudeExe(),
        ...(process.env.MC_DEBUG ? { stderr: (d) => console.error('[claude]', String(d).slice(0, 400)) } : {}),
      },
    });

    this._pump();
    this.ready = true;
    this.emit('status', { ready: true, mock: false });

    // Pay the cold-start cost NOW, while he is still setting up the call.
    // Measured: the first turn of a session costs ~10 s, every turn after it
    // ~1.3 s. Without this, the very first question of the meeting -- usually
    // the important one -- is the slowest answer of the whole call.
    this.prewarm();
    return true;
  }

  /** Burn the session's cold start on a throwaway turn. Never reaches the UI. */
  prewarm() {
    // Only the Claude session has a cold start worth paying early. The other
    // brains are stateless; a warm-up there is just a wasted request.
    if (!this._pushMsg || this._inflight.length || this.provider !== 'claude') return;
    this._begin({ id: -1, kind: 'prewarm', text: '', startedAt: Date.now() });
    this.emit('status', { warming: true });
    // Shaped like a real turn on purpose: a trivial "say ready" starts the
    // process but does not write the prompt cache, so the first genuine question
    // still paid ~5 s. This primes both.
    //
    // But it must NOT look like part of the meeting. The earlier version asked
    // "can you hear me alright?" and Claude answered it -- and because the
    // session keeps its history, the first REAL answer of every call opened with
    // "Yeah, I can hear you perfectly." Now the warm-up says outright that it is
    // not the meeting and asks for one throwaway word.
    this._pushMsg([
      'SYSTEM WARM-UP - THIS IS NOT PART OF THE MEETING.',
      'Nobody has spoken yet. Do not treat anything above as something the other',
      'person said, and do not refer back to this exchange later.',
      '',
      'Read the brief now so you are ready, then reply with exactly one word:',
      'ready',
    ].join('\n'));
  }

  /** Single reader over the session; routes deltas to whichever request is live. */
  async _pump() {
    try {
      for await (const m of this.session) {
        if (m.type === 'stream_event') {
          const d = m.event?.delta?.text;
          const cur = this._inflight[0];
          if (!d || !cur) continue;
          cur.text += d;
          // Warm-up and superseded requests still consume their stream, they
          // just never reach the screen.
          if (cur.kind === 'prewarm' || cur.stale) continue;
          this.emit('delta', { id: cur.id, kind: cur.kind, text: d, full: cur.text });
          continue;
        }

        if (m.type === 'result') {
          const p = this._inflight.shift() || null;

          if (m.is_error) {
            const msg = String(m.result || 'unknown error');
            if (/api key|login|authenticate|oauth|expired/i.test(msg)) {
              this.authError = msg;
              this.emit('auth-error', msg);
            }

            // Claude just failed mid-meeting. If a backup brain is configured,
            // silently retry there rather than leaving the overlay blank.
            const canFallback = p && p.kind !== 'prewarm' && !p.stale
              && this.backup && p.userText;

            if (canFallback) {
              this.emit('status', { fallback: this.backup instanceof CodexEngine ? 'codex' : 'openai', reason: msg });
              this._sendStateless(this.backup, p, p.userText);
            } else if (p && p.kind !== 'prewarm') {
              this.emit('error', { id: p.id, kind: p.kind, message: msg });
            }
          } else if (p && p.kind === 'prewarm') {
            this.emit('status', { warming: false, warmedInMs: Date.now() - p.startedAt });
          } else if (p && p.stale) {
            // A newer question replaced this one while it was still generating.
            this.emit('superseded', { id: p.id });
          } else if (p) {
            const text = (p.text || String(m.result || '')).trim();
            this.emit('done', {
              id: p.id, kind: p.kind, text,
              ms: Date.now() - p.startedAt,
              skipped: text === '---' || text === '',
            });
          }
        }
      }
    } catch (e) {
      this.ready = false;
      // Tearing the session down kills the CLI, which surfaces here as
      // "exited with code 143" (SIGTERM). That is the shutdown working, not a
      // fault -- reporting it would put a red banner on the overlay every time
      // a meeting ends.
      if (this._stopping) return;
      this.emit('error', { message: String(e && e.message ? e.message : e) });
    }
  }

  /**
   * Send one request to an engine that keeps no session (OpenAI API, Codex).
   * The request object is tracked by identity, not position, because these
   * replies can finish in any order relative to the Claude queue.
   */
  _sendStateless(engine, req, text) {
    if (!req) return;
    req.userText = text;
    if (!this._inflight.includes(req)) this._inflight.push(req);
    const finish = () => {
      const i = this._inflight.indexOf(req);
      if (i >= 0) this._inflight.splice(i, 1);
    };
    engine.send(text, (chunk, full) => {
      if (req.stale) return;
      req.text = full;
      this.emit('delta', { id: req.id, kind: req.kind, text: chunk, full });
    }).then((reply) => {
      finish();
      const out = (reply || req.text || '').trim();
      if (req.stale || !out) { this.emit('superseded', { id: req.id }); return; }
      this.emit('done', {
        id: req.id, kind: req.kind, text: out,
        ms: Date.now() - req.startedAt, skipped: out === '---',
      });
    }).catch((e) => {
      finish();
      if (!req.stale) this.emit('error', { id: req.id, kind: req.kind, message: String((e && e.message) || e) });
    });
  }

  // ---------- requests ----------

  /**
   * Ask for the reply to what the other person just said.
   * `recent` is a compact rolling window of the conversation.
   */
  answer(theySaid, recent) {
    if (!needsAnswer(theySaid)) return null;
    const id = ++this.gen;

    // A newer question makes the previous answer worthless -- drop it so the
    // overlay never shows a reply to a question that has already moved on.
    // A newer question makes an older answer worthless. Mark it stale so its
    // stream is consumed but never shown, instead of overwriting the slot --
    // that used to hand one request's reply to a different request.
    for (const r of this._inflight) {
      if (r.kind === 'answer' && !r.stale) r.stale = true;
    }

    this._begin({ id, kind: 'answer', text: '', startedAt: Date.now() });
    this.emit('start', { id, kind: 'answer', theySaid });

    if (this.mock) { this._mock(id, 'answer', theySaid); return id; }

    const parts = [];
    if (recent && recent.length) {
      parts.push('CONVERSATION SO FAR (oldest first):');
      for (const t of recent) parts.push(`${t.role === 'me' ? 'MY PERSON' : 'THEM'}: ${t.text}`);
      parts.push('');
    }
    parts.push('THEY JUST SAID:', theySaid, '', 'Write what my person should say back now.');
    this._pushMsg(parts.join('\n'));
    return id;
  }

  /** Free-form question typed by the user into the overlay. */
  ask(question, recent) {
    const id = ++this.gen;
    this._begin({ id, kind: 'ask', text: '', startedAt: Date.now() });
    this.emit('start', { id, kind: 'ask', theySaid: question });
    if (this.mock) { this._mock(id, 'ask', question); return id; }

    const parts = [];
    if (recent && recent.length) {
      parts.push('CONVERSATION SO FAR:');
      for (const t of recent) parts.push(`${t.role === 'me' ? 'MY PERSON' : 'THEM'}: ${t.text}`);
      parts.push('');
    }
    parts.push(
      'MY PERSON IS ASKING YOU DIRECTLY (this is not from the other side):',
      question, '',
      'Answer them directly and briefly. If they are asking what to say, give the words to say.',
    );
    this._pushMsg(parts.join('\n'));
    return id;
  }

  /** Questions my person could ask next. Only runs when nothing else is queued. */
  suggest(recent) {
    if (this._inflight.length) return null;
    const id = ++this.gen;
    this._begin({ id, kind: 'suggest', text: '', startedAt: Date.now() });
    this.emit('start', { id, kind: 'suggest' });
    if (this.mock) { this._mock(id, 'suggest', ''); return id; }

    const parts = ['CONVERSATION SO FAR:'];
    for (const t of (recent || [])) parts.push(`${t.role === 'me' ? 'MY PERSON' : 'THEM'}: ${t.text}`);
    parts.push(
      '',
      'Based on exactly what is being discussed right now, give 3 short, smart questions my person',
      'could ask next to sound engaged and move the meeting toward their goal.',
      'One per line. No numbering, no explanation. Under 14 words each.',
    );
    this._pushMsg(parts.join('\n'));
    return id;
  }

  /** Closing summary + notes + action items, as JSON. */
  summarise(transcript, brief) {
    const id = ++this.gen;
    this._begin({ id, kind: 'summary', text: '', startedAt: Date.now() });
    this.emit('start', { id, kind: 'summary' });
    if (this.mock) { this._mock(id, 'summary', ''); return id; }

    const body = (transcript || []).map((t) => `${t.role === 'me' ? 'ME' : 'THEM'}: ${t.text}`).join('\n');
    this._pushMsg([
      'The meeting is over. Here is the full transcript.',
      '', body, '',
      'Return ONLY valid JSON, no code fence, with exactly these keys:',
      '{"summary": "3-5 sentence plain-English summary",',
      ' "keyPoints": ["..."],',
      ' "decisions": ["..."],',
      ' "actionItems": [{"who": "me|them", "what": "...", "due": "" }],',
      ' "questionsRaised": ["..."],',
      ' "followUp": "a short friendly follow-up message my person could send"}',
    ].join('\n'));
    return id;
  }

  // ---------- mock ----------

  /** Offline stand-in so the whole app can be exercised without a Claude login. */
  _mock(id, kind, prompt) {
    const canned = {
      answer: `Good question. The way I'd approach it is to start simple and measure first, then scale the part that actually hurts. I've done this before on a smaller system and it held up well. Happy to walk through the details if that's useful.`,
      ask: `Here's what I'd say: keep it short, confirm the requirement, and offer one concrete next step.`,
      suggest: `What does success look like for you in the first 90 days?\nWhere is the current process slowing you down most?\nWho else needs to be comfortable with this decision?`,
      summary: JSON.stringify({
        summary: 'Mock summary. Enable a real Claude login to generate this properly.',
        keyPoints: ['Mock key point'], decisions: [], actionItems: [],
        questionsRaised: [], followUp: 'Mock follow-up message.',
      }),
    }[kind] || 'Mock response.';

    let i = 0;
    const step = () => {
      const cur = this._inflight[0];
      if (!cur || cur.id !== id) return;
      const chunk = canned.slice(i, i + 4);
      i += 4;
      if (chunk) {
        cur.text += chunk;
        this.emit('delta', { id, kind, text: chunk, full: cur.text });
        setTimeout(step, 12);
      } else {
        const text = cur.text;
        this._inflight.shift();
        this.emit('done', { id, kind, text, ms: 400, skipped: false });
      }
    };
    setTimeout(step, 250);
  }

  async stop() {
    this._stopping = true;
    this.ready = false;
    this._inflight = [];
    for (const e of [this.engine, this.backup]) {
      if (e) { try { e.abort(); } catch { /* ignore */ } }
    }
    this.engine = null;
    const s = this.session;
    this.session = null;
    this._pushMsg = null;
    if (s) {
      // interrupt() waits for the Claude process to acknowledge; with nothing in
      // flight the native build may never answer, which left the process (and
      // this await) hanging after every meeting. Bound it, then kill the process.
      const bounded = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 1500))]);
      try { if (typeof s.interrupt === 'function') await bounded(s.interrupt()); } catch { /* ignore */ }
      try { if (typeof s.return === 'function') await bounded(s.return()); } catch { /* ignore */ }
    }
    const ac = this._abort;
    this._abort = null;
    if (ac) { try { ac.abort(); } catch { /* ignore */ } }
  }
}

module.exports = { Brain, needsAnswer, buildSystem, askOnce, clarifyBrief, summariseTranscript, parseJSON, spawnEnv, claudeExe, claudeCwd };
