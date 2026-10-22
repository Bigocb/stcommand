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

/** TaskSpec is the subset that can be saved into a template — TaskRun carries runtime state on top. */
function toTaskSpec(t) {
  return { key: t.key, name: t.name, trigger: t.trigger, steps: t.steps };
}

function modeNote(tasks) {
  const queued = tasks.filter((t) => t.status === "queued" || t.status === "active").length;
  if (!queued) return "No queued tasks. Add one to have the engine run it at the next tick.";
  return `${queued} queued — these run only while the openingAutomation doctrine clause is on.`;
}

export async function renderOpeningTasks(container) {
  const tasks = await api("GET", "/api/opening/tasks");

  container.innerHTML = `
    <div class="opening-header">
      <h2>Opening tasks</h2>
      <span class="ops-sub">${escapeHtml(modeNote(tasks))}</span>
      <button class="btn pri" id="add-task-btn">+ Add task</button>
    </div>
    <table class="opening-table">
      <thead>
        <tr><th>Key</th><th>Name</th><th>Status</th><th>Step</th><th>Note</th><th></th></tr>
      </thead>
      <tbody>
        ${tasks.length === 0
          ? '<tr><td colspan="6" class="empty">No tasks queued.</td></tr>'
          : tasks.map((t) => `
            <tr>
              <td data-label="Key"><code>${escapeHtml(t.key ?? "")}</code></td>
              <td data-label="Name">${escapeHtml(t.name ?? "")}</td>
              <td data-label="Status"><span class="status-pill ${escapeHtml(t.status ?? "")}">${escapeHtml(t.status ?? "")}</span></td>
              <td data-label="Step">${(t.stepIndex ?? 0) + 1} / ${(t.steps ?? []).length}</td>
              <td data-label="Note">${escapeHtml(t.note ?? "—")}</td>
              <td><button class="btn btn-sm" data-cancel="${t.id}">Cancel</button></td>
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

  container.querySelector("#add-task-btn").onclick = async () => {
    const key = prompt("Task key (lowercase letters, digits, - or _, 1-24 chars):");
    if (!key) return;
    const name = prompt("Task name:");
    if (!name) return;
    // A task needs at least one step; the simplest useful one is a role change
    // on the command ship. The prompt-driven form is deliberately minimal — the
    // MCP tool and a template are the full-fidelity paths.
    const role = prompt("Set the command ship's role to (trader, miner, tour, surveyor, explorer, keeper, scout, siphoner):", "trader");
    if (!role) return;
    try {
      await api("POST", "/api/opening/tasks", {
        key,
        name,
        trigger: { kind: "always" },
        steps: [{ kind: "setRole", ship: { by: "command" }, role }],
      });
      await renderOpeningTasks(container);
    } catch (err) {
      alert(err.message);
    }
  };
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
