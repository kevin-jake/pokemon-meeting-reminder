// @ts-check
'use strict';
// Sandboxed preload: only contextBridge/ipcRenderer are available here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  /** @param {(payload: unknown) => void} cb */
  onScene(cb) {
    ipcRenderer.on('scene:play', (_event, payload) => cb(payload));
  },
  /** @param {() => void} cb */
  onStop(cb) {
    ipcRenderer.on('scene:stop', () => cb());
  },
  /** @param {(m: { url: string, loop: boolean, volume: number }) => void} cb */
  onMusic(cb) {
    ipcRenderer.on('music:play', (_event, m) => cb(m));
  },
  /** @param {() => void} cb */
  onMusicStop(cb) {
    ipcRenderer.on('music:stop', () => cb());
  },
  musicStarted() {
    ipcRenderer.send('music:started');
  },
  musicDone() {
    ipcRenderer.send('music:done');
  },
  sceneDone() {
    ipcRenderer.send('scene:done');
  },
  dismiss() {
    ipcRenderer.send('scene:dismiss');
  },
  /** Opens the current meeting's link (main knows which) and ends the reminder. */
  join() {
    ipcRenderer.send('scene:join');
  },
  /** @param {boolean} clickable */
  setClickable(clickable) {
    ipcRenderer.send('overlay:clickable', clickable);
  },
  /**
   * The cursor is resting on the Pokémon or its banner, so the pass is held in place.
   * @param {boolean} held
   */
  setHeld(held) {
    ipcRenderer.send('overlay:held', held);
  },
});
