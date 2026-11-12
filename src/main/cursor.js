'use strict';
/**
 * Cursor brain, through the Cursor CLI (`agent`).
 *
 * A Cursor subscription has no OpenAI-compatible chat endpoint for third-party
 * apps, but the official CLI signs in with the same account (`agent login`) and
 * answers prompts from the command line. That makes it usable here with the
 * subscription the user already has: no Claude, no ChatGPT, no separate API key
 * (unless they prefer CURSOR_API_KEY for headless auth).
 *
 * Same trade-off as Codex: each request is a fresh print-mode run and the reply
 * arrives as one piece (unless stream-json is enabled later), so live answers
 * are slower than a warm Claude session. Fine when Cursor is what they pay for.
 *
 * Stateless: every request carries the brief and the recent transcript.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const APP_ROOT = path.join(__dirname, '..', '..');
// Windows CreateProcess command-line limit is 32,767 characters. Leave headroom
// for the binary path and flags; longer prompts go through a workspace file.
const ARGV_PROMPT_LIMIT = 24000;

/** Folders where the Cursor installer commonly puts `agent`. */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ];
  if (IS_WIN) {
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'cursor-agent'));
      dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'resources', 'app', 'bin'));
    }
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin',
      path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'));
  }
  return dirs;
}

/**
 * PATH for running the CLI. An app opened from Finder / Start menu often has
 * almost no PATH, so the CLI's own folder goes first.
 */
function cursorEnv(exe, settings = {}) {
  const extra = [...(exe ? [path.dirname(exe)] : []), ...candidateDirs().slice(0, 4)];
  if (!IS_WIN) extra.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  const env = { ...process.env, PATH: [...extra, process.env.PATH || ''].join(path.delimiter) };
  const key = (settings.cursorApiKey || process.env.CURSOR_API_KEY || '').trim();
  if (key) env.CURSOR_API_KEY = key;
  return env;
}

/**
 * Find the Cursor Agent binary (`agent` or `cursor-agent`).
 */
