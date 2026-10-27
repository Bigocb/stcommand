/**
 * Register several new agents and rank their starting systems for the weekly gate (docs/start-scout.md).
 *
 *   npx tsx src/cli/scoutStarts.ts --count 5 --prefix SCOUT --faction COSMIC          # dry run: prints the plan
 *   npx tsx src/cli/scoutStarts.ts --count 5 --prefix SCOUT --faction COSMIC --yes    # registers and ranks
 *
 * Needs ST_ACCOUNT_TOKEN. Writes the full results, agent tokens included, to .local/ (git-ignored, mode 0600); the console
 * never prints a token.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, SpaceTradersAPI } from "../core/client.js";
import { registerAgent } from "../core/auth.js";
import { scoutStarts, type ScoutPorts } from "../engine/startScout.js";
import type { StartFacts, StartMarket } from "../engine/startScore.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function realPorts(faction: string): ScoutPorts {
  return {
    sleep,
    register: async (symbol) => {
      const r = await registerAgent(symbol, faction);
      return { token: r.token, agentSymbol: r.agentSymbol, headquarters: r.headquarters };
    },
    read: async (token, headquarters, agentSymbol): Promise<StartFacts> => {
      const api = new SpaceTradersAPI(new Client({ token }), token);
      const system = headquarters.slice(0, headquarters.lastIndexOf("-"));
      const waypoints = await api.getAllSystemWaypoints(system);
      const markets: StartMarket[] = [];
      for (const w of waypoints.filter((x) => x.traits.some((t) => t.symbol === "MARKETPLACE"))) {
        const m = await api.getMarket(system, w.symbol);
        markets.push({ symbol: w.symbol, imports: m.imports.map((g) => g.symbol), exports: m.exports.map((g) => g.symbol), exchange: m.exchange.map((g) => g.symbol) });
      }
      const gateWp = waypoints.find((x) => x.type === "JUMP_GATE");
      let gate: StartFacts["gate"];
      if (gateWp) {
        try {
          const c = await api.getConstruction(system, gateWp.symbol);
          gate = { waypoint: gateWp.symbol, complete: c.isComplete, materials: c.materials.map((x) => ({ tradeSymbol: x.tradeSymbol, required: x.required, fulfilled: x.fulfilled })) };
        } catch {
          gate = { waypoint: gateWp.symbol, complete: false, materials: [] };
        }
      }
      return { agentSymbol, headquarters, system, markets, gate };
    },
  };
}

const count = Number(arg("count", "5"));
const prefix = arg("prefix", "SCOUT")!;
const faction = (arg("faction", process.env.RESET_FACTION ?? "COSMIC") ?? "COSMIC").toUpperCase();
const go = process.argv.includes("--yes");

let outcome: Awaited<ReturnType<typeof scoutStarts>>;
try {
  outcome = await scoutStarts({ count, prefix, ports: realPorts(faction), go });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
if (!go) {
  console.log(`Dry run. Would register ${outcome.planned.length} agents in faction ${faction}: ${outcome.planned.join(", ")}`);
  console.log("Add --yes to register them.");
  process.exit(0);
}
console.log("rank  agent           system     score  FAB sources  circuitry  markets");
outcome.results.forEach((r, i) => {
  console.log(`${String(i + 1).padStart(4)}  ${r.agentSymbol.padEnd(14)}  ${r.system.padEnd(9)}  ${String(r.score).padStart(5)}  ${String(r.fabSources.length).padStart(11)}  ${String(r.circuitrySources.length).padStart(9)}  ${String(r.marketCount).padStart(7)}`);
  for (const reason of r.reasons) console.log(`        - ${reason}`);
});
for (const e of outcome.errors) console.log(`FAILED ${e.symbol}: ${e.error}`);
const dir = resolve(process.cwd(), ".local");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `scout-starts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(outcome, null, 2), { mode: 0o600 });
console.log(`\nFull results with agent tokens: ${file}`);
