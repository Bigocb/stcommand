/**
 * Sends a phone straight to Tower ("/m" — the from-scratch mobile app,
 * see docs/mobile-app-design.md) instead of the desktop dashboard at "/".
 *
 * Deliberately NOT an ES module, unlike everything else under shared/.
 * `<script type="module">` is deferred — it runs after the document has
 * already been parsed, which is exactly late enough for a phone to see a
 * flash of the desktop layout before this fires. A plain classic
 * `<script src="...">` (no type/defer/async) blocks parsing at the point
 * it appears, so loading this as the very first thing in <head> — before
 * any stylesheet or body content — means the redirect can happen before
 * anything desktop-shaped ever paints. That constraint is also why this
 * duplicates switcher.js's shape instead of importing anything from it:
 * switcher.js exports ES module functions, which the same timing problem
 * rules out here.
 *
 * Separate localStorage key from switcher.js's "ui-version" (which picks
 * between desktop UI *versions*, v5/v6) — this picks a different axis
 * entirely (which *surface*, desktop vs. Tower), so the two must not
 * collide or fight over one key.
 */
(function () {
  if (window.location.pathname !== "/") return;

  var STORAGE_KEY = "ui-surface";

  function remembered() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      return v === "desktop" || v === "m" ? v : null;
    } catch (_) {
      return null;
    }
  }

  function remember(v) {
    try { window.localStorage.setItem(STORAGE_KEY, v); } catch (_) { /* not worth failing over */ }
  }

  // A phone or the like, not a resizable desktop window — checked once by
  // device (User-Agent), not by viewport width. A viewport check would
  // false-positive on a narrow desktop browser window and ping-pong on
  // resize; a UA check does neither. iPad is deliberately excluded —
  // modern iPadOS Safari reports as desktop Safari by default, and
  // Tower's design is for phone-in-hand, one-handed use, not tablet
  // width. `?ui=m` still reaches Tower from an iPad or a desktop browser
  // for anyone who wants it.
  function isMobileDevice() {
    return /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);
  }

  var url = new URL(window.location.href);
  var asked = url.searchParams.get("ui");

  if (asked === "desktop" || asked === "m") {
    remember(asked);
    if (asked === "m") { window.location.replace("/m"); return; }
    // Already staying on desktop — drop the parameter so a refresh is clean.
    url.searchParams.delete("ui");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    return;
  }

  var choice = remembered();
  if (choice === "desktop") return;
  if (choice === "m" || isMobileDevice()) window.location.replace("/m");
})();
