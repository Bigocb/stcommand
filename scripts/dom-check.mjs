/**
 * Renders a UI page in headless Chromium and captures the resulting DOM, so
 * a refactor can be proved behaviour-neutral instead of argued to be.
 *
 * Phase 0 moves ~180KB of JavaScript out of v2.html into shared modules.
 * Nothing about that is visible to a typecheck or the test suite, which
 * never touch the frontend — the only honest check is "does the page still
 * render the same thing". This does that:
 *
 *     node scripts/dom-check.mjs --save before.html      # baseline
 *     ...make the change...
 *     node scripts/dom-check.mjs --against before.html   # diff
 *
 * Serves public/ through the same express.static config src/cli/index.ts
 * uses, so asset paths resolve exactly as they do in production. It never
 * starts the real server: that would boot a second copy of the live fleet
 * against the production database.
 *
 * Expect one diff line even on a clean run — #clock renders the current
 * time. That line is load-bearing: the authored markup contains an em dash,
 * so a real time proves the script actually executed. A DOM that matches
 * the baseline *including* a literal em dash means the page rendered
 * without its JavaScript, which is a failure, not a pass.
 */
import express from "express";
// The real production router, not a reimplementation — the harness is only
// worth trusting if it serves pages the way the server does. Importing a
// .ts module means this script runs under tsx: `npx tsx scripts/dom-check.mjs`.
import { createUiVersionRouter } from "../src/http/uiVersions.ts";
import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const savePath = flag("--save");
const againstPath = flag("--against");
const page = flag("--page") ?? "/";
const useFixtures = args.includes("--fixtures");
const shotPath = flag("--screenshot");

if (!savePath && !againstPath && !shotPath) {
  console.error("usage: dom-check.mjs (--save <f> | --against <f> | --screenshot <f.png>) [--page /v3] [--fixtures]");
  process.exit(2);
}

/** Chromium from the Playwright cache, or CHROME_PATH. No package needed. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(process.env.HOME ?? "/root", ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-"))) {
    const p = join(cache, dir, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error("no Chromium found. Set CHROME_PATH, or install one under ~/.cache/ms-playwright.");
  process.exit(2);
}

const app = express();

/**
 * Canned /api/* responses so the page renders the *dashboard* rather than
 * the login gate.
 *
 * Without this the harness only ever proves the logged-out view still
 * paints — none of the load*() functions run, so none of the render
 * pipeline is exercised, and a refactor of the data layer would diff clean
 * while being completely broken. boot0() probes /api/state; a 200 there is
 * what takes it past the gate and into boot(), which fans out to eight
 * loaders.
 *
 * The values do not need to be realistic, only *deterministic*: the point
 * is that the same fixtures render the same DOM before and after a change.
 * Timestamps are fixed and old so relative-time strings ("3d") are stable
 * between two runs seconds apart.
 */
const FIXED_ISO = "2026-08-30T12:00:00.000Z";

/** Two hulls with contrasting health, so condition meters, fuel bars and
 *  status chips all actually render. A screenshot of an empty fleet cannot
 *  show whether a readout is legible, which is the whole question for v3. */
const ship = (symbol, role, cond, fuel, cargo) => ({
  symbol,
  registration: { role, name: symbol, factionSymbol: "COSMIC" },
  nav: { status: "DOCKED", waypointSymbol: "X1-FIX-A1", systemSymbol: "X1-FIX", flightMode: "CRUISE",
         route: { origin: { symbol: "X1-FIX-A1", x: 0, y: 0 }, destination: { symbol: "X1-FIX-A1", x: 0, y: 0 },
                  departureTime: FIXED_ISO, arrival: FIXED_ISO } },
  fuel: { current: fuel, capacity: 400 },
  cargo: { capacity: 40, units: cargo, inventory: [] },
  frame: { symbol: "FRAME_FRIGATE", condition: cond, integrity: 1 },
  engine: { symbol: "ENGINE_ION_DRIVE_I", condition: Math.min(1, cond + 0.04), integrity: 1 },
  reactor: { symbol: "REACTOR_FUSION_I", condition: 1, integrity: 1 },
  crew: { current: 57, required: 57, capacity: 80, morale: 100 },
  mounts: [], modules: [],
});
const SHIPS = [ship("DAGGER-1", "COMMAND", 0.94, 222, 0), ship("DAGGER-2", "HAULER", 1.0, 318, 8)];

