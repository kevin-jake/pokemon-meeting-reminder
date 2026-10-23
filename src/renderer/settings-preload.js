// @ts-check
'use strict';
// Sandboxed preload: only contextBridge/ipcRenderer are available here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  /** Everything the page renders; see SettingsState in main/settings-window.js. */
  getState: () => ipcRenderer.invoke('settings:state'),
  /** @param {object} patch  partial settings; main validates the keys */
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
  /** @param {string} name @param {unknown} [arg] */
  action: (name, arg) => ipcRenderer.invoke('settings:action', name, arg),
  /** @param {() => void} cb  called when main changed something the page shows */
  onChanged(cb) {
    ipcRenderer.on('settings:changed', () => cb());
  },
  /** @param {(section: string) => void} cb  main asks for a pane (e.g. the tray's custom mute) */
  onSection(cb) {
    ipcRenderer.on('settings:section', (_event, section) => cb(String(section)));
  },
});
