import "dotenv/config";
import express from "express";
import { createPool } from "../db/pool.js";
import { createGateRouter } from "../http/gate.js";
import { createResolveTenant } from "../http/resolveTenant.js";
import { TenantRegistry } from "../engine/tenantRegistry.js";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * The multi-tenant server boot sequence. Unlike straders' single-tenant CLI
 * (src/cli/index.ts there boots exactly one fleet against ST_TOKEN and runs
 * it for `maxTicks`), this process serves any number of tenants: it starts
 * with zero booted fleets and lazily boots one per tenant the first time an
 * authenticated request for that tenant arrives (`TenantRegistry.getOrCreate`
 * in the `/api/*` middleware below) — then, per
 * docs/architecture-plan.md §5, that tenant's fleet keeps running for the
 * life of the process regardless of whether they have a request in flight.
 *
 * This wires the mechanics (gate, session resolution, per-tenant engine
 * boot) end to end; it does not yet expose the dashboard's full route
 * surface (ship commands, warehouse controls, the chat endpoint) — see
 * README.md's status section for what's still ahead.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log("DATABASE_URL is not set — see .env.example");
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET) {
    log("SESSION_SECRET is not set — see .env.example");
    process.exit(1);
  }

  const pool = createPool(databaseUrl);
  const registry = new TenantRegistry(pool, (tenantId, msg) => log(`[tenant ${tenantId.slice(0, 8)}] ${msg}`));

  const app = express();
  app.use(express.json());

  app.use("/api/gate", createGateRouter(pool));

  const resolveTenant = createResolveTenant(pool);
  app.use("/api", resolveTenant, async (req, res, next) => {
    try {
      await registry.getOrCreate(req.tenantId!, req.agentSymbol!);
      next();
    } catch (err) {
      log(`failed to boot tenant ${req.tenantId}: ${err instanceof Error ? err.message : String(err)}`);
      res.status(503).json({ error: "engine failed to start; try again shortly" });
    }
  });

  app.get("/api/status", (req, res) => {
    const worker = registry.get(req.tenantId!);
    if (!worker) {
      res.status(503).json({ error: "engine not ready yet" });
      return;
    }
    const s = worker.state.get();
    res.json({
      agentSymbol: worker.agentSymbol,
      paused: worker.fleet.isPaused(),
      credits: s.agent?.credits ?? null,
      shipCount: s.agent?.shipCount ?? 0,
      systemSymbol: s.systemSymbol,
    });
  });

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => log(`Standing Orders listening on :${port}`));

  const shutdown = () => {
    log(`shutting down (${registry.size()} tenant${registry.size() === 1 ? "" : "s"} running)`);
    registry.stopAll();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