// Enough of a system to actually plot. One waypoint at the origin is a
// degenerate map — no span, so no scale, and nothing that would catch a
// projection, label-collision or range-ring bug. A small spread of real
// waypoint types exercises the glyphs too.
const WAYPOINTS = [
  { symbol: "X1-FIX-A1", x: 0, y: 0, type: "PLANET", traits: ["MARKETPLACE"] },
  { symbol: "X1-FIX-D46", x: -140, y: 62, type: "ORBITAL_STATION", traits: ["MARKETPLACE"] },
  { symbol: "X1-FIX-J58", x: 96, y: -118, type: "MOON", traits: ["MARKETPLACE", "SHIPYARD"] },
  { symbol: "X1-FIX-K89", x: 210, y: 140, type: "ASTEROID", traits: [] },
  { symbol: "X1-FIX-E48", x: -88, y: -196, type: "GAS_GIANT", traits: ["MARKETPLACE"] },
  { symbol: "X1-FIX-I59", x: 178, y: -40, type: "JUMP_GATE", traits: [] },
];

const FIXTURES = {
  "/api/state": {
    agent: { symbol: "FIXTURE", credits: 1327000, shipCount: 2 },
    ships: SHIPS, contracts: [], systemSymbol: "X1-FIX",
    waypoints: WAYPOINTS,
    systems: [{ symbol: "X1-FIX", waypoints: WAYPOINTS, jumpGates: [] }],
    jumpConnections: [], totals: { sells: 0, buys: 0 },
  },
  "/api/bridge": {
    rate: 0, prevRate: 0, forgone: 0, series: [0, 0], credits: 1327000, shipCount: 2,
    totals: { sells: 412000, buys: 288000 }, paused: false,
    earnings: [{ shipSymbol: "DAGGER-2", net: 14200 }, { shipSymbol: "DAGGER-1", net: 0 }],
    stranded: [],
    shipStatus: [
      { symbol: "DAGGER-1", step: "docked", role: "command", paused: false },
      { symbol: "DAGGER-2", step: "selling", role: "trader", paused: false },
    ],
    summary: [{ label: "traders", n: 1 }, { label: "command", n: 1 }],
    triage: [{ shipSymbol: "DAGGER-1", headline: "Repair needed", detail: "worst component 94%", forgone: 3940, severity: "warn" }],
  },
  "/api/fleet/status": { ships: [], stranded: [], paused: false },
  "/api/markets": {
    routes: [
      { goodSymbol: "MEDICINE", buyAt: "X1-FIX-D46", buySystem: "X1-FIX", buyPrice: 3934,
        sellAt: "X1-FIX-A1", sellSystem: "X1-FIX", sellPrice: 5253, volume: 20, distance: 12,
        fuelUnits: 12, fuelCost: 864, marginPerUnit: 1319, marginPct: 33.5,
        grossPerTrip: 26380, profitPerTrip: 26380, crossSystem: false, ageMinutes: 4 },
      { goodSymbol: "FOOD", buyAt: "X1-FIX-K89", buySystem: "X1-FIX", buyPrice: 2060,
        sellAt: "X1-FIX-J58", sellSystem: "X1-FIX", sellPrice: 2493, volume: 60, distance: 9,
        fuelUnits: 9, fuelCost: 648, marginPerUnit: 433, marginPct: 21,
        grossPerTrip: 25980, profitPerTrip: 25980, crossSystem: false, ageMinutes: 7 },
    ],
    snapshots: [
      { systemSymbol: "X1-FIX", waypointSymbol: "X1-FIX-A1", goodSymbol: "MEDICINE", type: "IMPORT",
        supply: "SCARCE", purchasePrice: 5491, sellPrice: 5253, tradeVolume: 20, timestamp: FIXED_ISO },
    ],
    shipyards: [], modules: [], systems: ["X1-FIX"],
  },
  "/api/activity": { activity: [
    { timestamp: FIXED_ISO, shipSymbol: "DAGGER-2", kind: "sell", detail: "sold 40u FOOD at J58", credits: 99720 },
    { timestamp: FIXED_ISO, shipSymbol: "fleet", kind: "policy", detail: "cash floor held — purchase deferred", credits: 0 },
  ] },
  "/api/doctrine": {
    rules: [
      { key: "cashFloor", name: "Cash floor", description: "Never let the balance fall below this.",
        value: 20000, min: 0, max: 500000, step: 5000, unit: "c", enabled: true, enforced: true },
      { key: "marginFloor", name: "Margin floor", description: "Ignore routes below this margin.",
        value: 10, min: 0, max: 500, step: 5, unit: "c", enabled: true, enforced: true },
    ],
    catalog: [],
  },
  "/api/doctrine/stats": { stats: [] },
  "/api/narrative": { narrative: "Fixture watch." },
  "/api/missions": { missions: [] },
  "/api/contracts": { contracts: [] },
  "/api/replay": { frames: [], t0: FIXED_ISO, t1: FIXED_ISO },
  "/api/goods": { goods: [] },
  "/api/warehouse": { goods: [], targets: [], ship: null },
  "/api/dispatch": { routes: [], assignments: [] },
  "/api/keeper/markets": { markets: [], stationed: [] },
  "/api/leaderboard": { agents: [] },
  "/api/factions": { factions: [] },
  "/api/chat/history": { messages: [] },
  "/api/discord/enabled": { enabled: false },
  "/api/settings/llm": {},
};

