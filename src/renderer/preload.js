// @ts-check
'use strict';
// Sandboxed preload: only contextBridge/ipcRenderer are available here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  /** @param {(payload: unknown) => void} cb */
  onScene(cb) {
    ipcRenderer.on('scene:play', (_event, payload) => cb(payload));
  },
  sceneDone() {
    ipcRenderer.send('scene:done');
  },
});