function findAgent(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const names = IS_WIN
    ? ['agent.exe', 'agent.cmd', 'agent', 'cursor-agent.exe', 'cursor-agent.cmd', 'cursor-agent']
    : ['agent', 'cursor-agent'];
  for (const d of candidateDirs()) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

function needsShell(exe) {
  return IS_WIN && /\.(cmd|bat)$/i.test(exe);
}

function quoteWin(a) {
  return /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a;
}

/**
 * Signed in with Cursor? Cheap when status is local; also true if an API key is
 * configured (headless auth), which status may not always report.
 */
function cursorStatus(explicit, settings = {}) {
  const exe = findAgent(explicit || (settings && settings.cursorPath));
  const key = (settings.cursorApiKey || process.env.CURSOR_API_KEY || '').trim();
  if (!exe) return { installed: false, signedIn: !!key, exe: null, viaKey: !!key };
  if (key) return { installed: true, signedIn: true, exe, viaKey: true };

  const shell = needsShell(exe);
  const r = spawnSync(shell ? quoteWin(exe) : exe, ['status', '--format', 'json'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, shell, env: cursorEnv(exe, settings) });
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  // Prefer JSON when the CLI supports --format json.
  try {
    const start = out.indexOf('{');
    if (start >= 0) {
      const j = JSON.parse(out.slice(start));
      const signedIn = !!(j.authenticated || j.loggedIn || j.logged_in || j.isAuthenticated
        || (j.user && (j.user.email || j.user.id))
        || (j.account && (j.account.email || j.account.id)));
      if (signedIn || j.authenticated === false || j.loggedIn === false) {
        return { installed: true, signedIn, exe, detail: out.trim() };
      }
    }
  } catch { /* fall through to text */ }

  // Text fallback for older CLIs.
  const signedIn = r.status === 0 && /logged in|authenticated|signed in/i.test(out)
    && !/not (logged|authenticated|signed)/i.test(out);
  return { installed: true, signedIn, exe, detail: out.trim() };
}

function workDir() {
  // Empty folder: ask-mode still can read files we place here, but has nothing
  // else of the user's disk to wander into by accident.
  const dir = path.join(APP_ROOT, 'data', 'cursor-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class CursorEngine {
  constructor(settings = {}, log = () => {}) {
    this.settings = settings;
    this.exe = findAgent(settings.cursorPath);
    this.model = (settings.cursorModel || '').trim();
    this.log = log;
    this.system = '';
    this._child = null;
  }

  get configured() {
    // The binary is required; an API key only replaces browser login.
    return !!this.exe;
  }

  setSystem(system) {
    this.system = system || '';
  }

  /** Cancel an in-flight answer -- used when a newer question arrives. */
  abort() {
    const c = this._child;
    this._child = null;
    if (c && c.exitCode === null) {
      try {
        if (IS_WIN) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
        else c.kill('SIGTERM');
      } catch { /* already gone */ }
    }
  }

  /**
   * One reply. onDelta(chunk, full) fires once with the whole reply in text
   * mode (Cursor print mode returns the answer complete). Resolves with text.
   */
  send(userText, onDelta, opts = {}) {
    if (!this.exe) {
      // Key alone is not enough without the binary to call.
      return Promise.reject(new Error(
        'The Cursor CLI is not installed. Install it from https://cursor.com/docs/cli/overview then restart Meeting Copilot.'));
    }
    this.abort();

    const prompt = [
      this.system,
      '',
      'Reply with plain text only. Do not edit files, run commands, or use tools.',
      'Do not wrap the answer in markdown fences.',
      '',
      userText,
    ].join('\n');

    const cwd = workDir();
    let promptArg = prompt;
    let cleanup = null;
    if (Buffer.byteLength(prompt, 'utf8') > ARGV_PROMPT_LIMIT) {
      const file = path.join(cwd, `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(file, prompt, 'utf8');
      cleanup = file;
      promptArg = [
        `Open the file named ${path.basename(file)} in this workspace.`,
        'Follow every instruction in it exactly.',
        'Reply with only the answer text — no preamble, no markdown fences.',
      ].join(' ');
    }

    const args = [
      '-p',
      '--mode=ask',
      '--output-format', 'text',
      '--trust',
      '--workspace', cwd,
      ...(this.model ? ['--model', this.model] : []),
      promptArg,
    ];

    return new Promise((resolve, reject) => {
      const shell = needsShell(this.exe);
      const child = spawn(shell ? quoteWin(this.exe) : this.exe,
        shell ? args.map(quoteWin) : args,
        { windowsHide: true, shell, env: cursorEnv(this.exe, this.settings), cwd });
      this._child = child;

      let stdout = '';
      let stderr = '';
      let failure = '';
      const timer = setTimeout(() => {
        failure = failure || 'Cursor took longer than 90 seconds to answer.';
        this.abort();
      }, opts.timeoutMs || 90000);

      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (e) => {
        clearTimeout(timer);
        if (cleanup) try { fs.unlinkSync(cleanup); } catch { /* ignore */ }
        reject(new Error('Could not start the Cursor CLI: ' + e.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (cleanup) try { fs.unlinkSync(cleanup); } catch { /* ignore */ }
        const aborted = this._child !== child;
        if (!aborted) this._child = null;

        const text = String(stdout || '').trim();
        if (text) {
          if (onDelta) onDelta(text, text);
          return resolve(text);
        }
        if (aborted && !failure) return resolve('');
        reject(new Error(failure || explain(stderr || stdout) ||
          `The Cursor CLI stopped without an answer (exit ${code}).`));
      });
    });
  }
}

/** Turn the CLI's errors into something a person can act on. */
function explain(msg) {
  const m = String(msg || '');
  if (/not (logged|authenticated|signed)|unauthori[sz]ed|401|sign in|login/i.test(m)) {
    return 'Cursor is not signed in. Open a terminal, run  agent login  and finish in the browser.';
  }
  if (/usage limit|rate limit|429|quota|spend/i.test(m)) {
    return 'Cursor usage limit reached for now. It resets on its own; an OpenAI API key can stand in meanwhile.';
  }
  return m.replace(/\s+/g, ' ').trim().slice(0, 300);
}

module.exports = {
  CursorEngine, findAgent, cursorStatus, cursorEnv, explain, ARGV_PROMPT_LIMIT,
};
