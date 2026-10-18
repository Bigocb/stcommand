/**
 * Opening Automation UI — shared view logic.
 * Renders the task list and template management panels.
 */
import { api } from "/shared/api.js";
import { escapeHtml } from "/shared/domain.js";

export async function renderOpeningTasks(container, tenantId) {
  const res = await api("GET", `/api/opening/tasks/${tenantId}`);
  const tasks = res;

  container.innerHTML = `
    <div class="opening-header">
      <h2>Opening Automation</h2>
      <button class="btn pri" id="add-task-btn">+ Add Task</button>
    </div>
    <div class="opening-grid">
      <table class="opening-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Name</th>
            <th>Status</th>
            <th>Step</th>
            <th>Note</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(t => `
            <tr>
              <td><code>${escapeHtml(t.key)}</code></td>
              <td>${escapeHtml(t.name)}</td>
              <td><span class="status-pill ${t.status}">${escapeHtml(t.status)}</span></td>
              <td>${t.stepIndex + 1} / ${t.steps.length}</td>
              <td>${escapeHtml(t.note ?? "—")}</td>
              <td>
                <button class="btn btn-sm" onclick="window.cancelOpeningTask(${t.id})">Cancel</button>
              </td>
            </tr>
          `).join("")}
          ${tasks.length === 0 ? '<tr><td colspan="6" class="empty">No tasks queued.</td></tr>' : ''}
        </tbody>
      </table>
    </div>
  `;

  container.querySelector("#add-task-btn").onclick = () => {
    const key = prompt("Task Key (alphanumeric, 1-24 chars):");
    if (!key) return;
    const name = prompt("Task Name:");
    if (!name) return;
    
    const task = {
      key,
      name,
      trigger: { kind: "always" },
      steps: [] 
    };
    
    api("POST", `/api/opening/tasks/${tenantId}`, task)
      .then(() => renderOpeningTasks(container, tenantId))
      .catch(err => alert(err.message));
  };
}

export async function renderOpeningTemplates(container, tenantId) {
  const res = await api("GET", `/api/opening/templates/${tenantId}`);
  const templates = res;

  container.innerHTML = `
    <div class="opening-header">
      <h2>Opening Templates</h2>
      <button class="btn pri" id="add-template-btn">+ Save Template</button>
    </div>
    <div class="template-list">
      ${templates.map(t => `
        <div class="template-card">
          <div class="template-name">${escapeHtml(t.name)}</div>
          <div class="template-tasks">${t.tasks.length} tasks</div>
          <button class="btn btn-sm" onclick="window.applyTemplate('${t.name}')">Apply</button>
        </div>
      `).join("")}
      ${templates.length === 0 ? '<div class="empty">No templates saved.</div>' : ''}
    </div>
  `;

  container.querySelector("#add-template-btn").onclick = () => {
    const name = prompt("Template Name:");
    if (!name) return;
    
    const tasks = []; 
    api("POST", `/api/opening/templates/${tenantId}`, { name, tasks })
      .then(() => renderOpeningTemplates(container, tenantId))
      .catch(err => alert(err.message));
  };
}
