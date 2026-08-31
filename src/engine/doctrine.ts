import type { Store } from "../db/store.js";

/**
 * Fleet doctrine: the tunable policy the autonomous engine flies by.
 *
 * These values were previously hardcoded across the coordinator and the trader
 * (`minCashReserve: 20_000`, `maxLossPct: 15`, `miners.size >= 4`,
 * `margin <= 10`). Pulling them into one persisted place makes them the thing
 * the operator tunes, rather than constants only a code change can move.
 *
 * Everything here is read live on each use — but "live" means the in-memory
 * `cache`, not the database. `value()`/`list()`/`isEnabled()` stay fully
 * synchronous on purpose: the dispatcher and every trader read doctrine on
 * every tick, and turning that into a database round-trip per read would be
 * both slow and pointless (the ported straders code already made this call —
 * see the doc comment there). Only the two paths that actually write —
 * `reload()` (which now has to be awaited once at startup, since it reads
 * from the now-async Store) and `set()`/`ensureShipTypeRule()` — touch the
 * database at all.
 */

export interface DoctrineRule {
  /** Stable id, used as the settings key. */
  key: string;
  /** Short name for the UI. */
  name: string;
  /** One line explaining what the engine does with it. */
  description: string;
  value: number;
  /** Bounds and step for the UI control. */
  min: number;
  max: number;
  step: number;
  /** Suffix shown after the value (`c`, `%`, `` for a bare count). */
  unit: string;
  /** Whether the rule is currently applied. */
  enabled: boolean;
  /** False for rules that are defined but not yet enforced anywhere. */
  enforced: boolean;
}

const DEFAULTS: DoctrineRule[] = [
  {
    key: "cashFloor",
    name: "Cash floor",
    description: "Never let the balance fall below this when buying ships or modules.",
    value: 20_000, min: 0, max: 500_000, step: 5_000, unit: "c",
    enabled: true, enforced: true,
  },
  {
    key: "marginFloor",
    name: "Margin floor",
    description: "Ignore arbitrage routes whose per-unit margin is below this.",
    value: 10, min: 0, max: 500, step: 5, unit: "c",
    enabled: true, enforced: true,
  },
  {
    key: "maxLossPct",
    name: "Loss floor",
    description: "Refuse to sell cargo below this much loss against its cost basis.",
    value: 15, min: 0, max: 100, step: 5, unit: "%",
    enabled: true, enforced: true,
  },
  {
    key: "minerTarget",
    name: "Mining pressure",
    description: "Grow the drone fleet until this many miners are active.",
    value: 4, min: 0, max: 20, step: 1, unit: "",
    enabled: true, enforced: true,
  },
  {
    key: "promoteAtMiners",
    name: "Trader promotion",
    description: "Promote the biggest-hold miner to trader once this many miners exist.",
    value: 4, min: 1, max: 20, step: 1, unit: "",
    enabled: true, enforced: true,
  },
  {
    key: "shipBudget",
    name: "Purchase headroom",
    description: "Only consider buying a ship when credits exceed the cash floor by this much.",
    value: 30_000, min: 0, max: 500_000, step: 10_000, unit: "c",
    enabled: true, enforced: true,
  },
  {
    key: "snapshotMaxAgeMin",
    name: "Intel freshness",
    description: "Ignore market prices older than this. Both the dispatcher and the traders use it, so they always agree on which routes exist.",
    value: 90, min: 5, max: 1440, step: 15, unit: "m",
    enabled: true, enforced: true,
  },
  {
    key: "keeperCount",
    name: "Market keepers",
    description: "How many ships to station as market keepers (probes at shipyards, miners at outer buy markets) so prices never go stale.",
    value: 2, min: 0, max: 10, step: 1, unit: "",
    enabled: true, enforced: true,
  },
  {
    key: "sensorScanIntervalMin",
    name: "Sensor scan",
    description: "How often the chart scout runs a sensor scan (systems/waypoints) once nothing is left to chart, and buys a scout to do it even with no charting work left. Off by default — this changes the auto-buyer's spending, so turn it on deliberately.",
    value: 30, min: 5, max: 1_440, step: 5, unit: "m",
    enabled: false, enforced: true,
  },
  {
    key: "siphonTarget",
    name: "Gas siphoners",
    description: "Grow the fleet until this many gas siphoners are active. Siphon drones extract gas from gas giants for raw-income that doesn't compete with mining.",
    value: 1, min: 0, max: 10, step: 1, unit: "",
    enabled: true, enforced: true,
  },
  {
    key: "warehouseTarget",
    name: "Warehouse",
    description: "Master switch for warehousing — off by default: until enabled, the dispatcher only ever assigns direct round trips, same as today. Which goods get bought/sold through the warehouse, and how much of each to hold, is set per-good in the Warehouse pane, not here — this value isn't used.",
    value: 0, min: 0, max: 1, step: 1, unit: "",
    enabled: false, enforced: true,
  },
  {
    key: "warehouseMax",
    name: "Warehouse cap",
    description: "Hard ceiling per good in the warehouse ship, regardless of the target — the dispatcher never assigns a buy trader to a good already at or above this.",
    value: 500, min: 0, max: 5_000, step: 50, unit: "",
    enabled: true, enforced: true,
  },
  {
    key: "warehouseMinMargin",
    name: "Warehouse sell margin",
    description: "Only sell out of the warehouse when the live sell price clears the good's cost basis by at least this much per unit.",
    value: 10, min: 0, max: 500, step: 5, unit: "c",
    enabled: true, enforced: true,
  },
  {
    key: "repairConditionFloor",
    name: "Repair floor",
    description: "Repair a ship (opportunistically, next time it's docked at a shipyard for any reason) once its worst component's condition drops below this.",
    value: 0.5, min: 0, max: 1, step: 0.05, unit: "",
    enabled: true, enforced: true,
  },
];

