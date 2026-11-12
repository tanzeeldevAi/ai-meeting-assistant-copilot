#!/usr/bin/env node
'use strict';
/*
 * Used by the install tests: the app finds the Codex CLI that the installer put
 * in its own folder, and can run it with the PATH it gives the CLI, even when
 * the computer has no node of its own (as when the app is opened from Finder
 * or the Start menu after a portable install).
 *
 *   node tools/check-codex-install.js
 */
const { spawnSync } = require('child_process');
const { findCodex, codexEnv } = require('../src/main/codex');

const exe = findCodex();
if (!exe || !exe.includes('.runtime')) {
  console.error('The installer\'s Codex was not found. Found:', exe);
  process.exit(2);
}
const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
const r = spawnSync(shell ? `"${exe}"` : exe, ['--version'],
  { encoding: 'utf8', shell, env: codexEnv(exe), windowsHide: true });
if (r.status !== 0) {
  console.error('Codex did not run:', r.status, r.stderr || r.error);
  process.exit(3);
}
console.log('app runs', exe, '->', r.stdout.trim());
