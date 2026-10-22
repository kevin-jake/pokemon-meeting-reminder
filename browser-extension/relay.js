// @ts-check
// Isolated-world half of the page hook: page-hook.js cannot use extension
// APIs, so it posts to the window and this forwards to the background worker.
'use strict';

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== window || !data || data.__pmr !== 1) return;
  if (data.type !== 'meetings' && data.type !== 'toast') return;
  try {
    chrome.runtime.sendMessage(data).catch(() => {});
  } catch {
    // The extension was reloaded; this tab keeps the old, orphaned script until it reloads.
  }
});
