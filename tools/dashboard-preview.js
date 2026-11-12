'use strict';
/**
 * Renders the dashboard's Settings tab with REAL device data and saves a
 * picture of it, so the device panel can be checked without hunting for the
 * window behind everything else.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const store = require('../src/main/store');
const { resolvePython } = require('../src/main/bridge');

function realDeviceList() {
  const py = resolvePython();
  if (!py) return { ok: false, detail: 'python not found' };
  const r = spawnSync(py.exe, [...py.pre, '-u', path.join(__dirname, '..', 'audio', 'devtest.py'), '--list'], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const line = String(r.stdout || '').trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  try { return JSON.parse(line); } catch { return { ok: false, detail: 'no device list' }; }
}

// The screenshots in the README use made-up devices; REAL_DEVICES=1 lists the
// ones on this machine instead, which is the point when checking the picker.
const FAKE_DEVICES = {
  ok: true, default_output: 'Speakers (Realtek Audio)', default_input: 'Microphone (USB Headset)',
  outputs: [{ name: 'Speakers (Realtek Audio)', default: true }, { name: 'Headphones (USB Headset)' }],
  inputs: [{ name: 'Microphone (USB Headset)', default: true }, { name: 'Microphone Array (Realtek Audio)' }],
};

app.whenReady().then(async () => {
  const devices = process.env.REAL_DEVICES ? realDeviceList() : FAKE_DEVICES;
  console.log('  device list ok:', devices.ok,
    '| outputs', (devices.outputs || []).length, '| inputs', (devices.inputs || []).length);

  const win = new BrowserWindow({
    width: 1100, height: 800, show: true, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'dashboard.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  const meeting = store.blankMeeting('preview');
  // A made-up meeting, so nothing real appears in a screenshot.
  Object.assign(meeting.brief, {
    title: 'Discovery call - Brightside Bakery', kind: 'client call', company: 'Brightside Bakery',
    role: 'Web designer and local SEO', otherSide: 'Sam, the owner',
    goal: 'Agree a website rebuild and a first month of local SEO',
    background: [
      'They have 3 shops and a 2015 website that is not mobile friendly.',
      'My price: 1,200 for the rebuild, then 300 a month for SEO. Two weeks to launch.',
      'Past work: rebuilt a cafe site that went from 40 to 170 calls a month.',
      'NOTE - DON\'T SAY: my floor is 1,000. Only offer it if they push twice.',
    ].join('\n'),
    terms: ['Google Business Profile', 'local SEO', 'Core Web Vitals'],
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', () => store.getSettings());
  ipcMain.handle('state', () => ({ listening: false }));
  ipcMain.handle('meeting:list', () => [{ id: 'preview', title: meeting.brief.title, createdAt: meeting.createdAt, turns: 0 }]);
  ipcMain.handle('meeting:get', () => meeting);
  ipcMain.handle('meeting:create', () => meeting);
  ipcMain.handle('meeting:save', () => meeting);
  ipcMain.handle('devices:list', () => devices);
  // CONNECT=1 shows the first-run state: nothing signed in yet.
  const signedIn = !process.env.CONNECT;
  ipcMain.handle('ai:status', () => ({
    claude: { installed: true, signedIn }, chatgpt: { installed: true, signedIn: false },
    use: 'claude', ready: signedIn,
  }));
  ipcMain.handle('devices:select', () => ({}));
  ipcMain.handle('devices:testSpeaker', () => ({
    ok: true, which: 'speaker', device: devices.default_output, peak: 0.2589,
    detail: 'Tone played and the loopback heard it. Meeting audio will be transcribed.',
  }));
  ipcMain.handle('devices:testMic', () => ({ ok: true, which: 'mic', peak: 0.14, detail: 'Heard you clearly.' }));
  for (const ch of ['doctor', 'open:folder', 'brain:summarise', 'brain:clarify', 'export:docx',
                    'listen:start', 'listen:stop', 'note:add', 'meeting:delete']) {
    ipcMain.handle(ch, () => ({ ok: true }));
  }

  await win.loadFile(path.join(__dirname, '..', 'src', 'dashboard', 'index.html'));
  const wc = win.webContents;
  await new Promise((r) => setTimeout(r, 2500));

  // Open the Settings tab and show a sample test result.
  await wc.executeJavaScript(`
    document.querySelector('#tabs button[data-tab="settings"]').click();
    document.getElementById('dTestSpeaker').click();
    true;
  `);
  await new Promise((r) => setTimeout(r, 1500));

  const chosen = await wc.executeJavaScript(`
    ({
      outputs: [...document.getElementById('dOutput').options].map(o => o.textContent),
      inputs: [...document.getElementById('dInput').options].map(o => o.textContent),
      liveModel: document.getElementById('sModel').value,
      deepModel: document.getElementById('sDeepModel').value,
      result: document.getElementById('dResult').textContent.trim(),
    })
  `);
  console.log('  speaker dropdown :', chosen.outputs.join(' | '));
  console.log('  mic dropdown     :', chosen.inputs.join(' | '));
  console.log('  live model       :', chosen.liveModel);
  console.log('  prep/summary     :', chosen.deepModel);
  console.log('  test result shown:', chosen.result.slice(0, 90));

  win.show(); win.focus();
  await new Promise((r) => setTimeout(r, 800));
  const img = await wc.capturePage();
  const out = path.join(__dirname, '..', 'data', 'dashboard-preview.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('  saved', out);

  // And the Brief tab, where a meeting is prepared. A window that is behind
  // others is not repainted, and capturePage() then hands back the previous
  // frame: the "brief" picture came out as a second copy of Settings. So wait
  // for two real frames, force a repaint, and refuse to save a duplicate.
  await wc.executeJavaScript(`document.querySelector('#tabs button[data-tab="brief"]').click(); true;`);
  win.show(); win.focus();
  let brief = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    wc.invalidate();
    await new Promise((r) => setTimeout(r, 600));
    brief = await wc.capturePage();
    if (!brief.toPNG().equals(img.toPNG())) break;
    brief = null;
  }
  if (!brief) { console.error('  FAILED: the Brief capture never differed from Settings'); app.exit(1); return; }
  const out2 = path.join(__dirname, '..', 'data', 'dashboard-brief.png');
  fs.writeFileSync(out2, brief.toPNG());
  console.log('  saved', out2);
  app.exit(0);
});
