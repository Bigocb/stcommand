/**
 * Standing Orders admin page — operator-only, not part of the version-
 * switcher family. Its own auth: the key typed below is sent as the
 * `x-admin-key` header on every /api/admin/* call (see src/http/admin.ts,
 * which is what actually checks it — nothing here is a security boundary
 * on its own, just the UI for the header). Kept in sessionStorage so a
 * refresh doesn't re-prompt mid-session, but never in localStorage —
 * this should not outlive the tab.
 */
const STORAGE_KEY = "admin-key";

const $ = (id) => document.getElementById(id);
const unlockPanel = $("unlock-panel");
const tenantsPanel = $("tenants-panel");
const errEl = $("err");
const keyInput = $("key-input");
const body = $("tenants-body");
const countEl = $("count");
const emptyEl = $("empty");
const resetBanner = $("reset-banner");
const resetTenantList = $("reset-tenant-list");
const resetResult = $("reset-result");

let lastTenants = [];

function showError(msg) {
  errEl.textContent = msg;
  errEl.hidden = !msg;
}

function adminKey() {
  return sessionStorage.getItem(STORAGE_KEY) ?? "";
}

async function adminFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers ?? {}), "x-admin-key": adminKey() },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderTenants(tenants) {
  lastTenants = tenants;
  body.innerHTML = "";
  emptyEl.hidden = tenants.length > 0;
  countEl.textContent = `${tenants.length} tenant${tenants.length === 1 ? "" : "s"}`;
  for (const t of tenants) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.agentSymbol)}${t.deadTokenReason ? '<br><span class="dead">reset-invalidated token</span>' : ""}</td>
      <td>${fmtDate(t.createdAt)}</td>
      <td>${fmtDate(t.lastSeenAt)}</td>
      <td><span class="badge ${t.running ? "run" : "stop"}">${t.running ? "running" : "not booted"}</span></td>
      <td><input class="profile-input" data-id="${t.id}" value="${escapeHtml(t.playProfile ?? "")}" placeholder="e.g. baseline" /></td>
      <td>
        <button class="playstyle-toggle" data-id="${t.id}" data-agent="${escapeHtml(t.agentSymbol)}">Play style</button>
        <button class="danger" data-id="${t.id}" data-agent="${escapeHtml(t.agentSymbol)}">Delete</button>
      </td>
    `;
    body.appendChild(tr);
    const expandRow = document.createElement("tr");
    expandRow.className = "expand-row";
    expandRow.dataset.id = t.id;
    expandRow.hidden = true;
    expandRow.innerHTML = `<td colspan="6"><div class="playstyle-panel" id="playstyle-${t.id}"></div></td>`;
    body.appendChild(expandRow);
  }
  body.querySelectorAll("button.danger[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteTenant(btn.dataset.id, btn.dataset.agent, btn));
  });
  body.querySelectorAll(".profile-input").forEach((input) => {
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("blur", () => saveProfile(input.dataset.id, input.value.trim() || null, input));
  });
  body.querySelectorAll(".playstyle-toggle").forEach((btn) => {
    btn.addEventListener("click", () => togglePlaystyle(btn.dataset.id, btn.dataset.agent));
  });
  // A refresh rebuilds every row from scratch — reopen whatever play-style
  // panels the operator already had open rather than silently collapsing
  // them out from under a reader.
  for (const id of openPlaystylePanels) {
    const row = body.querySelector(`tr.expand-row[data-id="${id}"]`);
    const t = tenants.find((x) => x.id === id);
    if (row && t) { row.hidden = false; loadPlaystyle(id, t.agentSymbol); }
  }

  // A dead token from client.ts's own reactive TOKEN_RESET_MISMATCH check
  // (see admin.ts's GET /tenants) is a confident, first-hand signal a
  // SpaceTraders universe reset just happened — surfacing it here turns
  // that into something the operator actually notices, instead of only
  // ever showing up buried in the app's own logs.
  const affected = tenants.filter((t) => t.deadTokenReason);
  resetBanner.hidden = affected.length === 0;
  if (affected.length) {
    resetBanner.textContent =
      `Possible server reset: ${affected.map((t) => t.agentSymbol).join(", ")} ` +
      `${affected.length === 1 ? "is" : "are"} failing with a reset-invalidated token. ` +
      `Re-register with a fresh token, then use "After a server reset" below.`;
  }

  renderResetTenantList(tenants);
}

/** One checkbox per tenant, defaulting to checked for anything with a dead
 *  token (the ones a reset actually broke) and unchecked for anything
 *  still running clean (already re-registered, or never affected). */
function renderResetTenantList(tenants) {
  resetTenantList.innerHTML = tenants.map((t) => `
    <div class="row">
      <label>
        <input type="checkbox" class="reset-check" data-id="${t.id}" ${t.deadTokenReason ? "checked" : ""} />
        ${escapeHtml(t.agentSymbol)}${t.deadTokenReason ? ' <span class="dead">dead token</span>' : ""}
      </label>
    </div>`).join("");
}

async function loadTenants() {
  showError("");
  try {
    const { tenants } = await adminFetch("/api/admin/tenants");
    unlockPanel.hidden = true;
    tenantsPanel.hidden = false;
    renderTenants(tenants);
  } catch (err) {
    sessionStorage.removeItem(STORAGE_KEY);
    unlockPanel.hidden = false;
    tenantsPanel.hidden = true;
    showError(err.message);
  }
}

async function deleteTenant(id, agentSymbol, btn) {
  if (!confirm(`Permanently delete tenant "${agentSymbol}"? This deletes their fleet, credits history, and everything else — it cannot be undone.`)) return;
  btn.disabled = true;
  btn.textContent = "Deleting…";
  try {
    await adminFetch(`/api/admin/tenants/${id}`, { method: "DELETE" });
    await loadTenants();
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = "Delete";
  }
}

async function saveProfile(id, profile, input) {
  input.disabled = true;
  try {
    await adminFetch(`/api/admin/tenants/${id}/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });
  } catch (err) {
    showError(err.message);
  } finally {
    input.disabled = false;
  }
}