/**
 * Below this, a ship gets actively routed to the nearest shipyard rather
 * than waiting for it to happen to dock somewhere for other reasons —
 * deliberately not a doctrine dial (see FleetManager.maybeRepairFleet()'s
 * own comment): how bad is too bad to leave to chance isn't something an
 * operator should be tuning, unlike repairConditionFloor above.
 */
export const CRITICAL_CONDITION = 0.2;

/**
 * Live, persisted doctrine. Reads are cheap (in-memory cache); writes go to
 * Postgres, tenant-scoped by `tenantId`, bound once at construction — every
 * `FleetManager`/`TenantWorker` in the multi-tenant runtime holds one
 * `Doctrine` per tenant, mirroring how straders bound one `Store` per process
 * to a single SQLite file. Nothing above `Doctrine` needs to thread a
 * `tenantId` through every doctrine read, which would otherwise mean touching
 * every one of the dozens of `doctrine.value(...)` call sites across the
 * engine for a value that's already fixed for the lifetime of the instance.
 *
 * `reload()` MUST be awaited once after construction, before any write path
 * (`set`/`ensureShipTypeRule`) or read (`list`/`value`/`isEnabled`) is
 * trustworthy — the constructor can't do this itself (constructors can't be
 * async), unlike the straders original where a synchronous SQLite read made
 * the cache populated the instant the object existed. `FleetManager.init()`
 * is the right place, alongside its other one-time async startup work.
 */
export class Doctrine {
  private cache = new Map<string, { value: number; enabled: boolean }>();

  constructor(
    private readonly store?: Store,
    private readonly tenantId?: string,
  ) {}

  /**
   * Record that a rule actually changed a decision — a route rejected for
   * margin, a sale blocked for loss, a price treated as stale. Deliberately
   * explicit, called from the specific engine call sites where that's true
   * (see doctrine.ts's own file header for the three seeded so far), not a
   * blanket hook on `value()`/`isEnabled()`: those are read many times per
   * tick by code that never acts on what they return, so wrapping them would
   * count "how often was this consulted" rather than "how often did this
   * rule change anything" — and would have no ship to attribute the fire to,
   * since `value()`/`isEnabled()` take no ship-context argument.
   *
   * `shipSymbol`, when given, is logged to `doctrine_fire_log` too — the
   * per-event record Book mode's clause hover reads to highlight the real
   * hulls a rule governed. Fire-and-forget: a failed write here must never
   * block the engine decision it's just reporting on.
   */
  recordFire(key: string, shipSymbol?: string): void {
    if (!this.store || !this.tenantId) return;
    this.store.recordDoctrineFire(this.tenantId, key).catch(() => {});
    if (shipSymbol) this.store.recordDoctrineFireEvent(this.tenantId, key, shipSymbol).catch(() => {});
  }

