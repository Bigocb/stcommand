/**
 * Opening Automation UI — shared view logic.
 *
 * Mounted by two surfaces from one module so they cannot drift apart:
 *   • Deck  → Settings › Automation  (renderOpeningPanel() in deck.js)
 *   • Tower → More → Opening tab     (renderMoreOpening() in m.js)
 * Each panel is a container the caller owns: the queued task list (with a
 * Cancel action per row) and the saved templates.
 *
 * Routes are the session-scoped ones — `/api/opening/tasks`, not
 * `/api/opening/tasks/:tenantId`. The tenant always comes from the session
 * cookie, the same as every other /api call these screens make; there is no
 * tenant id in the client to put in a path (the state snapshot's `agent` is a
 * plain SpaceTraders Agent). The server still accepts the `:tenantId` form and
 * 403s a mismatch, so nothing that already builds those paths breaks.
 *
 * The engine only executes these tasks when the `openingAutomation` doctrine
 * clause is on, so the header states the current mode rather than letting an
 * idle list look broken.
 */
import { api } from "/shared/api.js";
import { escapeHtml } from "/shared/domain.js";
import { OPENING_PRESETS, ROLE_CHOICES, SHIP_TYPE_LABELS, describeTask, presetError, buildCustomTask } from "/shared/openingPresets.js";

/** TaskSpec is the subset that can be saved into a template — TaskRun carries runtime state on top. */
function toTaskSpec(t) {
  return { key: t.key, name: t.name, trigger: t.trigger, steps: t.steps };
}

function modeNote(tasks) {
  const queued = tasks.filter((t) => t.status === "queued" || t.status === "active").length;
  if (!queued) return "No queued tasks. Add one to have the engine run it at the next tick.";
  return `${queued} queued — these run only while the openingAutomation doctrine clause is on.`;
}

