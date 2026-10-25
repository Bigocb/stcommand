import { Router, type Response } from "express";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname, relative, sep } from "node:path";

/**
 * The UI versions this server actively offers. `v6` (the 3D map) is the
 * default and is served at `/` by the static middleware, so it is not
 * routed here.
 *
 * v2/v3/v4 were retired once v6 became the default — their files are
 * still on disk (public/v2.html etc.), so a direct link to
 * `/v2.html`/`/v3.html`/`/v4.html` still works, but they no longer have a
 * clean `/vN` route or a switcher entry, and are not listed here.
 */
export const UI_VERSIONS = ["v5", "v6"] as const;
export type UiVersion = (typeof UI_VERSIONS)[number];

/** Everything but v6 — the ones that need an explicit route. */
const ROUTED = UI_VERSIONS.filter((v) => v !== "v6");

/**
 * Serves `/v5` from `public/vN.html`.
 *
 * Mounted before `express.static` so these paths resolve whether or not a
 * trailing `.html` is typed, and so a version that does not exist yet
 * answers with something an operator can act on rather than the static
 * middleware's bare 404. That case is real for most of this work's life:
 * the routes land in Phase 1 but the files arrive one phase at a time.
 *
 * Kept as its own router rather than a loop inside `main()` so it can be
 * tested without booting a tenant registry, a database, or the fleet.
 */
export function createUiVersionRouter(publicDir: string): Router {
  const router = Router();

  for (const version of ROUTED) {
    router.get(`/${version}`, (_req, res) => {
      const file = join(resolve(publicDir), `${version}.html`);
      if (!existsSync(file)) {
        res.status(404).type("text/plain").send(
          `${version} is not built yet — it is a planned UI version (see docs/ui-versions-plan.md).\n` +
            `The current interface is at /.`,
        );
        return;
      }
      // Same policy express.static applies to the HTML it serves — see
      // cacheHeaders(). sendFile() does not go through that middleware's
      // setHeaders hook, so without this /v3 answered `max-age=0` while /
      // answered `no-cache`. Both force revalidation, so nothing was at
      // risk, but two paths serving the same kind of file under two
      // different rules is a thing that only stays harmless by luck.
      res.set(cacheHeaders(file) ?? {});
      res.sendFile(file);
    });
  }

  return router;
}

/**
 * Cache policy for the shared frontend.
 *
 * The HTML must not be cached: it is the thing that names which module
 * versions to load, so a stale copy pins a browser to superseded modules
 * after a deploy. The fonts and shared modules are the opposite — they are
 * fetched by every version on every load, and re-downloading ~99KB of
 * woff2 per navigation would give back exactly what extracting them won.
 *
 * The modules get a short max-age rather than a long one because they have
 * no content hash in their filenames; a deploy changes `shared/store.js` in
 * place. Five minutes bounds how long a browser can pair new HTML with old
 * modules, which is the failure this ordering has to keep survivable.
 */
/**
 * Scripts and styles are revalidated on every load (ETag/Last-Modified → a tiny
 * 304 when nothing changed) instead of cached for five minutes. The 5-minute
 * window was the original compromise, but it fails badly in practice: after a
 * deploy a phone kept the OLD m.js for up to five minutes (a visible redesign
 * "didn't change"), and worse, entry points and shared modules expire
 * independently, so new `m.js` can import a name that a cached old
 * `shared/domain.js` doesn't export — a hard module-load error that blanks the
 * app. No content hash is in the filenames, so revalidation is the safe default;
 * fonts, which never change, stay immutable.
 */
const REVALIDATE = "no-cache";

