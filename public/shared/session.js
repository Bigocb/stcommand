/**
 * Getting in and out of an account: the gate calls, and the one piece of
 * onboarding that is knowledge rather than presentation.
 *
 * Deliberately thin. Most of what used to be "the session code" in v2 is
 * really about *which element shows the error* and *what the gate looks
 * like*, and none of that survives into v3/v4/v5 — they each render the
 * gate their own way. What does survive is the shape of the calls, the
 * distinction between a returning tenant and a brand-new one, and the
 * retry behaviour below.
 *
 * So these functions return values and throw errors; they never touch the
 * DOM. The version decides what to do with either.
 */

/** POST a gate route and normalise its failure into a throwable message. */
async function gate(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Server error (${res.status})`);
  return json;
}

/**
 * Sign in with an existing SpaceTraders token.
 * Resolves `{ isNewTenant, onboardingPending, agentSymbol }`. Decide the
 * next screen from `onboardingPending`, never from `isNewTenant`: the
 * former is the durable tenants.onboarding_pending column (the same state
 * that keeps the fleet paused), the latter is a one-shot edge that is gone
 * the moment this tab is refreshed. See probeSession().
 */
export function login(token) {
  return gate("/api/gate/login", { token });
}

/**
 * What screen should this page load render?
 *
 * Answers all three questions a cold load has — is there a live session,
 * who is it, and does this tenant still owe us onboarding — from one cheap
 * gate call that never touches the engine. `/api/*` would answer the first
 * two, but only after blocking on that tenant's full engine boot, and it
 * cannot answer the third at all.
 *
 * Resolves `{ authenticated: false }` for a missing or expired cookie, and
 * for a server that cannot be reached: both mean "show the sign-in gate,"
 * and the gate is a safe thing to be wrong about (signing in again costs a
 * paste), where skipping onboarding is not (the fleet then sits paused
 * with nothing on screen saying why).
 */
export async function probeSession() {
  try {
    const res = await fetch("/api/gate/session");
    if (!res.ok) return { authenticated: false };
    const json = await res.json();
    return { authenticated: true, agentSymbol: json.agentSymbol, onboardingPending: !!json.onboardingPending };
  } catch (_) {
    return { authenticated: false };
  }
}

/** Register a brand-new agent, then sign in as it. Same shape as login(). */
export function register(agentSymbol, faction, accountToken) {
  return gate("/api/gate/register", { agentSymbol, faction, accountToken });
}

/**
 * End the session. Never throws: the cookie is being abandoned either way,
 * so a failed request should not keep an operator staring at a dashboard
 * they have already logged out of.
 */
export async function logout() {
  try {
    await fetch("/api/gate/logout", { method: "POST" });
  } catch (_) { /* leaving regardless */ }
}

/**
 * fetch() with a deadline of our own.
 *
 * Every attempt has to be bounded or the retry loop below is decorative:
 * /api/doctrine sits behind registry.getOrCreate(), which does not answer
 * 503 while an engine boots — it holds the request open until the boot
 * finishes. So attempt 1 never settled, the remaining attempts never ran,
 * and onboarding stayed on "Loading standing orders…" indefinitely, with
 * no error and no way forward. That is the reported bug.
 *
 * A plain AbortController with a real setTimeout, rather than
 * AbortSignal.timeout(): that helper's timer is unref'd, so it cannot be
 * the only thing an environment is waiting on — which is exactly the shape
 * of the test that proves this works.
 */
async function fetchWithDeadline(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The policy catalog to present during onboarding, retrying while the
 * tenant's engine is still starting.
 *
 * This is the part worth sharing rather than re-deriving per version. A
 * brand-new agent's first /api/* request is what triggers its full fleet
 * boot — live SpaceTraders calls for agent, ships and galaxy — and
 * resolveTenant blocks on that before this route runs at all. A 503 here
 * usually means "still booting", not "broken", so retrying with backoff is
 * correct where failing fast would strand a new captain on an error for
 * something that resolves itself in seconds.
 *
 * An empty catalog is treated as a failure too: it means the response came
 * from somewhere other than a ready engine, and rendering it would present
 * an empty checklist that silently adopts nothing.
 *
 * Throws once the attempts are exhausted; the caller shows that however it
 * likes.
 */
export async function fetchOnboardingCatalog({ attempts = 6, delayMs = (n) => n * 1000, timeoutMs = 12_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchWithDeadline("/api/doctrine", timeoutMs);
      if (!res.ok) throw new Error(`engine not ready yet (attempt ${attempt})`);
      const data = await res.json();
      if (!Array.isArray(data.catalog) || !data.catalog.length) throw new Error("empty catalog");
      return data.catalog;
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      await new Promise((r) => setTimeout(r, delayMs(attempt)));
    }
  }
  throw lastError ?? new Error("could not load the policy catalog");
}

/**
 * Confirm the operator's onboarding choices.
 *
 * `selections` must carry an entry for every catalog key — the server reads
 * a missing key as "not adopted", so a partial object silently switches
 * policies off rather than leaving them at their defaults.
 */
export async function completeOnboarding(selections) {
  const res = await fetch("/api/doctrine/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selections }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Server error (${res.status})`);
  return json;
}
