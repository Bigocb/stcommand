import { Request, Response } from \"express\";
import { Store } from \"../db/store.js\";
import { validateTaskSpec, validateTemplateTasks } from \"../engine/openingTasks.js\";

export async function listTasks(req: Request, res: Response) {
  const { tenantId } = req.params;
  const store = (req as any).store as Store;
  try {
    const tasks = await store.listOpeningTasks(tenantId);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function listTemplates(req: Request, res: Response) {
  const { tenantId } = req.params;
  const store = (req as any).store as Store;
  try {
    const templates = await store.listOpeningTemplates(tenantId);
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function addTemplate(req: Request, res: Response) {
  const { tenantId } = req.params;
  const store = (req as any).store as Store;
  const { name, tasks } = req.body;

  const v = validateTemplateTasks(tasks);
  if (!v.ok) return res.status(400).json({ error: v.error });

  try {
    await store.saveOpeningTemplate(tenantId, name, v.value);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function addTask(req: Request, res: Response) {
  const { tenantId } = req.params;
  const store = (req as any).store as Store;
  const task = req.body;

  const v = validateTaskSpec(task);
  if (!v.ok) return res.status(400).json({ error: v.error });

  try {
    await store.addOpeningTask(tenantId, v.value);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function cancelTask(req: Request, res: Response) {
  const { tenantId, id } = req.params;
  const store = (req as any).store as Store;
  try {
    await store.cancelOpeningTask(tenantId, parseInt(id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
