// @ts-check
// Runs in the page's own JavaScript world (manifest "world": "MAIN") on
// Outlook / Teams, before their scripts. It only observes:
//  - JSON responses of fetch / XMLHttpRequest, scanned for calendar items;
//  - Notification / showNotification calls (the toasts these sites raise).
// Findings go to relay.js via window.postMessage; nothing here talks to the
// network or changes what the page sees.
(() => {
  'use strict';
  const w = /** @type {any} */ (window);
  const extract = w.__pmrExtract;
  if (!extract || w.__pmrHooked) return;
  w.__pmrHooked = true;

  const MAX_TEXT = 8 * 1024 * 1024;
  /** Cheap pre-check before JSON.parse: calendar items always carry one of these. */
  const START_HINT = /"(?:Start|start|StartDate|startDate|StartTime|startTime|startDateTime)"\s*:/;

  /** @param {Record<string, unknown>} msg */
  const post = (msg) => window.postMessage({ __pmr: 1, ...msg }, location.origin);

  /** Path plus OWA's ?action=, for the extension's capture log. @param {string} url */
  function describe(url) {
    try {
      const u = new URL(url, location.href);
      const action = u.searchParams.get('action');
      return `${u.host}${u.pathname}${action ? `?action=${action}` : ''}`;
    } catch {
      return '';
    }
  }

  /** @param {unknown} json @param {string} url */
  function inspectJson(json, url) {
    const items = extract.extractMeetings(json, { now: Date.now() });
    if (items.length) post({ type: 'meetings', items, url: describe(url) });
  }

  /** @param {unknown} text @param {string} url */
  function inspectText(text, url) {
    if (typeof text !== 'string' || text.length > MAX_TEXT || !START_HINT.test(text)) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    inspectJson(json, url);
  }

  /** @param {string | null} contentType @param {string | null} length */
  const worthReading = (contentType, length) => /json/i.test(contentType ?? '') && !(Number(length) > MAX_TEXT);

  const origFetch = w.fetch;
  if (typeof origFetch === 'function') {
    w.fetch = function (/** @type {any[]} */ ...args) {
      const pending = origFetch.apply(this, args);
      pending.then(
        (/** @type {Response} */ res) => {
          try {
            if (!worthReading(res.headers.get('content-type'), res.headers.get('content-length'))) return;
            res
              .clone()
              .text()
              .then((t) => inspectText(t, res.url), () => {});
          } catch {
            // Never let observation break the page.
          }
        },
        () => {},
      );
      return pending;
    };
  }

  const xhr = XMLHttpRequest.prototype;
  const origSend = xhr.send;
  xhr.send = function (/** @type {any[]} */ ...args) {
    this.addEventListener('load', () => {
      try {
        if (!worthReading(this.getResponseHeader('content-type'), this.getResponseHeader('content-length'))) return;
        if (this.responseType === '' || this.responseType === 'text') inspectText(this.responseText, this.responseURL);
        else if (this.responseType === 'json' && this.response) inspectJson(this.response, this.responseURL);
      } catch {
        // Never let observation break the page.
      }
    });
    return origSend.apply(this, /** @type {any} */ (args));
  };

  /** @param {unknown} title @param {any} options */
  function toast(title, options) {
    try {
      post({
        type: 'toast',
        title: String(title ?? '').slice(0, 300),
        body: String(options?.body ?? '').slice(0, 1000),
      });
    } catch {
      // Never let observation break the page.
    }
  }

  const OrigNotification = w.Notification;
  if (typeof OrigNotification === 'function') {
    // Same prototype and statics (permission, requestPermission), so
    // instanceof checks and permission prompts behave as before.
    const Wrapped = function Notification(/** @type {string} */ title, /** @type {any} */ options) {
      toast(title, options);
      return new OrigNotification(title, options);
    };
    Wrapped.prototype = OrigNotification.prototype;
    Object.setPrototypeOf(Wrapped, OrigNotification);
    w.Notification = Wrapped;
  }

  const registration = w.ServiceWorkerRegistration?.prototype;
  if (registration && typeof registration.showNotification === 'function') {
    const origShow = registration.showNotification;
    registration.showNotification = function (/** @type {string} */ title, /** @type {any} */ options) {
      toast(title, options);
      return origShow.call(this, title, options);
    };
  }
})();
