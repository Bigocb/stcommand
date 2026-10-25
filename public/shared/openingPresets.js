/**
 * Opening task presets and plain-English descriptions. Pure: no DOM, no network, so Deck, Tower and the tests share it.
 *
 * A task is { key, name, trigger, steps } (src/engine/openingTasks.ts holds the types and the server-side validation, which is
 * the real gate; this module only builds shapes the server accepts). Presets exist because the form used to be three pop-ups that
 * could only change the command ship's role, and a person has no way to know what a "task key" is.
 *
 * Ship prices come from the 2026-10-18 yards (light shuttle 84,521, light hauler 324,811); the presets' amounts are editable
 * defaults with headroom over those prices and over the cash floor, not promises.
 */

export const SHIP_TYPE_LABELS = {
  SHIP_PROBE: "probe",
  SHIP_MINING_DRONE: "mining drone",
  SHIP_SIPHON_DRONE: "siphon drone",
  SHIP_INTERCEPTOR: "interceptor",
  SHIP_LIGHT_HAULER: "light hauler",
  SHIP_COMMAND_FRIGATE: "command frigate",
  SHIP_EXPLORER: "explorer",
  SHIP_HEAVY_FREIGHTER: "heavy freighter",
  SHIP_LIGHT_SHUTTLE: "light shuttle",
  SHIP_ORE_HOUND: "ore hound",
  SHIP_REFINING_FREIGHTER: "refining freighter",
  SHIP_SURVEYOR: "surveyor",
  SHIP_BULK_FREIGHTER: "bulk freighter",
};

export const ROLE_CHOICES = ["trader", "tour", "miner", "surveyor", "explorer", "keeper", "scout", "siphoner"];

const num = (n) => Math.round(Number(n)).toLocaleString("en-US");

/** A short, unique key from a base: lowercase letters, digits, - and _, at most 24 characters (the server's rule). */
export function uniqueKey(base, existing = []) {
  const clean = String(base).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "task";
  const taken = new Set(existing);
  if (!taken.has(clean)) return clean;
  for (let i = 2; i < 100; i++) {
    const k = `${clean}-${i}`;
    if (!taken.has(k)) return k;
  }
  return `${clean}-${Date.now() % 100000}`.slice(0, 24);
}

export function describeShipRef(ref) {
  if (!ref || ref.by === "command") return "the command ship";
  if (ref.by === "step") return `the ship bought in step ${ref.step + 1}`;
  return ref.symbol;
}

export function describeTrigger(t) {
  if (!t || t.kind === "always") return "Right away";
  if (t.kind === "cashAtLeast") return `When cash reaches ${num(t.credits)}c`;
  if (t.kind === "routeProfitAtLeast") return `When the best route pays ${num(t.profitPerTrip)}c a trip`;
  if (t.kind === "shipHoldEmpty") return `When ${describeShipRef(t.ship)} has an empty hold`;
  if (t.kind === "taskDone") return `After task "${t.taskKey}" is done`;
  if (t.kind === "gateProgressAtLeast") return t.pct >= 100 ? "When the home gate is open" : `When the home gate is ${t.pct}% built`;
  if (t.kind === "marketsSurveyed") return "When every market worth a keeper has been priced";
  if (t.kind === "all") return (t.of ?? []).map((m) => describeTrigger(m)).join(", and ").replace(/, and (When|After|Right)/g, (_, w) => `, and ${w.toLowerCase()}`);
  return "On a condition";
}

export function describeStep(s) {
  if (s.kind === "buyShip") return `buy a ${SHIP_TYPE_LABELS[s.shipType] ?? s.shipType} for up to ${num(s.maxPrice)}c${s.preApproved ? " (no approval card)" : " (asks you first)"}${s.keepCash ? `, only if ${num(s.keepCash)}c is left after` : ""}`;
  if (s.kind === "setRole") return `make ${describeShipRef(s.ship)} a ${s.role}`;
  if (s.kind === "contractDuty") return `${s.on ? "put" : "take"} ${describeShipRef(s.ship)} ${s.on ? "on" : "off"} contract duty`;
  if (s.kind === "setDoctrine") {
    const parts = [];
    if (s.value !== undefined) parts.push(`to ${s.value}`);
    if (s.enabled !== undefined) parts.push(s.enabled ? "on" : "off");
    return `set ${s.key} ${parts.join(", ")}`;
  }
  if (s.kind === "waitFor") return `wait until ${describeTrigger(s.trigger).replace(/^When /, "").replace(/^Right away/, "now")}`;
  return "do something";
}

