// Fetch wrapper — no DOM, no shared app state.
// See docs/ui-versions-plan.md §3.

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
