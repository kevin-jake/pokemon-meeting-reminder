// @ts-check
'use strict';
const path = require('node:path');
const { app } = require('electron');

/**
 * Root of the vendored media (sprites, cries, bgm). In a packaged build it is
 * copied next to app.asar via electron-builder extraResources; in dev it is
 * the repo's media/ folder. The overlay page is loaded with loadFile, so these
 * file:// URLs are same-origin and need no webSecurity changes.
 */
function mediaDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'media') : path.join(app.getAppPath(), 'media');
}

module.exports = { mediaDir };
