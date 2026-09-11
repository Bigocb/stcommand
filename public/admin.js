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
  body.innerHTML = "";
  emptyEl.hidden = tenants.length > 0;
  countEl.textContent = `${tenants.length} tenant${tenants.length === 1 ? "" : "s"}`;
  for (const t of tenants) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.agentSymbol)}</td>
      <td>${fmtDate(t.createdAt)}</td>
      <td>${fmtDate(t.lastSeenAt)}</td>
      <td><span class="badge ${t.running ? "run" : "stop"}">${t.running ? "running" : "not booted"}</span></td>
      <td><button class="danger" data-id="${t.id}" data-agent="${escapeHtml(t.agentSymbol)}">Delete</button></td>
    `;
    body.appendChild(tr);
  }
  body.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteTenant(btn.dataset.id, btn.dataset.agent, btn));
  });
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("unlock-btn").addEventListener("click", () => {
  sessionStorage.setItem(STORAGE_KEY, keyInput.value);
  loadTenants();
});
keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") $("unlock-btn").click(); });
$("refresh-btn").addEventListener("click", loadTenants);

if (adminKey()) loadTenants();
