'use strict';
/**
 * Which AI can write the answers on this computer, and signing in to it.
 *
 * Three subscriptions can drive the app, each through its own command-line tool:
 *   Claude   the Claude Code CLI      claude auth status --json / claude auth login
 *   ChatGPT  the Codex CLI            codex login status        / codex login
 *   Cursor   the Cursor Agent CLI     agent status              / agent login
 *
 * The app checks them, uses whichever is signed in, and when none is it
 * offers a button that starts the tool's own sign-in. That sign-in opens the
 * browser and finishes there, so nobody has to type anything into a terminal.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { findCodex, codexEnv } = require('./codex');
const { findAgent, cursorStatus, cursorEnv } = require('./cursor');

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
  const env = codexEnv(exe);
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
  const cursor = cursorStatus(settings.cursorPath, settings);
  const chosen = (settings.provider || 'claude').toLowerCase();
  let use = chosen;
  // Follow the sign-in: if the chosen one is not signed in but another is,
  // use the other. An API key choice ('openai') is the user's explicit call
  // and is left alone.
  if (chosen === 'claude' && claude.signedIn === false && chatgpt.signedIn) use = 'codex';
  if (chosen === 'claude' && claude.signedIn === false && !chatgpt.signedIn && cursor.signedIn) use = 'cursor';
  // Only ChatGPT's tool is on this computer (installed with MC_AI=chatgpt):
  // that is the one to offer, even before it is signed in.
  if (chosen === 'claude' && !claude.installed && chatgpt.installed) use = 'codex';
  if (chosen === 'claude' && !claude.installed && !chatgpt.installed && cursor.installed) use = 'cursor';
  if (chosen === 'codex' && !chatgpt.signedIn && claude.signedIn) use = 'claude';
  if (chosen === 'codex' && !chatgpt.signedIn && !claude.signedIn && cursor.signedIn) use = 'cursor';
  if (chosen === 'cursor' && !cursor.signedIn && claude.signedIn) use = 'claude';
  if (chosen === 'cursor' && !cursor.signedIn && !claude.signedIn && chatgpt.signedIn) use = 'codex';
  const ready = chosen === 'openai' ? !!settings.openaiKey
    : use === 'codex' ? !!chatgpt.signedIn
    : use === 'cursor' ? !!cursor.signedIn
    : claude.signedIn !== false;
  return { claude, chatgpt, cursor, use, ready };
}

/**
 * Start a sign-in. The CLI opens the browser and waits for it to come back,
 * so this only launches it; the dashboard watches detect() for the result.
 */
function signIn(which, settings = {}) {
  let exe = null;
  let args = null;
  let env = null;

  if (which === 'chatgpt') {
    exe = findCodex(settings.codexPath);
    args = ['login'];
    env = cliEnv(exe);
    if (!exe) {
      return { ok: false, error: 'ChatGPT needs the Codex CLI. Run the install line again with ChatGPT chosen (see the README).' };
    }
  } else if (which === 'cursor') {
    exe = findAgent(settings.cursorPath);
    args = ['login'];
    env = cursorEnv(exe, settings);
    if (!exe) {
      return { ok: false, error: 'Cursor needs the Cursor CLI (`agent`). Install it from https://cursor.com/docs/cli/overview then restart Meeting Copilot.' };
    }
  } else {
    exe = findClaude(settings.claudePath);
    args = ['auth', 'login', '--claudeai'];
    env = cliEnv(exe);
    if (!exe) {
      return { ok: false, error: 'Claude needs the Claude CLI. Run the installer again, or see claude.com/claude-code' };
    }
  }

  const shell = IS_WIN && /\.(cmd|bat)$/i.test(exe);
  try {
    const child = spawn(shell ? `"${exe}"` : exe, args,
      { detached: true, stdio: 'ignore', windowsHide: true, shell, env });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { detect, signIn, findClaude, claudeStatus, chatgptStatus };
