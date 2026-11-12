'use strict';
/**
 * ChatGPT brain, through the Codex CLI.
 *
 * A ChatGPT subscription has no API, but OpenAI's Codex CLI signs in with one
 * (`codex login`, "Sign in with ChatGPT") and answers prompts from the command
 * line. That makes it usable here with nothing but the subscription: no API
 * key, no per-token bill.
 *
 * The trade-off is speed. `codex exec` starts a fresh agent for every request
 * and returns the reply in one piece rather than streaming it, so an answer
 * takes about 6-7 seconds where the Claude session takes about 2. Fine for
 * preparing a brief and writing the summary; slower than ideal mid-call.
 *
 * Stateless, like the OpenAI API engine: every request carries the brief and
 * the recent transcript, so there is no session to keep warm or resynchronise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const APP_ROOT = path.join(__dirname, '..', '..');
// The one-command installer keeps its own Node and, when asked for ChatGPT, its
// own copy of the Codex CLI in here, so neither needs an administrator.
const RUNTIME = path.join(APP_ROOT, '.runtime');

/** Folders of the installer's own Node and Codex, first so they win. */
function runtimeDirs() {
  return IS_WIN
    ? [path.join(RUNTIME, 'codex'), path.join(RUNTIME, 'node')]
    : [path.join(RUNTIME, 'codex', 'bin'), path.join(RUNTIME, 'node', 'bin')];
}

/**
 * PATH for running the CLI. The Codex CLI from npm is a Node script, and an
 * app opened from Finder or the Start menu may have no node on its PATH when
 * the installer brought its own.
 */
function codexEnv(exe) {
  const extra = [...(exe ? [path.dirname(exe)] : []), ...runtimeDirs()];
  if (!IS_WIN) extra.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  return { ...process.env, PATH: [...extra, process.env.PATH || ''].join(path.delimiter) };
}

// The ChatGPT sign-in only offers the default model and these efforts. "low"
// is the fastest it accepts ("minimal" is refused with the default model).
const DEFAULT_EFFORT = 'low';

/**
 * Find the codex binary.
 *
 * An app started from Finder or the Start menu does not get the shell's PATH,
 * and npm puts global binaries somewhere different on every Node manager, so
 * the usual places are checked as well as PATH.
 */
function findCodex(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = os.homedir();
  const names = IS_WIN ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  const dirs = [runtimeDirs()[0], ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  } else {
    dirs.push(path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
      path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'));
    // nvm and fnm keep one global bin per Node version.
    for (const root of [path.join(home, '.nvm', 'versions', 'node'),
      path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
      path.join(home, '.local', 'share', 'fnm', 'node-versions')]) {
      try {
        for (const v of fs.readdirSync(root)) {
          dirs.push(path.join(root, v, 'bin'), path.join(root, v, 'installation', 'bin'));
        }
      } catch { /* not installed */ }
    }
  }
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** A Windows .cmd shim has to go through cmd.exe; everything else runs directly. */
function needsShell(exe) {
  return IS_WIN && /\.(cmd|bat)$/i.test(exe);
}

function quoteWin(a) {
  return /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a;
}

/** Signed in with ChatGPT? Cheap, local, no network. */
function codexStatus(explicit) {
  const exe = findCodex(explicit);
  if (!exe) return { installed: false, signedIn: false, exe: null };
  const shell = needsShell(exe);
  const r = spawnSync(shell ? quoteWin(exe) : exe, ['login', 'status'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, shell, env: codexEnv(exe) });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { installed: true, signedIn: r.status === 0 && /logged in/i.test(out), exe, detail: out.trim() };
}

function workDir() {
  // An empty folder, so the agent has nothing of yours to read even if it tried.
  const dir = path.join(APP_ROOT, 'data', 'codex-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class CodexEngine {
  constructor(settings = {}, log = () => {}) {
    this.exe = findCodex(settings.codexPath);
    this.model = (settings.codexModel || '').trim();
    this.effort = settings.codexEffort || DEFAULT_EFFORT;
    this.log = log;
    this.system = '';
    this._child = null;
  }

  get configured() {
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
   * One reply. onDelta(chunk, full) fires once, with the whole reply, because
   * the CLI hands the message over complete. Resolves with the text.
   */
  send(userText, onDelta, opts = {}) {
    if (!this.configured) {
      return Promise.reject(new Error(
        'The Codex CLI is not installed. Run the install line again with ChatGPT chosen (see the README).'));
    }
    this.abort();

    const prompt = [
      this.system,
      '',
      'Reply with plain text only. Do not run commands, read files or use tools.',
      '',
      userText,
    ].join('\n');

    const args = [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check',
      // Ignore the user's own Codex config: their MCP servers, rules and model
      // choices would slow every answer down and change how it behaves.
      '--ignore-user-config', '--ignore-rules',
      '-s', 'read-only', '-C', workDir(),
      '-c', `model_reasoning_effort=${opts.effort || this.effort}`,
      ...(this.model ? ['-m', this.model] : []),
      // The prompt goes in on stdin: a long brief would overflow the Windows
      // command-line limit (32,767 characters) as an argument.
      '-',
    ];

    return new Promise((resolve, reject) => {
      const shell = needsShell(this.exe);
      const child = spawn(shell ? quoteWin(this.exe) : this.exe,
        shell ? args.map(quoteWin) : args,
        { windowsHide: true, shell, env: codexEnv(this.exe) });
      this._child = child;

      let buf = '';
      let text = '';
      let failure = '';
      let stderr = '';
      const timer = setTimeout(() => {
        failure = failure || 'ChatGPT took longer than 60 seconds to answer.';
        this.abort();
      }, opts.timeoutMs || 60000);

      const handle = (line) => {
        let e;
        try { e = JSON.parse(line); } catch { return; }
        if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message') {
          text = String(e.item.text || '').trim();
        } else if (e.type === 'turn.failed' || e.type === 'error') {
          const m = (e.error && e.error.message) || e.message || 'ChatGPT request failed';
          failure = explain(String(m));
        }
      };

      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, nl).trim());
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error('Could not start the Codex CLI: ' + e.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buf.trim()) handle(buf.trim());
        const aborted = this._child !== child;
        if (!aborted) this._child = null;
        if (text) {
          if (onDelta) onDelta(text, text);
          return resolve(text);
        }
        if (aborted && !failure) return resolve('');
        reject(new Error(failure || explain(stderr) ||
          `The Codex CLI stopped without an answer (exit ${code}).`));
      });

      child.stdin.on('error', () => { /* the process exited before reading */ });
      child.stdin.end(prompt);
    });
  }
}

/** Turn the CLI's errors into something a person can act on. */
function explain(msg) {
  const m = String(msg || '');
  if (/not logged in|login|unauthori[sz]ed|401|sign in/i.test(m)) {
    return 'ChatGPT is not signed in. Open a terminal, run  codex login  and choose "Sign in with ChatGPT".';
  }
  if (/usage limit|rate limit|429|quota/i.test(m)) {
    return 'ChatGPT usage limit reached for now. It resets on its own; Claude or an API key can stand in meanwhile.';
  }
  return m.replace(/\s+/g, ' ').trim().slice(0, 300);
}

module.exports = { CodexEngine, findCodex, codexStatus, codexEnv, explain, DEFAULT_EFFORT };
