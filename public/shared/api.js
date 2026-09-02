/**
 * The transport layer every UI version talks to the engine through.
 *
 * Deliberately headless. It knows how to make a request and how to notice a
 * dead session; it does not know what a login gate looks like. That split is
 * what lets v2/v3/v4/v5 share one implementation while each renders the
 * consequences their own way.
 */

/**
 * The unpatched fetch, captured before `onUnauthorized()` can wrap it.
 *
 * This module's body runs before any importer's does, so this is always the
 * genuine browser implementation regardless of import order. Callers use it
 * to opt out of the global 401 handling — the session probe at boot is the
 * real case: it *expects* a 401 for a visitor with no cookie and wants to
 * show the gate itself, rather than having the interceptor show it a
 * fraction earlier for what is a completely normal first visit.
 */
export const nativeFetch = window.fetch.bind(window);

/**
 * A JSON request against the engine. Throws on a non-2xx, preferring the
 * server's own `{ error }` message over the bare status line — those
 * messages are written to be shown to the operator (see the dashboard
 * routes), so discarding them in favour of "400 Bad Request" would throw
 * away the useful half. The raw Response is attached as `err.response` for
 * callers that need to branch on status.
 */
export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error) detail = j.error;
    } catch (_) {}
    const err = new Error(detail);
    err.response = res;
    throw err;
  }
  return res.json();
}

/**
 * Patch `window.fetch` so an expired session is caught wherever it happens,
 * not only in calls that remembered to check.
 *
 * `handler` is supplied by the version because showing the gate is a
 * rendering decision — this module has no opinion about what that looks
 * like. Scoped to `/api/*` and excluding `/api/gate/*`: a 401 from the gate
 * routes means "those credentials were wrong", which the form itself
 * reports inline, and treating it as a dead session would replace a useful
 * error with a redundant one.
 */
export function onUnauthorized(handler) {
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    return nativeFetch(input, init).then((res) => {
      if (res.status === 401 && url.startsWith("/api/") && !url.startsWith("/api/gate/")) {
        handler("Session expired — sign in again.");
      }
      return res;
    });
  };
}
