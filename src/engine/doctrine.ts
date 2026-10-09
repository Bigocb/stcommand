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
 *
 * docs/policy-library-and-onboarding-plan.md: a rule now has a third state
 * alongside value/enabled — `adopted`, whether it's part of *this* tenant's
 * policy set at all. `POLICY_CATALOG` (formerly `DEFAULTS`) is every policy
 * that exists in code; a tenant's actual active set is whatever they've
 * adopted, defaulting to `defaultAdopted:true` entries for a tenant with no
 * explicit row (the grandfather case — every rule that existed before this
 * landed, so no current tenant's fleet changes behavior). A brand-new
 * catalog entry ships `defaultAdopted:false`: invisible until a captain
 * opens the library or is offered it during onboarding. Not-adopted behaves
 * exactly like disabled for every engine read (`value()`'s `whenOff`
 * fallback, `isEnabled()` returning false) — nothing above this class needs
 * to know the difference.
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

export type PolicyCategory = "trading" | "fleet" | "risk" | "ops";

export interface PolicyDefinition extends DoctrineRule {
  /** Groups the library/onboarding UI. */
  category: PolicyCategory;
  /** True for every rule that predates the policy-library feature —
   *  grandfathers current tenants in without a backfill migration (see the
   *  migration file's own comment). A new catalog entry added after this
   *  ships starts false: opt-in only. */
  defaultAdopted: boolean;
}

const POLICY_CATALOG: PolicyDefinition[] = [
  {
    key: "cashFloor",
    name: "Cash floor",
    description: "Never let the balance fall below this — the catch-all floor for every purchase (ships, modules, repairs, cargo). Fuel is always exempt.",
    value: 20_000, min: 0, max: 500_000, step: 5_000, unit: "c",
    enabled: true, enforced: true, category: "risk", defaultAdopted: true,
  },
  {
    key: "marginFloor",
    name: "Margin floor",
    description: "Ignore arbitrage routes whose per-unit margin is below this. Not applied to a manually-assigned custom route (Dispatch pane) — an operator-picked route flies regardless of margin.",
    value: 10, min: 0, max: 500, step: 5, unit: "c",
    enabled: true, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "maxLotsPerTrip",
    name: "Max lots per trip",
    description: "How many of a market's own trade-volume lots one trader may buy in a single trip. A trip's volume is min(hold, what the wallet allows, lot size x this), so with the default 3 a good that trades in lots of 18 caps a trip at 54 units however big the hold is (seen 2026-10-08: ANTIMATTER 54 and MACHINERY 60 on 80-unit haulers with 600-900k still in the wallet). Raise it as holds grow (a 150-unit hull needs 7+ on an 18-unit lot). Each extra lot moves the price ~4.5% against us, which the route profit figures already charge for, so more lots earn less per unit. Takes effect on the next route plan.",
    value: 3, min: 1, max: 12, step: 1, unit: " lots",
    enabled: true, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "chainFollowOnWeight",
    name: "Follow-on lookahead",
    description: "Credit a route for the best trip that can start where it sells, so traders prefer routes that leave them loaded sooner instead of flying empty after the sale. The value is the share of the follow-on's score added to the route's own (50 = half). Off by default (clause disabled): turn the clause on to use it; the trader itself is unchanged. Takes effect on the next dispatch recompute (within a minute). See docs/backhaul-plan.md.",
    value: 50, min: 0, max: 100, step: 5, unit: "%",
    enabled: false, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "maxLossPct",
    name: "Loss floor",
    description: "Refuse to sell cargo below this much loss against its cost basis.",
    value: 15, min: 0, max: 100, step: 5, unit: "%",
    enabled: true, enforced: true, category: "risk", defaultAdopted: true,
  },
  {
    key: "minerTarget",
    name: "Mining pressure",
    description: "Grow the drone fleet until this many miners are active.",
    value: 4, min: 0, max: 20, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "maxCrewPerField",
    name: "Max crew per field",
    description: "Cap on how many miners+surveyors the auto field-assigner will stack onto one asteroid field before it spills over to the next-best field. Confirmed live 2026-09-29: every miner and surveyor bought over weeks all converged on the same (already-stripped) field, since the old per-ship picker just chose whichever field was nearest with no idea any other ship existed. Only applies to ships without an explicit operator pin (mineAt()) — a manual pin always wins.",
    value: 5, min: 1, max: 20, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "avoidStrippedFields",
    name: "Avoid stripped fields",
    description: "Heavily deprioritize (not outright ban) an asteroid field already tagged STRIPPED when the auto field-assigner picks a new home for a miner or surveyor — an unstripped field within reasonable range wins even if it isn't the very closest.",
    value: 1, min: 0, max: 1, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "fieldSpreadEnabled",
    name: "Spread crew across fields",
    description: "Master switch for auto field assignment (see Max crew per field / Avoid stripped fields). Off reverts every unpinned miner/surveyor to the old nearest-field-wins picker.",
    value: 1, min: 0, max: 1, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "avoidDriftFields",
    name: "Avoid drift-only fields",
    description: "Heavily deprioritize (not outright ban) an asteroid field the auto field-assigner can't reach on this ship's own tank without at least one DRIFT leg — checked properly against known fuel-selling markets as stepping stones, not just raw distance, so a field reachable via a couple of ordinary CRUISE hops is never penalized just for being far. Confirmed live 2026-09-29: field-spreading sent every low-fuel mining drone (80-capacity tank) on a single-leg DRIFT to its new field, each running well over an hour, because the picker only weighed crowding/STRIPPED/distance and had no idea some fields are only reachable at all via DRIFT for a given ship's tank size.",
    value: 1, min: 0, max: 1, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "protectChainGoods",
    name: "Protect the gate's supply chain",
    description: "While a construction mission is unfinished, keep every good that goes into its materials (e.g. iron and quartz sand for FAB_MATS, silicon and copper for the circuitry chain, down to the raw ores) out of ordinary margin trading, so the traders don't drain the inputs the producers need. Deliberate feeds and manual routes still move them. Added 2026-10-05: iron bought at H55 was being resold to another iron importer while the FAB_MATS market's own iron sat short.",
    value: 1, min: 0, max: 1, step: 1, unit: "",
    enabled: true, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "promoteAtMiners",
    name: "Trader promotion",
    description: "Promote the biggest-hold miner to trader once this many miners exist.",
    value: 4, min: 1, max: 20, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "shipBudget",
    name: "Purchase headroom",
    description: "Only consider buying a ship when credits exceed the cash floor by this much.",
    value: 30_000, min: 0, max: 500_000, step: 10_000, unit: "c",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "snapshotMaxAgeMin",
    name: "Intel freshness",
    description: "Ignore market prices older than this. Both the dispatcher and the traders use it, so they always agree on which routes exist.",
    value: 90, min: 5, max: 1440, step: 15, unit: "m",
    enabled: true, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "crossSystemMaxAgeMin",
    name: "Cross-system intel freshness",
    description: "A longer freshness window for routes that cross a jump gate. A foreign market is expensive to revisit, so holding it to the same window as a local one means cross-system routes almost never appear at all — both ends have to be fresh at the same moment, and only a keeper can guarantee that.",
    value: 120, min: 15, max: 10080, step: 15, unit: "m",
    enabled: true, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "keeperCount",
    name: "Market keepers",
    description: "How many ships to station as market keepers (probes at shipyards, miners at outer buy markets) so prices never go stale.",
    value: 2, min: 0, max: 10, step: 1, unit: "",
    enabled: true, enforced: true, category: "ops", defaultAdopted: true,
  },
  {
    key: "autoKeeperProbes",
    name: "Auto-buy keepers",
    description: "Propose buying a probe to cover an uncovered market: either when a ship visits a shipyard directly (buys AT that yard, drifts to the nearest uncovered priority market if a different one needs it more), or when a ship visits any market on the keeper priority list (buys from the nearest in-system shipyard with cached stock, drifts here). A probe has 0 fuel capacity, but that doesn't mean it can't move — it's fuel-independent, and a keeper's own tick loop repositions it to its pinned market on its own. Goes through the same operator approval gate as any other autonomous purchase, one request at a time per trigger kind fleet-wide. On by default.",
    value: 1, min: 0, max: 1, step: 1, unit: "",
    enabled: true, enforced: true, category: "ops", defaultAdopted: true,
  },
  {
    key: "keeperMinGoodsRecommended",
    name: "Keeper recommendation threshold",
    description: "The deterministic \"worth covering?\" signal a keeper-probe approval annotates itself with: a market whose latest snapshot lists at least this many distinct goods is flagged recommended. Informational only right now — it does not gate the request, the operator still decides — but it's meant to grow into what drives auto-approval later.",
    value: 5, min: 1, max: 30, step: 1, unit: " goods",
    enabled: true, enforced: true, category: "ops", defaultAdopted: true,
  },
  {
    key: "sensorScanIntervalMin",
    name: "Sensor scan",
    description: "How often the chart scout runs a sensor scan (systems/waypoints) once nothing is left to chart, and buys a scout to do it even with no charting work left. Off by default — this changes the auto-buyer's spending, so turn it on deliberately.",
    value: 30, min: 5, max: 1_440, step: 5, unit: "m",
    enabled: false, enforced: true, category: "ops", defaultAdopted: true,
  },
  {
    key: "siphonTarget",
    name: "Gas siphoners",
    description: "Grow the fleet until this many gas siphoners are active. Siphon drones extract gas from gas giants for raw-income that doesn't compete with mining.",
    value: 1, min: 0, max: 10, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "explorerTarget",
    name: "Dedicated explorers",
    description: "Grow the fleet until this many ships are dedicated explorers — unlike an occasional tour-ship borrow, a dedicated explorer does nothing but keep jumping to unvisited connected systems. 0 by default: buys none until raised.",
    value: 0, min: 0, max: 10, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: true,
  },
  {
    key: "autoCrossSystemRoutes",
    name: "Auto cross-system routes",
    description: "Let the dispatcher hand idle traders routes that START more than one gate jump away (up to 3 hops, over gates verified complete at both ends). Off by default: positioning costs real jumps (~5k each) before the first sale. Guards even when on: the hold must be empty, the first trip must out-earn the positioning cost, one trader always stays in the home system, and routes are ranked net of a third of the positioning cost. Manual routes need no switch. The data-freshness window is 'Cross-system intel freshness'. This value isn't used — only the clause toggle matters.",
    value: 1, min: 0, max: 1, step: 1, unit: "",
    enabled: false, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "exploringEnabled",
    name: "Exploring",
    description: "Master switch for jump-based exploring. Jumps cost real credits — turning this off (via the clause toggle, not this value) stops explorers from starting any new one; a jump already in flight still lands (nothing can recall it), but the ship then just parks at that destination instead of continuing on. On by default, matching today's behavior. This value isn't used — same as warehouseTarget's own master switch.",
    value: 1, min: 0, max: 1, step: 1, unit: "",
    enabled: true, enforced: true, category: "fleet", defaultAdopted: false,
  },
  {
    key: "explorerCreditFloor",
    name: "Explorer credit floor",
    description: "If the fleet's credits fall to or below this, explorers park the same way as when exploring is switched off — jumps are one of the more expensive routine actions, not worth risking when cash is already tight. 0 disables this floor (only the exploring master switch applies).",
    value: 0, min: 0, max: 500_000, step: 5_000, unit: "c",
    enabled: true, enforced: true, category: "risk", defaultAdopted: false,
  },
  {
    key: "scoutCreditFloor",
    name: "Scout credit floor",
    description: "If the fleet's credits fall to or below this, a chart scout that's fully charted its current system parks instead of jumping to look for another one — same reasoning as the explorer credit floor, just scaled to a scout's own (much cheaper, single-jump) spend. 0 disables this floor (only the exploring master switch applies).",
    value: 0, min: 0, max: 500_000, step: 5_000, unit: "c",
    enabled: true, enforced: true, category: "risk", defaultAdopted: false,
  },
  {
    key: "warehouseTarget",
    name: "Warehouse",
    description: "Master switch for warehousing — off by default: until enabled, the dispatcher only ever assigns direct round trips, same as today. Which goods get bought/sold through the warehouse, and how much of each to hold, is set per-good in the Warehouse pane, not here — this value isn't used.",
    value: 0, min: 0, max: 1, step: 1, unit: "",
    enabled: false, enforced: true, category: "ops", defaultAdopted: true,
  },
  {
    key: "warehouseMax",
    name: "Warehouse cap",
    description: "Hard ceiling per good in the warehouse ship, regardless of the target — the dispatcher never assigns a buy trader to a good already at or above this.",
    value: 500, min: 0, max: 5_000, step: 50, unit: "",
    enabled: true, enforced: true, category: "ops", defaultAdopted: true,
  },
  {
    key: "warehouseMinMargin",
    name: "Warehouse sell margin",
    description: "Only sell out of the warehouse when the live sell price clears the good's cost basis by at least this much per unit.",
    value: 10, min: 0, max: 500, step: 5, unit: "c",
    enabled: true, enforced: true, category: "trading", defaultAdopted: true,
  },
  {
    key: "repairConditionFloor",
    name: "Repair floor",
    description: "Repair a ship (opportunistically, next time it's docked at a shipyard for any reason) once its worst component's condition drops below this.",
    value: 0.5, min: 0, max: 1, step: 0.05, unit: "",
    // Shipped (and already relied on by running fleets) before the policy
    // library existed — defaultAdopted:true here, not the false a brand-new
    // policy gets, is what keeps this from silently vanishing for anyone
    // already depending on it. The "opt-in by default" behavior starts with
    // whatever ships *after* this feature, not retroactively.
    enabled: true, enforced: true, category: "ops", defaultAdopted: true,
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

interface CacheEntry {
  value: number;
  enabled: boolean;
  adopted: boolean;
}

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
/**
 * Policies switched off at the root and not available to turn back on (operator decision
 * 2026-10-05: warehousing is parked until after the gate opens). A retired rule is never
 * adopted and never enabled whatever is stored for it, so every engine read sees "not
 * applicable" (`value()` falls back to its `whenOff`, `isEnabled()` is false), and it is
 * hidden from `list()`/`catalog()` so no UI offers it. `set()` and `setAdopted()` refuse it.
 * To bring warehousing back, remove the keys here — the code, the stored rows and the
 * per-good targets are all still in place.
 */
export const RETIRED_POLICIES: ReadonlySet<string> = new Set(["warehouseTarget", "warehouseMax", "warehouseMinMargin"]);

export class Doctrine {
  private cache = new Map<string, CacheEntry>();

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
      this.cache.set(row.key, { value: row.value, enabled: row.enabled, adopted: row.adopted });
    }
  }


  /** Whether `key` is part of this tenant's policy set right now — an
   *  explicit row's `adopted` column if one exists, otherwise the catalog
   *  entry's `defaultAdopted` (the grandfather case), otherwise true (a
   *  dynamic shipCap: rule, which isn't part of the opt-in model at all). */
  private isAdopted(key: string, base: PolicyDefinition | undefined): boolean {
    if (RETIRED_POLICIES.has(key)) return false;
    const override = this.cache.get(key);
    if (override) return override.adopted;
    return base?.defaultAdopted ?? true;
  }

  /** All adopted rules, catalog defaults merged with any stored overrides.
   *  Synchronous — reads only the in-memory cache populated by `reload()`. */
  list(): DoctrineRule[] {
    const dynamic = [...this.cache.entries()]
      .filter(([key, v]) => !POLICY_CATALOG.some((d) => d.key === key) && v.adopted)
      .map(([key, v]) => this.dynamicRule(key, v.value, v.enabled));
    const catalogRules: DoctrineRule[] = [];
    for (const d of POLICY_CATALOG) {
      if (!this.isAdopted(d.key, d)) continue;
      const override = this.cache.get(d.key);
      catalogRules.push(override ? { ...d, value: override.value, enabled: override.enabled } : { ...d });
    }
    return [...catalogRules, ...dynamic];
  }

  /**
   * Every known policy, tagged with this tenant's adopted state — what Book
   * mode's library and the onboarding screen both render from. Includes
   * both `POLICY_CATALOG` entries and any ship-cap rule this tenant's fleet
   * has actually seen (`ensureShipTypeRule()` populates the cache the first
   * time a hull type shows up) — a ship cap is a real fleet-composition
   * policy the same as any other, just one this tenant discovers by owning
   * the hull rather than one that ships in code, so it only appears here
   * once there's something to show. A removed one still shows (adopted:
   * false) so it can be re-added, same as a catalog policy.
   */
  catalog(): (PolicyDefinition & { adopted: boolean })[] {
    const catalogRules = POLICY_CATALOG.filter((d) => !RETIRED_POLICIES.has(d.key)).map((d) => {
      const override = this.cache.get(d.key);
      const adopted = this.isAdopted(d.key, d);
      return override ? { ...d, value: override.value, enabled: override.enabled, adopted } : { ...d, adopted };
    });
    const dynamicRules = [...this.cache.entries()]
      .filter(([key]) => key.startsWith("shipCap:") && !POLICY_CATALOG.some((d) => d.key === key))
      .map(([key, v]) => ({ ...this.dynamicRule(key, v.value, v.enabled), category: "fleet" as const, defaultAdopted: true, adopted: v.adopted }));
    return [...catalogRules, ...dynamicRules];
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
   * The effective value of a rule. A disabled — or not-adopted — rule falls
   * back to `whenOff`, which is what "this rule doesn't apply" means for the
   * engine: not zero, the unconstrained behaviour. Not-adopted intentionally
   * collapses into the same code path as disabled here; the distinction
   * only matters to `list()`/`catalog()`, for the UI.
   */
  value(key: string, whenOff?: number): number {
    const base = POLICY_CATALOG.find((d) => d.key === key);
    const override = this.cache.get(key);
    const adopted = this.isAdopted(key, base);
    const enabled = adopted && (override?.enabled ?? base?.enabled ?? true);
    if (!enabled && whenOff !== undefined) return whenOff;
    if (override) return override.value;
    if (base) return base.value;
    // Dynamic ship-cap rules default to a generous cap so a newly-seen hull
    // never blocks the auto-buyer until the operator tunes it.
    if (key.startsWith("shipCap:")) return 4;
    throw new Error(`unknown doctrine rule: ${key}`);
  }

  isEnabled(key: string): boolean {
    const base = POLICY_CATALOG.find((d) => d.key === key);
    if (!this.isAdopted(key, base)) return false;
    return this.cache.get(key)?.enabled ?? base?.enabled ?? true;
  }

  /**
   * Like `isEnabled()`, but for a master-switch rule whose catalog default
   * is "on" — falls back to `fallbackWhenNotAdopted` instead of always
   * `false` when nobody has ever adopted this policy for this tenant.
   *
   * `isEnabled()`'s blanket "not adopted -> false" is right for an opt-in
   * growth policy (warehouseTarget, whose real default IS off), but wrong
   * here: "not adopted" is supposed to mean "no effect yet" for every read
   * in this class (see the header comment), and for a switch a caller reads
   * as "should this be blocked", `false` reads as "blocked" — the opposite
   * of no-effect. Confirmed live: exploringEnabled ships `enabled: true`
   * ("on by default, matching today's behavior") but nobody had ever
   * adopted it, so `isEnabled()` silently parked every explorer fleet-wide
   * from the moment explorersShouldPark() switched to it, with no operator
   * having touched anything.
   */
  isEnabledOr(key: string, fallbackWhenNotAdopted: boolean): boolean {
    const base = POLICY_CATALOG.find((d) => d.key === key);
    if (!this.isAdopted(key, base)) return fallbackWhenNotAdopted;
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
    this.cache.set(key, { value: defaultCap, enabled: true, adopted: true });
    if (this.store && this.tenantId) await this.store.setDoctrine(this.tenantId, key, defaultCap, true, true);
  }

  /** Update one rule's value/enabled. Values are clamped to the rule's
   *  declared bounds. Does not change whether the rule is adopted — see
   *  `setAdopted()` for that; this is for a rule already in the tenant's
   *  active set. */
  async set(key: string, patch: { value?: number; enabled?: boolean }): Promise<DoctrineRule> {
    if (RETIRED_POLICIES.has(key)) throw new Error(`doctrine rule ${key} is retired (warehousing is parked until after the gate opens) and cannot be changed`);
    const base = POLICY_CATALOG.find((d) => d.key === key);
    if (!base && !key.startsWith("shipCap:")) throw new Error(`unknown doctrine rule: ${key}`);
    const override = this.cache.get(key);
    const adopted = this.isAdopted(key, base);
    const min = base?.min ?? 0;
    const max = base?.max ?? 20;
    const currentValue = override?.value ?? base?.value ?? 4;
    const currentEnabled = override?.enabled ?? base?.enabled ?? true;
    const value = patch.value === undefined ? currentValue : Math.min(max, Math.max(min, patch.value));
    const enabled = patch.enabled === undefined ? currentEnabled : patch.enabled;
    this.cache.set(key, { value, enabled, adopted });
    if (this.store && this.tenantId) await this.store.setDoctrine(this.tenantId, key, value, enabled, adopted);
    return base ? { ...base, value, enabled } : this.dynamicRule(key, value, enabled);
  }

  /**
   * Add or remove a catalog policy from this tenant's active set — the
   * "library" ask: `adopted:true` puts it in `list()`'s output (starting
   * from `initialValue` on a first-time add, or whatever it was last tuned
   * to if re-adding after a previous remove); `adopted:false` takes it out
   * without discarding that tuning. Only catalog policies go through this —
   * dynamic shipCap: rules aren't part of the opt-in library model.
   */
  async setAdopted(key: string, adopted: boolean, initialValue?: number): Promise<DoctrineRule | undefined> {
    if (RETIRED_POLICIES.has(key)) {
      if (!adopted) return undefined; // already effectively off; nothing to record
      throw new Error(`policy ${key} is retired (warehousing is parked until after the gate opens) and cannot be adopted`);
    }
    const base = POLICY_CATALOG.find((d) => d.key === key);
    const override = this.cache.get(key);
    // A ship-cap key is a real fleet-composition policy too (it's just
    // discovered by owning the hull rather than shipping in code) — it can
    // be removed/re-added the same as any catalog entry, but only once
    // ensureShipTypeRule() has actually created it (no `base` and no
    // `override` means this key has never existed for this tenant at all,
    // and there's no sensible default to adopt it with).
    if (!base && !override) throw new Error(`unknown policy: ${key}`);
    const value = override?.value ?? initialValue ?? base?.value ?? 4;
    const enabled = override?.enabled ?? base?.enabled ?? true;
    this.cache.set(key, { value, enabled, adopted });
    if (this.store && this.tenantId) await this.store.setDoctrine(this.tenantId, key, value, enabled, adopted);
    if (!adopted) return undefined;
    return base ? { ...base, value, enabled } : this.dynamicRule(key, value, enabled);
  }

  /**
   * Onboarding's confirm step: writes an explicit `adopted` row for every
   * catalog entry in one pass — not just the ones the captain touched. This
   * is deliberately the one place a tenant's row set becomes fully explicit
   * (docs/policy-library-and-onboarding-plan.md §4 step 3): after this,
   * "not adopted" for this tenant means "the captain saw this and skipped
   * it," not "this didn't exist yet when they onboarded" — so a catalog
   * entry added later still starts opt-in for them too, same as anyone else.
   *
   * A selection can be a bare boolean (adopt at the catalog default value —
   * every existing caller before the onboarding screen grew per-policy value
   * inputs) or `{ adopted, value }`, so a captain can set e.g. their own cash
   * floor at the same moment they adopt the policy, instead of adopting the
   * catalog default and immediately having to go find it again in Book mode
   * to change it.
   */
  async completeOnboarding(selections: Record<string, boolean | { adopted: boolean; value?: number }>): Promise<DoctrineRule[]> {
    for (const d of POLICY_CATALOG) {
      if (RETIRED_POLICIES.has(d.key)) continue;
      const sel = selections[d.key];
      const adopted = typeof sel === "boolean" ? sel : !!sel?.adopted;
      const value = typeof sel === "boolean" ? undefined : sel?.value;
      await this.setAdopted(d.key, adopted, value);
    }
    return this.list();
  }
}

export const DOCTRINE_CATALOG = POLICY_CATALOG;
