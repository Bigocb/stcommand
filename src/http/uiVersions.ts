import { Router } from "express";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * The UI versions this server knows how to serve, newest concept last.
 * `v2` is the default and is served at `/` by the static middleware, so it
 * is not routed here — but it is listed because the switcher needs to
 * offer it as a destination, and because escaping back to it is how an
 * operator recovers from a half-finished newer version.
 */
export const UI_VERSIONS = ["v2", "v3", "v4", "v5"] as const;
export type UiVersion = (typeof UI_VERSIONS)[number];

/** Everything but v2 — the ones that need an explicit route. */
const ROUTED = UI_VERSIONS.filter((v) => v !== "v2");

/**
 * Serves `/v3`, `/v4`, `/v5` from `public/vN.html`.
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
export function cacheHeaders(path: string): Record<string, string> | undefined {
  if (path.endsWith(".html")) return { "Cache-Control": "no-cache" };
  if (path.includes("/fonts/")) return { "Cache-Control": "public, max-age=31536000, immutable" };
  if (path.includes("/shared/")) return { "Cache-Control": "public, max-age=300" };
  // Each version's own CSS and JS. Splitting them out of the HTML was done
  // so a browser could cache them instead of re-fetching ~250KB inline on
  // every load — which it will not do unless it is told to. Same short
  // window and same reason as the shared modules: no content hash in the
  // filename, so a deploy replaces v3.js in place and the gap where new
  // HTML can pair with old code has to stay small.
  if (/\/v[2-9]\.(css|js)$/.test(path)) return { "Cache-Control": "public, max-age=300" };
  return undefined;
}
