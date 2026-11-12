'use strict';
/**
 * Which AI can write the answers on this computer, and signing in to it.
 *
 * Two subscriptions can drive the app, each through its own command-line tool:
 *   Claude   the Claude Code CLI      claude auth status --json / claude auth login
 *   ChatGPT  the Codex CLI            codex login status        / codex login
 *
 * The app checks both, uses whichever is signed in, and when neither is it
 * offers a button that starts the tool's own sign-in. That sign-in opens the
 * browser and finishes there, so nobody has to type anything into a terminal.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { findCodex } = require('./codex');

const IS_WIN = process.platform === 'win32';

/** Where the Claude CLI lands for each way of installing it. */
function findClaude(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = os.homedir();
  const names = IS_WIN ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = [
    // The official installer, on both systems.
    path.join(home, '.local', 'bin'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ];
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'));
  }
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * An environment the CLIs can run in when the app was opened from Finder or
 * the Start menu, which gives it almost no PATH. Their own folder goes first,
 * so a CLI that is really a Node script finds the node it was installed with.
 */
function cliEnv(exe) {
  const extra = [path.dirname(exe)];
  if (!IS_WIN) extra.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  const env = { ...process.env, PATH: [...extra, process.env.PATH || ''].join(path.delimiter) };
  // Started from inside another Claude session (a developer running the app
  // from a terminal), these make the CLI report that session instead.
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE') delete env[k];
  }
  return env;
}

function run(exe, args, timeout = 15000) {
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(exe);
  const r = spawnSync(shell ? `"${exe}"` : exe, args,
    { encoding: 'utf8', timeout, windowsHide: true, shell, env: cliEnv(exe) });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function claudeStatus(claudePath) {
  const exe = findClaude(claudePath);
  if (!exe) return { installed: false, signedIn: false };
  const r = run(exe, ['auth', 'status', '--json']);
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    return { installed: true, signedIn: !!j.loggedIn, exe };
  } catch {
    // A version from before `auth status` existed. It cannot be asked, so it
    // is reported as installed and left to the first real request to decide.
    return { installed: true, signedIn: null, exe, old: true };
  }
}

function chatgptStatus(codexPath) {
  const exe = findCodex(codexPath);
  if (!exe) return { installed: false, signedIn: false };
  const r = run(exe, ['login', 'status']);
  return { installed: true, signedIn: r.status === 0 && /logged in/i.test(r.out), exe };
}

/** Both, plus which one the app should use. */
function detect(settings = {}) {
  const claude = claudeStatus(settings.claudePath);
  const chatgpt = chatgptStatus(settings.codexPath);
  const chosen = (settings.provider || 'claude').toLowerCase();
  let use = chosen;
  // Follow the sign-in: if the chosen one is not signed in but the other is,
  // use the other. An API key choice ('openai') is the user's explicit call
  // and is left alone.
  if (chosen === 'claude' && claude.signedIn === false && chatgpt.signedIn) use = 'codex';
  if (chosen === 'codex' && !chatgpt.signedIn && claude.signedIn) use = 'claude';
  const ready = chosen === 'openai' ? !!settings.openaiKey
    : use === 'codex' ? !!chatgpt.signedIn : claude.signedIn !== false;
  return { claude, chatgpt, use, ready };
}

/**
 * Start a sign-in. The CLI opens the browser and waits for it to come back,
 * so this only launches it; the dashboard watches detect() for the result.
 */
function signIn(which, settings = {}) {
  const exe = which === 'chatgpt' ? findCodex(settings.codexPath) : findClaude(settings.claudePath);
  if (!exe) {
    return { ok: false, error: which === 'chatgpt'
      ? 'ChatGPT needs the Codex CLI. Run the installer again, or: npm install -g @openai/codex'
      : 'Claude needs the Claude CLI. Run the installer again, or see claude.com/claude-code' };
  }
  const args = which === 'chatgpt' ? ['login'] : ['auth', 'login', '--claudeai'];
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(exe);
  try {
    const child = spawn(shell ? `"${exe}"` : exe, args,
      { detached: true, stdio: 'ignore', windowsHide: true, shell, env: cliEnv(exe) });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { detect, signIn, findClaude, claudeStatus, chatgptStatus };
