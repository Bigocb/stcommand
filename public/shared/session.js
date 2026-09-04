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
 * Resolves `{ isNewTenant, agentSymbol }` — `isNewTenant` is true only when
 * this call actually created the tenant row, which is what decides between
 * showing onboarding and going straight to the dashboard.
 */
export function login(token) {
  return gate("/api/gate/login", { token });
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
export async function fetchOnboardingCatalog({ attempts = 5, delayMs = (n) => n * 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch("/api/doctrine");
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