/** "When cash reaches 110,000c: buy a light shuttle for up to 100,000c, then make the ship bought in step 1 a trader." */
export function describeTask(t) {
  const steps = (t.steps ?? []).map(describeStep);
  return `${describeTrigger(t.trigger)}: ${steps.join(", then ")}.`;
}

/**
 * The presets. Each has editable number fields and a build(values, ctx) that returns a task spec.
 * ctx.existingKeys lets a task refer to an earlier one only when that one is actually queued.
 */
export const OPENING_PRESETS = [
  {
    id: "contract-ship",
    label: "Buy a ship for contracts",
    blurb: "When there is cash, buy a light shuttle, make it a trader and put it on contract duty (contracts pay well for manufactured goods).",
    fields: [
      { name: "cash", label: "Start when cash reaches", unit: "c", value: 200000, min: 1 },
      { name: "maxPrice", label: "Pay at most", unit: "c", value: 100000, min: 1 },
      { name: "keep", label: "Keep at least this much after buying", unit: "c", value: 100000, min: 0 },
    ],
    build(v, ctx = {}) {
      const key = uniqueKey("contract-ship", ctx.existingKeys);
      return {
        key,
        name: "Ship for contracts",
        trigger: { kind: "cashAtLeast", credits: v.cash },
        steps: [
          { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: v.maxPrice, preApproved: true, keepCash: v.keep },
          { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
          { kind: "contractDuty", ship: { by: "step", step: 0 }, on: true },
        ],
      };
    },
  },
  {
    id: "tour-ship",
    label: "Buy a second ship for touring",
    blurb: "Buy another light shuttle and set it to tour, so new markets get priced while the first one works. Waits for the contract ship if that task is queued.",
    fields: [
      { name: "cash", label: "Start when cash reaches", unit: "c", value: 200000, min: 1 },
      { name: "maxPrice", label: "Pay at most", unit: "c", value: 100000, min: 1 },
      { name: "keep", label: "Keep at least this much after buying", unit: "c", value: 100000, min: 0 },
    ],
    build(v, ctx = {}) {
      const existing = ctx.existingKeys ?? [];
      const cash = { kind: "cashAtLeast", credits: v.cash };
      const trigger = existing.includes("contract-ship") ? { kind: "all", of: [cash, { kind: "taskDone", taskKey: "contract-ship" }] } : cash;
      return {
        key: uniqueKey("tour-ship", existing),
        name: "Ship for touring",
        trigger,
        steps: [
          { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: v.maxPrice, preApproved: true, keepCash: v.keep },
          { kind: "setRole", ship: { by: "step", step: 0 }, role: "tour" },
        ],
      };
    },
  },
  {
    id: "hauler",
    label: "Buy a hauler once a route pays",
    blurb: "When cash is there and the best route pays well per trip, buy a light hauler and make it a trader (big holds belong on paying routes).",
    fields: [
      { name: "cash", label: "Start when cash reaches", unit: "c", value: 450000, min: 1 },
      { name: "profit", label: "and the best route pays at least", unit: "c / trip", value: 100000, min: 1 },
      { name: "maxPrice", label: "Pay at most", unit: "c", value: 350000, min: 1 },
      { name: "keep", label: "Keep at least this much after buying", unit: "c", value: 100000, min: 0 },
    ],
    build(v, ctx = {}) {
      return {
        key: uniqueKey("hauler", ctx.existingKeys),
        name: "Hauler for a paying route",
        trigger: { kind: "all", of: [{ kind: "cashAtLeast", credits: v.cash }, { kind: "routeProfitAtLeast", profitPerTrip: v.profit }] },
        steps: [
          { kind: "buyShip", shipType: "SHIP_LIGHT_HAULER", maxPrice: v.maxPrice, preApproved: true, keepCash: v.keep },
          { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
        ],
      };
    },
  },
  {
    id: "survey-ship",
    label: "Tour ship that becomes a trader",
    blurb: "Buy a light shuttle and tour it to price the home system's markets. Once every market with at least the keeper minimum of goods has been priced, the same ship becomes a trader.",
    fields: [
      { name: "cash", label: "Start when cash reaches", unit: "c", value: 200000, min: 1 },
      { name: "maxPrice", label: "Pay at most", unit: "c", value: 100000, min: 1 },
      { name: "keep", label: "Keep at least this much after buying", unit: "c", value: 100000, min: 0 },
    ],
    build(v, ctx = {}) {
      return {
        key: uniqueKey("survey-ship", ctx.existingKeys),
        name: "Tour ship that becomes a trader",
        trigger: { kind: "cashAtLeast", credits: v.cash },
        steps: [
          { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: v.maxPrice, preApproved: true, keepCash: v.keep },
          { kind: "setRole", ship: { by: "step", step: 0 }, role: "tour" },
          { kind: "waitFor", trigger: { kind: "marketsSurveyed" } },
          { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
        ],
      };
    },
  },
  {
    id: "command-role",
    label: "Set the command ship's role",
    blurb: "Change the command ship's role right away (it now starts as a tour ship by itself).",
    fields: [{ name: "role", label: "Role", type: "role", value: "trader" }],
    build(v, ctx = {}) {
      return {
        key: uniqueKey("command-role", ctx.existingKeys),
        name: `Command ship: ${v.role}`,
        trigger: { kind: "always" },
        steps: [{ kind: "setRole", ship: { by: "command" }, role: v.role }],
      };
    },
  },
];

/** Check a preset's values before building (the server validates again). Returns an error string or null. */
export function presetError(preset, values) {
  for (const f of preset.fields) {
    const v = values[f.name];
    if (f.type === "role") {
      if (!ROLE_CHOICES.includes(v)) return `${f.label}: pick one of ${ROLE_CHOICES.join(", ")}`;
    } else if (!Number.isFinite(v) || v < (f.min ?? 0)) {
      return `${f.label}: enter a number of at least ${f.min ?? 0}`;
    }
  }
  return null;
}

/**
 * The custom builder: one trigger and up to 8 steps from plain choices, no JSON.
 *   trigger: { kind: "always" | "cashAtLeast" | "routeProfitAtLeast", amount }
 *   steps:   [{ kind: "buyShip", shipType, maxPrice, preApproved }, { kind: "setRole", ship, role },
 *             { kind: "contractDuty", ship, on }, { kind: "setDoctrine", key, value?, enabled? }]
 * where ship is "command", "step:N" (the ship bought in step N, counting from 1) or a ship symbol.
 */
export function shipRefFromChoice(choice) {
  const c = String(choice ?? "command").trim();
  if (c === "command" || c === "") return { by: "command" };
  const m = /^step:(\d+)$/.exec(c);
  if (m) return { by: "step", step: Number(m[1]) - 1 };
  return { by: "symbol", symbol: c };
}

export function buildCustomTask({ name, trigger, steps }, ctx = {}) {
  const t = trigger?.kind === "cashAtLeast" ? { kind: "cashAtLeast", credits: Number(trigger.amount) }
    : trigger?.kind === "gateProgressAtLeast" ? { kind: "gateProgressAtLeast", pct: Math.min(100, Math.max(0, Number(trigger.amount))) }
    : trigger?.kind === "routeProfitAtLeast" ? { kind: "routeProfitAtLeast", profitPerTrip: Number(trigger.amount) }
    : { kind: "always" };
  const out = (steps ?? []).map((s) => {
    if (s.kind === "buyShip") return { kind: "buyShip", shipType: s.shipType, maxPrice: Number(s.maxPrice), preApproved: s.preApproved !== false, ...(Number(s.keepCash) > 0 ? { keepCash: Number(s.keepCash) } : {}) };
    if (s.kind === "setRole") return { kind: "setRole", ship: shipRefFromChoice(s.ship), role: s.role };
    if (s.kind === "contractDuty") return { kind: "contractDuty", ship: shipRefFromChoice(s.ship), on: s.on !== false };
    const d = { kind: "setDoctrine", key: String(s.key ?? "").trim() };
    if (s.enabled !== undefined) d.enabled = !!s.enabled;
    if (s.value !== undefined && s.value !== "" && Number.isFinite(Number(s.value))) d.value = Number(s.value);
    return d;
  });
  const label = String(name ?? "").trim() || "Custom task";
  return { key: uniqueKey(label, ctx.existingKeys), name: label.slice(0, 80), trigger: t, steps: out };
}