export function cacheHeaders(path: string): Record<string, string> | undefined {
  if (path.endsWith(".html")) return { "Cache-Control": "no-cache" };
  if (path.includes("/fonts/")) return { "Cache-Control": "public, max-age=31536000, immutable" };
  // A service worker must be re-checked on every load, or a browser keeps running a superseded one.
  if (/\/sw-[a-z]+\.js$/.test(path)) return { "Cache-Control": "no-cache" };
  if (path.includes("/shared/")) return { "Cache-Control": REVALIDATE };
  // Each version's own CSS and JS. Splitting them out of the HTML was done
  // so a browser could cache them instead of re-fetching ~250KB inline on
  // every load — which it will not do unless it is told to. Same short
  // window and same reason as the shared modules: no content hash in the
  // filename, so a deploy replaces v3.js in place and the gap where new
  // HTML can pair with old code has to stay small.
  if (/\/v[2-9]\.(css|js)$/.test(path)) return { "Cache-Control": REVALIDATE };
  // Tower (the /m mobile app) and Deck (the /deck desktop redesign) aren't
  // part of the v2-v9 version lineage above — same reasoning applies (their
  // CSS/JS get overwritten in place on deploy with no content hash), so they
  // get explicit matches rather than folding into that regex's character class.
  if (/\/(m|deck)\.(css|js)$/.test(path)) return { "Cache-Control": REVALIDATE };
  return undefined;
}

/**
 * A short stamp derived from the frontend JS/CSS assets, so the HTML can name
 * them with `?v=<stamp>` that changes exactly when they change. This is what
 * makes a deploy visible immediately even behind a CDN that ignores the
 * origin's `no-cache` — e.g. Cloudflare's default 4-hour Browser Cache TTL,
 * which rewrites `no-cache` to `max-age=14400` for .js/.css. Changing the URL
 * on deploy forces both the CDN and the browser to fetch fresh.
 */
export function assetStamp(publicDir: string): string {
  const h = createHash("sha1");
  const walk = (dir: string): void => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "vendor") walk(p);
        continue;
      }
      if (!/\.(js|css)$/.test(e.name)) continue;
      try {
        // Hash contents, not mtime: a git pull touches mtimes even when a file
        // is unchanged, which would churn the stamp (and force a re-fetch) for
        // no reason. Content changes only when the asset actually changes.
        h.update(e.name).update(readFileSync(p));
      } catch {
        /* ignore unreadable entries */
      }
    }
  };
  walk(publicDir);
  return h.digest("hex").slice(0, 10);
}

/** The `/shared/...` module URLs under `sharedDir`, sorted (js only, vendor files excluded). */
export function sharedModuleUrls(sharedDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "vendor") walk(p);
      } else if (e.name.endsWith(".js")) {
        out.push("/shared/" + relative(sharedDir, p).split(sep).join("/"));
      }
    }
  };
  walk(sharedDir);
  return out.sort();
}

/**
 * An import map that stamps every shared module with `?v=<stamp>`. The HTML stamps its own script tags, but a module's
 * `import ... from "/shared/domain.js"` is resolved by the browser with no stamp, so behind a CDN that holds `.js` for four hours
 * a new `m.js` could pair with an old `domain.js` and fail to link ("does not provide an export named ...") — a blank app
 * (2026-10-25, right after `walletForHolds` was added). The map rewrites those imports, relative ones included, to the stamped URL.
 */
export function importMapTag(urls: readonly string[], stamp: string): string {
  const imports = Object.fromEntries(urls.map((u) => [u, `${u}?v=${stamp}`]));
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

const sharedUrlCache = new Map<string, string[]>();

/**
 * Serve an HTML page with every local `.js`/`.css` reference stamped with
 * `?v=<stamp>`, and `Cache-Control: no-cache`. External (CDN) URLs and
 * non-js/css assets are left untouched.
 */
export function serveHtml(res: Response, file: string, stamp: string): void {
  let html: string;
  try {
    html = readFileSync(file, "utf8");
  } catch {
    res.status(404).type("text/plain").send("not found");
    return;
  }
  html = html.replace(
    /(\s(?:src|href)=")(\/[^"]+\.(?:js|css))(")/g,
    (_m, pre, url, post) => `${pre}${url}?v=${stamp}${post}`,
  );
  // An import map must come before the first module script.
  const first = html.search(/<script[^>]*type="module"/);
  if (first !== -1) {
    const sharedDir = join(dirname(file), "shared");
    if (!sharedUrlCache.has(sharedDir)) sharedUrlCache.set(sharedDir, sharedModuleUrls(sharedDir));
    const urls = sharedUrlCache.get(sharedDir)!;
    if (urls.length) html = html.slice(0, first) + importMapTag(urls, stamp) + "\n" + html.slice(first);
  }
  res.set("Cache-Control", "no-cache");
  res.type("html").send(html);
}