  async reload(): Promise<void> {
    this.cache.clear();
    if (!this.store || !this.tenantId) return;
    for (const row of await this.store.getDoctrine(this.tenantId)) {
      this.cache.set(row.key, { value: row.value, enabled: row.enabled });
    }
  }

  /** All rules, defaults merged with any stored overrides. Synchronous —
   *  reads only the in-memory cache populated by `reload()`. */
  list(): DoctrineRule[] {
    const dynamic = [...this.cache.entries()]
      .filter(([key]) => !DEFAULTS.some((d) => d.key === key))
      .map(([key, v]) => this.dynamicRule(key, v.value, v.enabled));
    return [...DEFAULTS.map((d) => {
      const override = this.cache.get(d.key);
      return override ? { ...d, value: override.value, enabled: override.enabled } : { ...d };
    }), ...dynamic];
  }

  /** Build a rule for a ship-type cap (e.g. `shipCap:SHIP_LIGHT_HAULER`). */
  private dynamicRule(key: string, value: number, enabled: boolean): DoctrineRule {
    const type = key.startsWith("shipCap:") ? key.slice("shipCap:".length) : key;
    return {
      key,
      name: type.replace(/^SHIP_/, "").replace(/_/g, " ").toLowerCase(),
      description: `Fleet cap for ${type} — the auto-buyer stops buying this hull once the fleet has this many.`,
      value,
      min: 0, max: 20, step: 1, unit: "",
      enabled,
      enforced: true,
    };
  }

  /**
   * The effective value of a rule. A disabled rule falls back to `whenOff`,
   * which is what "turn this rule off" means for the engine — not zero, but the
   * unconstrained behaviour.
   */
  value(key: string, whenOff?: number): number {
    const base = DEFAULTS.find((d) => d.key === key);
    const override = this.cache.get(key);
    const enabled = override?.enabled ?? base?.enabled ?? true;
    if (!enabled && whenOff !== undefined) return whenOff;
    if (override) return override.value;
    if (base) return base.value;
    // Dynamic ship-cap rules default to a generous cap so a newly-seen hull
    // never blocks the auto-buyer until the operator tunes it.
    if (key.startsWith("shipCap:")) return 4;
    throw new Error(`unknown doctrine rule: ${key}`);
  }

  isEnabled(key: string): boolean {
    const base = DEFAULTS.find((d) => d.key === key);
    return this.cache.get(key)?.enabled ?? base?.enabled ?? true;
  }

  /** Register a ship type so the operator can cap it from the doctrine tab. */
  async ensureShipTypeRule(type: string): Promise<void> {
    if (!type) return;
    const key = `shipCap:${type}`;
    if (this.cache.has(key)) return;
    // Per-hull default caps: probes are useless scouts (0 fuel, can't move), so
    // the fleet never buys them unless the operator explicitly raises the cap.
    const defaultCap = type === "FRAME_PROBE" ? 0 : 4;
    this.cache.set(key, { value: defaultCap, enabled: true });
    if (this.store && this.tenantId) await this.store.setDoctrine(this.tenantId, key, defaultCap, true);
  }

  /** Update one rule. Values are clamped to the rule's declared bounds. */
  async set(key: string, patch: { value?: number; enabled?: boolean }): Promise<DoctrineRule> {
    const base = DEFAULTS.find((d) => d.key === key);
    if (!base && !key.startsWith("shipCap:")) throw new Error(`unknown doctrine rule: ${key}`);
    const current = this.list().find((r) => r.key === key)!;
    const min = base?.min ?? 0;
    const max = base?.max ?? 20;
    const value = patch.value === undefined
      ? current.value
      : Math.min(max, Math.max(min, patch.value));
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
    this.cache.set(key, { value, enabled });
    if (this.store && this.tenantId) await this.store.setDoctrine(this.tenantId, key, value, enabled);
    return { ...current, value, enabled };
  }
}

export const DOCTRINE_DEFAULTS = DEFAULTS;
