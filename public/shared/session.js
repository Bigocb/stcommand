// Login/register/logout/onboarding — the auth-gate flow described in
// docs/architecture-plan.md's session-cookie model. See docs/ui-versions-plan.md §3.
//
// boot() itself stays version-owned (it wires up each version's own render
// layer), so this module never calls it directly. A version's own bootstrap
// code registers it once via initSession({ onAuthenticated }) before the
// first login attempt can happen.

import { escapeAttr, escapeHtml } from "./domain.js";
import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

const ONBOARD_CATEGORY_LABEL = { trading: "Trading", fleet: "Fleet growth", risk: "Risk", ops: "Ops" };

export let authed = false;

let onAuthenticated = () => {};
export function initSession(handlers) {
  onAuthenticated = handlers.onAuthenticated ?? onAuthenticated;
}

export function showAuthGate(message) {
  authed = false;
  $("auth-err").textContent = message ?? "";
  $("reg-err").textContent = "";
  $("app-root").hidden = true;
  $("auth-gate").hidden = false;
  showLoginForm();
}

export function hideAuthGate() {
  authed = true;
  $("auth-gate").hidden = true;
  $("app-root").hidden = false;
}

export function showLoginForm() {
  $("auth-form-login").hidden = false;
  $("auth-form-register").hidden = true;
  $("auth-token").focus();
}

export function showRegisterForm() {
  $("auth-form-login").hidden = true;
  $("auth-form-register").hidden = false;
  $("reg-symbol").focus();
}

export async function tryLogin(token) {
  try {
    const res = await fetch("/api/gate/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Server error (${res.status})`);
    if (json.isNewTenant) showOnboarding();
    else { hideAuthGate(); onAuthenticated(); }
  } catch (err) {
    $("auth-err").textContent = err.message || "Could not reach the server.";
  }
}

export async function tryRegister(agentSymbol, faction, accountToken) {
  try {
    const res = await fetch("/api/gate/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSymbol, faction, accountToken }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Server error (${res.status})`);
    if (json.isNewTenant) showOnboarding();
    else { hideAuthGate(); onAuthenticated(); }
  } catch (err) {
    $("reg-err").textContent = err.message || "Could not reach the server.";
  }
}

export async function logout() {
  try {
    await fetch("/api/gate/logout", { method: "POST" });
  } finally {
    showAuthGate();
  }
}

export async function showOnboarding() {
  $("auth-gate").hidden = true;
  $("onboarding-gate").hidden = false;
  $("onboard-err").textContent = "";
  $("onboard-list").innerHTML = '<div class="empty">Loading standing orders…</div>';
  // Disabled until the real catalog renders — confirming while this list is
  // still empty would send an empty `selections` object, which
  // completeOnboarding() reads as "adopt nothing," silently turning off
  // every policy (including the cash floor) instead of leaving them at
  // their real defaults.
  $("onboard-confirm").disabled = true;
  // This is likely the very first /api/* call for a brand-new agent — the
  // resolveTenant middleware awaits the tenant's full fleet boot (live
  // SpaceTraders calls: agent, ships, galaxy) before this can even reach
  // the route, so a 503 "engine not ready" here is plausibly just "still
  // booting," not a real failure. Retry a few times with backoff before
  // showing an error, rather than dumping the captain on a blank screen or
  // a scary message for something that resolves itself in a few seconds.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch("/api/doctrine");
      if (!res.ok) throw new Error(`engine not ready yet (attempt ${attempt})`);
      const data = await res.json();
      if (!Array.isArray(data.catalog) || !data.catalog.length) throw new Error("empty catalog");
      renderOnboarding(data.catalog);
      return;
    } catch (e) {
      if (attempt === 5) {
        $("onboard-list").innerHTML = "";
        $("onboard-err").textContent = "Could not load standing orders — the fleet may still be starting up. Try refreshing in a few seconds.";
        return;
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}

export function renderOnboarding(catalog) {
  $("onboard-confirm").disabled = false;
  const el = $("onboard-list");
  const byCategory = new Map();
  for (const c of catalog) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category).push(c);
  }
  el.innerHTML = [...byCategory.entries()].map(([cat, items]) => `
    <div class="onboard-cat">${ONBOARD_CATEGORY_LABEL[cat] ?? cat}</div>
    ${items.map((c) => `
      <label class="onboard-item">
        <input type="checkbox" data-key="${escapeAttr(c.key)}" ${c.defaultAdopted ? "checked" : ""} />
        <span class="body"><span class="n">${escapeHtml(c.name)}</span><span class="d">${escapeHtml(c.description)}</span></span>
      </label>`).join("")}
  `).join("");
}

export async function confirmOnboarding() {
  const btn = $("onboard-confirm");
  btn.disabled = true;
  try {
    const selections = {};
    $("onboard-list").querySelectorAll("input[type=checkbox][data-key]").forEach((cb) => { selections[cb.dataset.key] = cb.checked; });
    await api("POST", "/api/doctrine/onboard", { selections });
    $("onboarding-gate").hidden = true;
    hideAuthGate();
    onAuthenticated();
  } catch (err) {
    $("onboard-err").textContent = err.message || "Could not save — try again.";
    btn.disabled = false;
  }
}
