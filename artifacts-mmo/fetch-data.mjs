// Pulls the public (no-auth) game data into data/*.json. Re-run after a season change.
import { writeFileSync, mkdirSync } from "node:fs";
const BASE = "https://api.artifactsmmo.com";
mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}size=100&page=${page}`);
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    const j = await r.json();
    out.push(...j.data);
    if (page >= j.pages) return out;
    await new Promise((s) => setTimeout(s, 120));
  }
}
for (const [name, path] of [["items","/items"],["monsters","/monsters"],["maps","/maps"],["resources","/resources"],["npcs","/npcs/details"],["npc_items","/npcs/items"],["tasks","/tasks/list"],["task_rewards","/tasks/rewards"],["events","/events"],["achievements","/achievements"],["effects","/effects"],["raids","/raids"]]) {
  const d = await all(path);
  writeFileSync(new URL(`./data/${name}.json`, import.meta.url), JSON.stringify(d));
  console.log(name, d.length);
}
const root = await (await fetch(BASE + "/")).json();
writeFileSync(new URL("./data/server.json", import.meta.url), JSON.stringify(root.data));
