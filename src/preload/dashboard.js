'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['state', 'devices', 'error', 'turn', 'note', 'summary', 'companion', 'share', 'share-hidden'];

contextBridge.exposeInMainWorld('copilot', {
  on(channel, fn) {
    if (!EVENTS.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  state: () => ipcRenderer.invoke('state'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (p) => ipcRenderer.invoke('settings:save', p),
  listMeetings: () => ipcRenderer.invoke('meeting:list'),
  getMeeting: (id) => ipcRenderer.invoke('meeting:get', id),
  createMeeting: () => ipcRenderer.invoke('meeting:create'),
  saveMeeting: (m) => ipcRenderer.invoke('meeting:save', m),
  deleteMeeting: (id) => ipcRenderer.invoke('meeting:delete', id),
  startListening: (id) => ipcRenderer.invoke('listen:start', id),
  stopListening: () => ipcRenderer.invoke('listen:stop'),
  summarise: (id) => ipcRenderer.invoke('brain:summarise', id),
  clarify: (brief) => ipcRenderer.invoke('brain:clarify', brief),
  addNote: (t) => ipcRenderer.invoke('note:add', t),
  exportDocx: (id) => ipcRenderer.invoke('export:docx', id),
  doctor: () => ipcRenderer.invoke('doctor'),
  companionInfo: () => ipcRenderer.invoke('companion:info'),
  companionToggle: (on) => ipcRenderer.invoke('companion:toggle', on),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  testSpeaker: (output) => ipcRenderer.invoke('devices:testSpeaker', output),
  testMic: (opts) => ipcRenderer.invoke('devices:testMic', opts),
  selectDevices: (sel) => ipcRenderer.invoke('devices:select', sel),
  openFolder: () => ipcRenderer.invoke('open:folder'),
  resetOverlay: () => ipcRenderer.invoke('overlay:reset'),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSignIn: (which) => ipcRenderer.invoke('ai:signin', which),
  aiUse: (provider) => ipcRenderer.invoke('ai:use', provider),
});