const openPlaystylePanels = new Set();

function togglePlaystyle(id, agentSymbol) {
  const row = body.querySelector(`tr.expand-row[data-id="${id}"]`);
  if (!row) return;
  const opening = row.hidden;
  row.hidden = !opening;
  if (opening) {
    openPlaystylePanels.add(id);
    loadPlaystyle(id, agentSymbol);
  } else {
    openPlaystylePanels.delete(id);
  }
}

/** Play-style tracking (docs/TODO.md): the operator's own logged role
 *  changes/manual buys (src/http/dashboard.ts) plus any manual checkpoint
 *  notes, newest first — and a form to add one. */
async function loadPlaystyle(id, agentSymbol) {
  const panel = $(`playstyle-${id}`);
  if (!panel) return;
  panel.innerHTML = `<div class="ps-loading">Loading…</div>`;
  try {
    const { actions } = await adminFetch(`/api/admin/tenants/${id}/actions`);
    panel.innerHTML = `
      <div class="ps-add">
        <textarea class="ps-note" placeholder="Log a checkpoint — e.g. &quot;overrode automation: command ship &rarr; tour, approved two miners, bought and converted a third to trader&quot;"></textarea>
        <button class="ps-add-btn" data-id="${id}">Log checkpoint</button>
      </div>
      <div class="ps-log">${
        actions.length
          ? actions.map((a) => `
            <div class="ps-row">
              <div class="ps-row-top"><b>${escapeHtml(a.kind)}</b><span class="ps-when">${fmtDate(a.createdAt)}</span></div>
              <div class="ps-detail">${escapeHtml(a.detail)}</div>
              ${a.meta ? `<div class="ps-meta">${escapeHtml(JSON.stringify(a.meta))}</div>` : ""}
            </div>`).join("")
          : '<div class="ps-empty">No logged actions yet — role changes and manual buys show up here automatically; use the box above for a free-text note.</div>'
      }</div>
    `;
    panel.querySelector(".ps-add-btn").addEventListener("click", () => submitCheckpoint(id, agentSymbol));
  } catch (err) {
    panel.innerHTML = `<div class="ps-empty">${escapeHtml(err.message)}</div>`;
  }
}

async function submitCheckpoint(id, agentSymbol) {
  const panel = $(`playstyle-${id}`);
  const textarea = panel?.querySelector(".ps-note");
  const detail = textarea?.value.trim();
  if (!detail) return;
  const btn = panel.querySelector(".ps-add-btn");
  btn.disabled = true;
  try {
    await adminFetch(`/api/admin/tenants/${id}/checkpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detail }),
    });
    await loadPlaystyle(id, agentSymbol);
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
  }
}

async function runResetCleanup() {
  const checked = new Set([...resetTenantList.querySelectorAll(".reset-check:checked")].map((c) => c.dataset.id));
  const wipeAgents = lastTenants.filter((t) => checked.has(t.id)).map((t) => t.agentSymbol);
  const keepTenantIds = lastTenants.filter((t) => !checked.has(t.id)).map((t) => t.id);
  if (!wipeAgents.length) {
    if (!confirm("No tenant is checked — this will only truncate the shared galaxy tables (jump gates, market prices, shipyards, system layout). Continue?")) return;
  } else if (!confirm(`Clear ${wipeAgents.join(", ")}'s fleet/contract/mission/financial data, and truncate every shared galaxy table? This cannot be undone.`)) {
    return;
  }
  const btn = $("reset-cleanup-btn");
  btn.disabled = true;
  resetResult.textContent = "";
  try {
    const res = await adminFetch("/api/admin/reset-cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepTenantIds }),
    });
    resetResult.textContent = `Done — cleared ${res.tenantsWiped.length} tenant(s), shared galaxy tables truncated.`;
    await loadTenants();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("unlock-btn").addEventListener("click", () => {
  sessionStorage.setItem(STORAGE_KEY, keyInput.value);
  loadTenants();
});
keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") $("unlock-btn").click(); });
$("refresh-btn").addEventListener("click", loadTenants);
$("reset-cleanup-btn").addEventListener("click", runResetCleanup);

if (adminKey()) loadTenants();
