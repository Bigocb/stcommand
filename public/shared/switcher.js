/**
 * The version picker, shared by every UI.
 *
 * Four interfaces against one engine is only sane if moving between them is
 * trivial — otherwise a half-finished v4 becomes a trap rather than an
 * experiment. This is also the escape hatch: whatever state a newer version
 * gets itself into, `?ui=v2` returns to the one that works.
 *
 * It brings its own styling rather than inheriting each version's, for two
 * reasons. It must look the same in all four so it stays recognisable while
 * everything around it changes, and it must render before a version's own
 * CSS is trusted to exist — a version mid-build is exactly when you most
 * need to leave it.
 */

const VERSIONS = [
  { id: "v2", path: "/", label: "v2", title: "Current interface" },
  { id: "v3", path: "/v3", label: "v3", title: "Refined Bridge" },
  { id: "v4", path: "/v4", label: "v4", title: "Deep Field" },
  { id: "v5", path: "/v5", label: "v5", title: "Mission Control" },
];

const STORAGE_KEY = "ui-version";

/** Which version this document is, derived from its own path. */
export function currentVersion() {
  const m = window.location.pathname.match(/^\/(v[345])\b/);
  return m ? m[1] : "v2";
}

/**
 * Remembered preference, or null.
 *
 * Wrapped because storage access throws outright in some privacy modes, and
 * a picker is never worth breaking a page load over.
 */
export function preferredVersion() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return VERSIONS.some((x) => x.id === v) ? v : null;
  } catch (_) {
    return null;
  }
}

function remember(id) {
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch (_) { /* not worth failing over */ }
}

/**
 * Honour `?ui=vN` and any remembered preference, before the page renders.
 *
 * `?ui=` always wins and is also recorded, so a link into a version is
 * sticky the way choosing it from the picker is. The remembered preference
 * only redirects away from `/` — never from an explicit `/v4`, which would
 * make a typed URL unreachable, and never in a loop, since it only fires
 * when the destination differs from where we already are.
 *
 * Returns true if it navigated, so a caller can stop booting.
 */
export function applyVersionPreference() {
  const url = new URL(window.location.href);
  const asked = url.searchParams.get("ui");
  const here = currentVersion();

  if (asked && VERSIONS.some((v) => v.id === asked)) {
    remember(asked);
    if (asked !== here) {
      window.location.replace(VERSIONS.find((v) => v.id === asked).path);
      return true;
    }
    // Already in the right place — drop the parameter so a refresh is clean.
    url.searchParams.delete("ui");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    return false;
  }

  const preferred = preferredVersion();
  if (preferred && preferred !== here && window.location.pathname === "/") {
    window.location.replace(VERSIONS.find((v) => v.id === preferred).path);
    return true;
  }
  return false;
}

/**
 * Render the picker into `host` (or a fixed corner element if omitted).
 *
 * Versions that do not exist yet are still offered: the route answers them
 * with a plain-language "not built yet" rather than a 404, which is more
 * useful than hiding the fact that they are planned.
 */
export function mountSwitcher(host) {
  const here = currentVersion();

  let el = host;
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:9998;";
    document.body.appendChild(el);
  }

  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Interface version");
  wrap.style.cssText =
    "display:inline-flex;gap:1px;background:rgba(20,24,30,.92);border:1px solid rgba(150,170,200,.28);" +
    "border-radius:5px;overflow:hidden;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;" +
    "letter-spacing:.08em;backdrop-filter:blur(4px);";

  for (const v of VERSIONS) {
    const b = document.createElement("a");
    b.href = v.path;
    b.textContent = v.label;
    b.title = v.title;
    const active = v.id === here;
    b.style.cssText =
      `padding:5px 9px;text-decoration:none;cursor:pointer;` +
      (active
        ? "background:rgba(90,169,255,.22);color:#9ecbff;"
        : "background:transparent;color:#8b97a6;");
    if (active) b.setAttribute("aria-current", "page");
    b.addEventListener("click", () => remember(v.id));
    wrap.appendChild(b);
  }
  el.appendChild(wrap);
  return el;
}
