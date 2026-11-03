/*
 * boot-watchdog.js — turn a silent module-load failure into an explanation.
 *
 * If the ES module graph fails to evaluate (one stale cached module whose
 * exports no longer match its importers is enough), NOTHING runs: no error is
 * shown, no handler fires, and the page sits on its initial "Loading…" text
 * forever — surviving reloads, because the browser keeps serving the same
 * cached files. That is indistinguishable from a hang unless we say so.
 *
 * A classic script (not a module) so it runs even when the module graph is
 * broken, and external rather than inline so the page stays CSP-friendly.
 */
(function () {
  'use strict';

  var GRACE_MS = 8000;

  window.addEventListener('error', function (ev) {
    // Module evaluation/resolution errors surface here with no filename help,
    // so record whatever we get for the message below.
    if (ev && (ev.message || ev.error)) {
      window.__odBootError = String((ev.error && ev.error.message) || ev.message);
    }
  });

  setTimeout(function () {
    if (document.body && document.body.dataset.odBoot === 'started') return;

    var status = document.getElementById('statusLine');
    var gate = document.getElementById('gateBanner');
    var detail = window.__odBootError ? ' (' + window.__odBootError + ')' : '';

    if (status) status.textContent = 'The app failed to start.';
    if (!gate) return;

    gate.textContent =
      'The app’s code did not load' + detail + '. This is usually a stale '
      + 'browser cache holding a mix of old and new files — a normal reload '
      + 'will not fix it.';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'odapp__btn';
    btn.style.marginLeft = '0.75rem';
    btn.textContent = 'Reload, bypassing the cache';
    btn.addEventListener('click', function () {
      // A fresh query string defeats any cached entry for this URL; the module
      // graph is then re-fetched from the server.
      var url = location.pathname + '?cb=' + Date.now();
      location.replace(url);
    });
    gate.appendChild(btn);
    gate.hidden = false;
  }, GRACE_MS);
})();
