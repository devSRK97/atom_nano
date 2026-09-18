"use strict";
/* Determinism for the embedded test browser. Runs in the page's main world
 * (contextIsolation:false) BEFORE page scripts, so a test sees a frozen clock and
 * a seeded RNG — killing the largest source of e2e flake at the root (both model
 * consults' #2 risk). Network is blocked separately in the main process via
 * session.webRequest. This preload is loaded ONLY by the test-only BrowserWindow.
 */
(function () {
  try {
    var FIXED = 1577836800000; // 2020-01-01T00:00:00.000Z — a stable "now"
    Date.now = function () { return FIXED; };

    var seed = 0x2545f491 >>> 0;
    function rng() { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed; }
    Math.random = function () { return rng() / 0x7fffffff; };

    if (window.performance) { var pc = 0; window.performance.now = function () { return (pc += 16); }; }

    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      window.crypto.getRandomValues = function (arr) { for (var i = 0; i < arr.length; i++) arr[i] = rng() & 0xff; return arr; };
    }
  } catch (e) { /* determinism is best-effort */ }
})();