if (useFixtures) {
  app.use("/api", (req, res) => {
    const key = "/api" + req.path.replace(/\/$/, "");
    res.json(FIXTURES[key] ?? {});
  });
}

app.use(createUiVersionRouter(resolve("public")));
app.use(express.static(resolve("public"), { index: "v2.html" }));
const server = app.listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}${page}`;
  // execFile, not spawnSync: a synchronous spawn blocks this process's event
  // loop, so the static server above could never answer Chromium's requests
  // and the page would hang forever waiting for its own assets.
  let res;
  try {
    res = await run(
      chrome,
      [
        "--headless", "--no-sandbox", "--disable-gpu",
        "--virtual-time-budget=6000",
        "--enable-logging=stderr", "--v=0",
        // A DOM diff cannot see CSS at all — a version whose whole point is
        // a new palette and new elevation would diff clean while looking
        // completely different. Screenshots are the only honest check for
        // that, so the harness produces them too.
        ...(shotPath
          ? ["--window-size=1600,1000", `--screenshot=${shotPath}`]
          : ["--dump-dom"]),
        url,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    server.close();
    console.error(`chromium failed: ${err.message}`);
    process.exit(1);
  }
  server.close();

  if (shotPath) {
    console.log(`screenshot written to ${shotPath}`);
    process.exit(0);
  }

  // Inline <script> and <style> bodies are elided before comparing.
  // --dump-dom returns both as document text, so moving code or CSS between
  // files shifts every following line and buries the signal — and that
  // movement is exactly what this work does on purpose. It also makes two
  // versions comparable when one inlines its CSS and another links it.
  const dom = res.stdout
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi,
      (_m, open, close) => `${open}/* inline script elided */${close}`)
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi,
      (_m, open, close) => `${open}/* inline style elided */${close}`);

  // Page-level problems only — the sandbox emits dbus/UPower noise that has
  // nothing to do with the page under test.
  const pageErrors = (res.stderr || "")
    .split("\n")
    .filter((l) => /error|exception|uncaught/i.test(l))
    // Chromium logs its own internals to the same stream (component updater,
    // GPU probing, dbus in a container). Page-origin messages are what matter.
    .filter((l) => !/dbus|UPower|gpu|sandbox|GLES|Vulkan|font|chrome\/browser\/|components\/|optimization_guide|component_updater|on-device model/i.test(l));

  if (savePath) {
    writeFileSync(savePath, dom);
    console.log(`saved ${(dom.length / 1024).toFixed(0)}KB of DOM to ${savePath}`);
  } else {
    const before = readFileSync(againstPath, "utf8");
    const a = before.split("\n");
    const b = dom.split("\n");
    const diffs = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) diffs.push({ line: i + 1, before: a[i], after: b[i] });
    }
    // A line is volatile if the two versions are identical once clock times
    // ("20:44:59", "20:44") and relative ages ("3m", "2h") are blanked. The
    // clock ticks every second; the replay scrubber's endpoints render at
    // minute granularity, so a baseline captured either side of a minute
    // boundary differs there through nothing but elapsed time. Comparing
    // with those blanked keeps the check strict about everything else
    // instead of needing that reasoned out by hand each run.
    const timeless = (l) => (l ?? "")
      .replace(/\d{1,2}:\d{2}(:\d{2})?/g, "<time>")
      .replace(/\b\d+[smhd]\b/g, "<age>");
    const volatileOnly = diffs.every((d) => timeless(d.before) === timeless(d.after));
    const ranJs = !/id="clock">—</.test(dom);

    console.log(`${diffs.length} differing line(s) vs ${againstPath}`);
    for (const d of diffs.slice(0, 20)) {
      console.log(`  line ${d.line}:\n    - ${(d.before ?? "").trim().slice(0, 160)}\n    + ${(d.after ?? "").trim().slice(0, 160)}`);
    }
    if (!ranJs) {
      console.error("\nFAIL: #clock still shows its authored placeholder — the page rendered without its JavaScript.");
      process.exit(1);
    }
    if (diffs.length === 0 || volatileOnly) {
      console.log("\nPASS: DOM identical apart from clock/age text, and the clock proves the script ran.");
    } else {
      console.error("\nFAIL: the DOM changed beyond clock/age text.");
      process.exit(1);
    }
  }

  if (pageErrors.length) {
    console.error(`\n${pageErrors.length} page console error(s):`);
    for (const e of pageErrors.slice(0, 10)) console.error(`  ${e}`);
    process.exit(1);
  }
});