const STYLE_ID = "opening-form-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
    .opening-form{border:1px solid var(--line,#3a3326);border-radius:8px;padding:12px;margin:10px 0;display:grid;gap:10px}
    .opening-form label{display:grid;gap:4px;font-size:12px;opacity:.9}
    .opening-form input,.opening-form select{background:#0a0a0a;color:inherit;border:1px solid var(--line,#3a3326);border-radius:6px;padding:8px;font:inherit}
    .opening-presets{display:grid;gap:8px}
    .opening-preset{text-align:left;display:grid;gap:2px;padding:10px;border-radius:8px;border:1px solid var(--line,#3a3326);background:transparent;color:inherit;font:inherit}
    .opening-preset b{font-weight:600}.opening-preset span{opacity:.7;font-size:12px}
    .opening-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .opening-step{border-top:1px dashed var(--line,#3a3326);padding-top:8px;display:grid;gap:6px}
    .opening-desc{opacity:.75;font-size:12px;margin-top:2px}
  `;
  document.head.appendChild(st);
}

/** The opening automation clause: the engine only runs tasks while it is on. Null if the doctrine can't be read. */
async function readAutomation() {
  try {
    const res = await api("GET", "/api/doctrine");
    const rule = (res.rules ?? res).find?.((r) => r.key === "openingAutomation");
    return rule ? !!rule.enabled : null;
  } catch { return null; }
}

export async function renderOpeningTasks(container) {
  ensureStyle();
  const [tasks, automationOn] = await Promise.all([api("GET", "/api/opening/tasks"), readAutomation()]);

  const automationNote = automationOn === null ? "" : automationOn
    ? "Opening automation is ON: queued tasks run when their condition is met."
    : "Opening automation is OFF: queued tasks wait and do nothing until it is switched on.";

  container.innerHTML = `
    <div class="opening-header">
      <h2>Opening tasks</h2>
      <span class="ops-sub">${escapeHtml(modeNote(tasks))}</span>
      ${automationOn === null ? "" : `<div class="opening-row"><span class="ops-sub">${escapeHtml(automationNote)}</span><button class="btn btn-sm${automationOn ? "" : " pri"}" id="automation-toggle">${automationOn ? "Turn off" : "Turn on"}</button></div>`}
      <button class="btn pri" id="add-task-btn">+ Add task</button>
    </div>
    <div id="add-task-panel"></div>
    <table class="opening-table">
      <thead>
        <tr><th>Task</th><th>Status</th><th>Step</th><th>Note</th><th></th></tr>
      </thead>
      <tbody>
        ${tasks.length === 0
          ? '<tr><td colspan="5" class="empty">No tasks queued.</td></tr>'
          : tasks.map((t) => `
            <tr>
              <td data-label="Task">${escapeHtml(t.name ?? "")} <code>${escapeHtml(t.key ?? "")}</code><div class="opening-desc">${escapeHtml(describeTask(t))}</div></td>
              <td data-label="Status"><span class="status-pill ${escapeHtml(t.status ?? "")}">${escapeHtml(t.status ?? "")}</span></td>
              <td data-label="Step">${Math.min((t.stepIndex ?? 0) + 1, (t.steps ?? []).length)} / ${(t.steps ?? []).length}</td>
              <td data-label="Note">${escapeHtml(t.note ?? "—")}</td>
              <td>${t.status === "queued" || t.status === "active" || t.status === "needs_review" ? `<button class="btn btn-sm" data-cancel="${t.id}">Cancel</button>` : ""}</td>
            </tr>`).join("")}
      </tbody>
    </table>
  `;

  container.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api("POST", `/api/opening/tasks/${btn.dataset.cancel}/cancel`);
        await renderOpeningTasks(container);
      } catch (err) {
        btn.disabled = false;
        alert(err.message);
      }
    };
  });

  const toggle = container.querySelector("#automation-toggle");
  if (toggle) {
    toggle.onclick = async () => {
      toggle.disabled = true;
      try {
        await api("POST", "/api/doctrine", { key: "openingAutomation", enabled: !automationOn });
        await renderOpeningTasks(container);
      } catch (err) {
        toggle.disabled = false;
        alert(err.message);
      }
    };
  }

  container.querySelector("#add-task-btn").onclick = () => renderAddPanel(container, tasks);
}

const SHIP_TYPE_CHOICES = ["SHIP_LIGHT_SHUTTLE", "SHIP_LIGHT_HAULER", "SHIP_PROBE", "SHIP_MINING_DRONE", "SHIP_SURVEYOR", "SHIP_EXPLORER", "SHIP_HEAVY_FREIGHTER", "SHIP_BULK_FREIGHTER"];

async function queueTask(container, spec) {
  try {
    await api("POST", "/api/opening/tasks", spec);
    await renderOpeningTasks(container);
  } catch (err) {
    alert(err.message);
  }
}

/** Presets first (tap one, edit the numbers, queue it), then a custom builder with plain choices instead of JSON. */
function renderAddPanel(container, tasks) {
  const panel = container.querySelector("#add-task-panel");
  const existingKeys = tasks.filter((t) => t.status !== "cancelled").map((t) => t.key);

  panel.innerHTML = `
    <div class="opening-form">
      <b>Pick a starting point</b>
      <div class="opening-presets">
        ${OPENING_PRESETS.map((p) => `<button class="opening-preset" data-preset="${p.id}"><b>${escapeHtml(p.label)}</b><span>${escapeHtml(p.blurb)}</span></button>`).join("")}
        <button class="opening-preset" data-preset="custom"><b>Custom…</b><span>Choose a condition and one or more actions yourself.</span></button>
      </div>
      <div id="preset-form"></div>
    </div>`;

  panel.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.preset === "custom") return renderCustomForm(container, panel.querySelector("#preset-form"), existingKeys);
      renderPresetForm(container, panel.querySelector("#preset-form"), OPENING_PRESETS.find((p) => p.id === btn.dataset.preset), existingKeys);
    };
  });
}

function renderPresetForm(container, host, preset, existingKeys) {
  host.innerHTML = `
    <div class="opening-form">
      <b>${escapeHtml(preset.label)}</b>
      ${preset.fields.map((f) => f.type === "role"
        ? `<label>${escapeHtml(f.label)}<select data-field="${f.name}">${ROLE_CHOICES.map((r) => `<option value="${r}"${r === f.value ? " selected" : ""}>${r}</option>`).join("")}</select></label>`
        : `<label>${escapeHtml(f.label)} (${escapeHtml(f.unit)})<input type="number" inputmode="numeric" data-field="${f.name}" value="${f.value}" min="${f.min ?? 0}"></label>`).join("")}
      <div class="opening-desc" id="preset-preview"></div>
      <div class="opening-row"><button class="btn pri" id="preset-queue">Queue this task</button></div>
    </div>`;
  const read = () => Object.fromEntries(preset.fields.map((f) => {
    const el = host.querySelector(`[data-field="${f.name}"]`);
    return [f.name, f.type === "role" ? el.value : Number(el.value)];
  }));
  const preview = () => {
    const v = read();
    const err = presetError(preset, v);
    host.querySelector("#preset-preview").textContent = err ?? describeTask(preset.build(v, { existingKeys }));
  };
  host.querySelectorAll("[data-field]").forEach((el) => { el.oninput = preview; });
  preview();
  host.querySelector("#preset-queue").onclick = () => {
    const v = read();
    const err = presetError(preset, v);
    if (err) { alert(err); return; }
    queueTask(container, preset.build(v, { existingKeys }));
  };
}

function renderCustomForm(container, host, existingKeys) {
  const top = { name: "", trigger: "always", amount: "" };
  let steps = [{ kind: "buyShip" }];
  const BOOL = new Set(["on", "enabled"]);

  /** Read what is on screen into `top` and `steps`, so a redraw (add or remove an action) never loses typed values. */
  const collect = () => {
    if (!host.querySelector("[data-c=name]")) return;
    top.name = host.querySelector("[data-c=name]").value;
    top.trigger = host.querySelector("[data-c=trigger]").value;
    top.amount = host.querySelector("[data-c=amount]").value;
    steps = [...host.querySelectorAll(".opening-step")].map((el) => {
      const s = {};
      el.querySelectorAll("[data-s]").forEach((inp) => { s[inp.dataset.s] = BOOL.has(inp.dataset.s) ? inp.value === "true" : inp.value; });
      return s;
    });
  };

  // Callers collect() before changing `steps` and calling draw(); draw() itself must not, or it would re-read the stale screen.
  const draw = () => {
    host.innerHTML = `
      <div class="opening-form">
        <b>Custom task</b>
        <label>Name<input data-c="name" placeholder="e.g. Second shuttle" value="${escapeHtml(top.name)}"></label>
        <label>Start<select data-c="trigger">
          <option value="always"${top.trigger === "always" ? " selected" : ""}>Right away</option>
          <option value="cashAtLeast"${top.trigger === "cashAtLeast" ? " selected" : ""}>When cash reaches…</option>
          <option value="routeProfitAtLeast"${top.trigger === "routeProfitAtLeast" ? " selected" : ""}>When the best route pays… per trip</option></select></label>
        <label id="amount-wrap" style="${top.trigger === "always" ? "display:none" : ""}">Amount (c)<input type="number" inputmode="numeric" data-c="amount" min="1" value="${escapeHtml(top.amount)}"></label>
        ${steps.map((s, i) => `
          <div class="opening-step" data-i="${i}">
            <label>Action ${i + 1}<select data-s="kind">
              <option value="buyShip"${s.kind === "buyShip" ? " selected" : ""}>Buy a ship</option>
              <option value="setRole"${s.kind === "setRole" ? " selected" : ""}>Change a ship's role</option>
              <option value="contractDuty"${s.kind === "contractDuty" ? " selected" : ""}>Contract duty on/off</option>
              <option value="setDoctrine"${s.kind === "setDoctrine" ? " selected" : ""}>Change a setting</option></select></label>
            ${s.kind === "buyShip" ? `
              <label>Ship<select data-s="shipType">${SHIP_TYPE_CHOICES.map((t) => `<option value="${t}"${(s.shipType ?? "SHIP_LIGHT_SHUTTLE") === t ? " selected" : ""}>${escapeHtml(SHIP_TYPE_LABELS[t])}</option>`).join("")}</select></label>
              <label>Pay at most (c)<input type="number" inputmode="numeric" data-s="maxPrice" value="${escapeHtml(s.maxPrice ?? 100000)}" min="1"></label>` : ""}
            ${s.kind === "setRole" || s.kind === "contractDuty" ? `
              <label>Which ship<select data-s="ship"><option value="command">The command ship</option>${steps.slice(0, i).map((x, j) => x.kind === "buyShip" ? `<option value="step:${j + 1}"${s.ship === `step:${j + 1}` ? " selected" : ""}>The ship bought in action ${j + 1}</option>` : "").join("")}</select></label>` : ""}
            ${s.kind === "setRole" ? `<label>Role<select data-s="role">${ROLE_CHOICES.map((r) => `<option value="${r}"${(s.role ?? "trader") === r ? " selected" : ""}>${r}</option>`).join("")}</select></label>` : ""}
            ${s.kind === "contractDuty" ? `<label>Contract duty<select data-s="on"><option value="true"${s.on !== false ? " selected" : ""}>On</option><option value="false"${s.on === false ? " selected" : ""}>Off</option></select></label>` : ""}
            ${s.kind === "setDoctrine" ? `<label>Setting key<input data-s="key" value="${escapeHtml(s.key ?? "")}" placeholder="e.g. keeperTriage"></label><label>Switch<select data-s="enabled"><option value="true"${s.enabled !== false ? " selected" : ""}>On</option><option value="false"${s.enabled === false ? " selected" : ""}>Off</option></select></label>` : ""}
            ${steps.length > 1 ? `<button class="btn btn-sm" data-remove="${i}">Remove action</button>` : ""}
          </div>`).join("")}
        <div class="opening-row">
          <button class="btn btn-sm" id="add-step"${steps.length >= 8 ? " disabled" : ""}>+ Add another action</button>
          <button class="btn pri" id="custom-queue">Queue this task</button>
        </div>
        <div class="opening-desc" id="custom-preview"></div>
      </div>`;
    host.querySelector("[data-c=trigger]").onchange = (e) => { host.querySelector("#amount-wrap").style.display = e.target.value === "always" ? "none" : ""; };
    host.querySelectorAll(".opening-step [data-s=kind]").forEach((sel) => {
      // Changing an action's kind starts that action fresh (its old fields don't apply), keeping everything else typed.
      sel.onchange = () => { collect(); steps[Number(sel.closest(".opening-step").dataset.i)] = { kind: sel.value }; draw(); };
    });
    host.querySelectorAll("[data-remove]").forEach((b) => { b.onclick = () => { collect(); steps.splice(Number(b.dataset.remove), 1); draw(); }; });
    host.querySelector("#add-step").onclick = () => { collect(); steps.push({ kind: "setRole" }); draw(); };
    host.querySelector("#custom-queue").onclick = () => {
      collect();
      if (top.trigger !== "always" && !(Number(top.amount) >= 1)) { alert("Enter the amount for the condition."); return; }
      const spec = buildCustomTask({
        name: top.name,
        trigger: { kind: top.trigger, amount: Number(top.amount) },
        steps: steps.map((s) => ({ ...s, maxPrice: s.maxPrice ?? 100000, shipType: s.shipType ?? "SHIP_LIGHT_SHUTTLE", role: s.role ?? "trader", ship: s.ship ?? "command" })),
      }, { existingKeys });
      queueTask(container, spec);
    };
  };
  draw();
}

export async function renderOpeningTemplates(container) {
  const templates = await api("GET", "/api/opening/templates");

  container.innerHTML = `
    <div class="opening-header">
      <h2>Opening templates</h2>
      <span class="ops-sub">A template stores the current task list so the same opening can be re-queued next week.</span>
      <button class="btn pri" id="add-template-btn">+ Save current tasks as template</button>
    </div>
    <div class="template-list">
      ${templates.length === 0
        ? '<div class="empty">No templates saved.</div>'
        : templates.map((t) => `
          <div class="template-card">
            <div class="template-name">${escapeHtml(t.name)}</div>
            <div class="template-tasks">${(t.tasks ?? []).length} tasks</div>
          </div>`).join("")}
    </div>
  `;

  container.querySelector("#add-template-btn").onclick = async () => {
    const name = prompt("Template name:");
    if (!name) return;
    try {
      // Snapshot what is queued now. A template must hold 1-12 tasks (the
      // server enforces it), so an empty task list is refused before the call.
      const tasks = await api("GET", "/api/opening/tasks");
      if (!tasks.length) {
        alert("There are no tasks to save yet. Add at least one task first.");
        return;
      }
      await api("POST", "/api/opening/templates", { name, tasks: tasks.map(toTaskSpec) });
      await renderOpeningTemplates(container);
    } catch (err) {
      alert(err.message);
    }
  };
}
