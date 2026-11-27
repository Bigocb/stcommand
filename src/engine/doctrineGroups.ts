/**
 * Doctrine groups: where each clause lives on the doctrine screen and in stcommand_get_doctrine.
 *
 * Why it exists (operator, 2026-11-17 and again 2026-11-19: "it's impossible to use"): 140 clauses in four coarse
 * categories (ops and trading held three quarters of them), no search, and a get_doctrine reply of about 180 KB. The plan
 * is docs/doctrine-organization.md; this module is its step 1.
 *
 * Code metadata only: nothing is stored, no key is renamed, `category` keeps working. A test fails if a catalog clause has
 * no group, so a clause added later cannot ship ungrouped.
 *
 * Pure: no I/O. Callers pass the catalog rows (with the tenant's current value/enabled) in.
 */

import { DOCTRINE_CATALOG } from "./doctrine.js";

export interface DoctrineGroup {
  id: string;
  name: string;
  blurb: string;
}

export const DOCTRINE_GROUPS: readonly DoctrineGroup[] = [
  { id: "cash", name: "Cash floors & ship buying", blurb: "What must stay in the wallet, how much a trip may spend, the auto-buyer and buy advice." },
  { id: "routes", name: "Route choice & ship matching", blurb: "Which routes exist, how they are scored and which hull gets which route." },
  { id: "reach", name: "Jumps & cross-system trading", blurb: "How far ships may travel through gates, empty or loaded." },
  { id: "pacing", name: "Market impact & trip pacing", blurb: "Guards that stop us crashing our own prices, and trip limits per route and market." },
  { id: "safety", name: "Loss limits & wind-down", blurb: "Selling below cost, the pre-reset wind-down and repairs." },
  { id: "gate", name: "Gate & contracts", blurb: "The gate mission's inputs and how contract goods are bought." },
  { id: "mining", name: "Mining & siphoning", blurb: "Miner and siphoner counts and asteroid field assignment." },
  { id: "keeper-buy", name: "Keepers: buying & budget", blurb: "When keeper probes are bought, approved and delivered." },
  { id: "keeper-cover", name: "Keepers: coverage & triage", blurb: "Which markets get a keeper, the top-up and parking dead markets." },
  { id: "fresh", name: "Fresh systems: release & staging", blurb: "The fresh-system queue: when to stage and release the next system." },
  { id: "explore", name: "Exploring, tours & surveys", blurb: "Explorers, tour ships, remote surveys and charting." },
  { id: "api", name: "API budget & rate limits", blurb: "The second IP lane, call savings and keeper polling." },
  { id: "alerts", name: "Alerts & health checks", blurb: "Advisory economy alerts and the engine stall alert. They change nothing." },
  { id: "auto", name: "Opening automation & advisory", blurb: "Opening tasks at reset and the advisory decision model." },
  { id: "retired", name: "Retired", blurb: "Hidden. Kept so stored rows stay valid." },
];

/** key -> [group id, sub-group]. Every catalog key appears exactly once (tests/doctrineGroups.test.ts). */
export const CLAUSE_GROUP: Readonly<Record<string, readonly [string, string]>> = {
  cashFloor: ["cash", "Floors"],
  shipBudget: ["cash", "Ship buying"],
  autoBuyShips: ["cash", "Ship buying"],
  tradeBuyCashShare: ["cash", "Trade spend"],
  tradeBuyFreeBelow: ["cash", "Trade spend"],
  marginFloor: ["routes", "Margins & lots"],
  maxLotsPerTrip: ["routes", "Margins & lots"],
  snapshotMaxAgeMin: ["routes", "Intel & sanity"],
  routePriceSanityPct: ["routes", "Intel & sanity"],
  chainFollowOnWeight: ["routes", "Circuits & follow-on"],
  chainCircuitWeight: ["routes", "Circuits & follow-on"],
  chainCircuitHorizonMin: ["routes", "Circuits & follow-on"],
  chainCircuitReturnPct: ["routes", "Circuits & follow-on"],
  chainCircuitMinGain: ["routes", "Circuits & follow-on"],
  chainCircuitMinRuns: ["routes", "Circuits & follow-on"],
  chainCircuitCrossSystem: ["routes", "Circuits & follow-on"],
  routeMatchTopN: ["routes", "Hull matching"],
  routeHoldAware: ["routes", "Hull matching"],
  routeFillFit: ["routes", "Hull matching"],
  routeSoonFreeMin: ["routes", "Hull matching"],
  shipSpeedWeight: ["routes", "Hull matching"],
  routeFitMinTrip: ["routes", "Hull matching"],
  routeFitBigHold: ["routes", "Hull matching"],
  positioningHops: ["reach", "Jumps"],
  hauledHops: ["reach", "Jumps"],
  redirectHops: ["reach", "Jumps"],
  autoCrossSystemRoutes: ["reach", "Cross-system"],
  crossSystemMaxAgeMin: ["reach", "Cross-system"],
  slowHullSpeed: ["reach", "Slow hulls"],
  slowHullHauledHops: ["reach", "Slow hulls"],
  slowHullPositioningHops: ["reach", "Slow hulls"],
  buyGuardImpactPct: ["pacing", "Buy guards"],
  routeCoolOffMin: ["pacing", "Buy guards"],
  deadRouteShareMin: ["pacing", "Buy guards"],
  routeRoundsMax: ["pacing", "Trip limits"],
  buyMarketRoundsMax: ["pacing", "Trip limits"],
  buyMarketSpacingMin: ["pacing", "Trip limits"],
  buyMarketSpacingAutoPct: ["pacing", "Trip limits"],
  marketRecoveryMin: ["pacing", "Recovery & impact model"],
  lotImpactMaxFactor: ["pacing", "Recovery & impact model"],
  thinMarketSellImpactPct: ["pacing", "Thin markets"],
  thinMarketMaxLots: ["pacing", "Thin markets"],
  thinMarketDearPrice: ["pacing", "Thin markets"],
  thinMarketDearImpactPct: ["pacing", "Thin markets"],
  thinMarketDearMaxLots: ["pacing", "Thin markets"],
  maxLossPct: ["safety", "Sale protection"],
  autoApproveFloorSale: ["safety", "Sale protection"],
  autoApproveFloorSaleMaxLoss: ["safety", "Sale protection"],
  resetWindDown: ["safety", "Wind-down"],
  repairConditionFloor: ["safety", "Upkeep"],
  protectChainGoods: ["gate", "Gate"],
  contractBuyPriceGuard: ["gate", "Contracts"],
  contractBuyCashShare: ["gate", "Contracts"],
  minerTarget: ["mining", "Fleet size"],
  promoteAtMiners: ["mining", "Fleet size"],
  siphonTarget: ["mining", "Fleet size"],
  fieldSpreadEnabled: ["mining", "Field assignment"],
  maxCrewPerField: ["mining", "Field assignment"],
  avoidStrippedFields: ["mining", "Field assignment"],
  avoidDriftFields: ["mining", "Field assignment"],
  keeperCount: ["keeper-buy", "Legacy target"],
  keeperMaxTotal: ["keeper-buy", "Budget"],
  autoKeeperProbes: ["keeper-buy", "Approval & auto-buy"],
  autoApproveKeeperProbes: ["keeper-buy", "Approval & auto-buy"],
  keeperAutoApproveMinCash: ["keeper-buy", "Approval & auto-buy"],
  keeperAutoApproveMinRate: ["keeper-buy", "Approval & auto-buy"],
  keeperYardWaitMin: ["keeper-buy", "Yard & delivery"],
  keeperDeliveryHops: ["keeper-buy", "Yard & delivery"],
  keeperYardsUnlockFirst: ["keeper-buy", "Yard & delivery"],
  keeperMaxProbePrice: ["keeper-buy", "Yard & delivery"],
  keeperYardGapRatio: ["keeper-buy", "Yard & delivery"],
  autoKeeperGoodSystems: ["keeper-cover", "Intake"],
  keeperMinGoods: ["keeper-cover", "Intake"],
  keeperMinGoodsRecommended: ["keeper-cover", "Intake"],
  keeperStagingReserve: ["keeper-buy", "Budget"],
  keeperTopUpPerHour: ["keeper-cover", "Top-up"],
  keeperTopUpMaxPending: ["keeper-cover", "Top-up"],
  keeperTopUpMaxUnpriced: ["keeper-cover", "Top-up"],
  keeperTopUpMaxCalls: ["keeper-cover", "Top-up"],
  keeperTopUpMeasuredLoad: ["keeper-cover", "Top-up"],
  keeperMaxRotationMin: ["keeper-cover", "Top-up"],
  keeperTriage: ["keeper-cover", "Triage"],
  keeperTourPlan: ["keeper-cover", "Tour plan"],
  keeperPlanFixedMinGoods: ["keeper-cover", "Tour plan"],
  keeperPlanAlsoGoods: ["keeper-cover", "Tour plan"],
  keeperPlanRouteMinProfit: ["keeper-cover", "Tour plan"],
  keeperPlanDemoteHours: ["keeper-cover", "Tour plan"], keeperPlanLoopLapMin: ["keeper-cover", "Tour plan"], keeperPlanLoopBuy: ["keeper-cover", "Tour plan"],
  freshGate: ["fresh", "Master"],
  freshTarget: ["fresh", "Release rule"],
  freshStagedAhead: ["fresh", "Release rule"],
  freshLeadMin: ["fresh", "Release rule"],
  freshFadeHours: ["fresh", "Release rule"],
  freshMinGapMin: ["fresh", "Release rule"],
  freshTradingSells: ["fresh", "Release rule"],
  releaseMinPricedPct: ["fresh", "Release rule"],
  releaseOnTourPct: ["fresh", "Release rule"],
  systemReleaseMinCash: ["fresh", "Staging cost"],
  freshKeepersPerSystem: ["fresh", "Staging cost"],
  freshTours: ["fresh", "Staging cost"],
  freshTourPinExpires: ["fresh", "Staging cost"],
  stagedTourListedFirst: ["fresh", "Staging cost"],
  stagedScoutProbe: ["fresh", "Staging cost"],
  stagedScoutProbeShipHops: ["fresh", "Staging cost"],
  stagedScoutProbeKeeps: ["fresh", "Staging cost"],
  freshIdleParkHours: ["fresh", "Idle parking"],
  freshIdleRecheckMin: ["fresh", "Idle parking"],
  freshIdleMinHourlyProfit: ["fresh", "Idle parking"],
  freshIdleHoldBound: ["fresh", "Idle parking"],
  exploringEnabled: ["explore", "Exploring"],
  explorerCreditFloor: ["explore", "Exploring"],
  scoutCreditFloor: ["explore", "Exploring"],
  explorerTarget: ["explore", "Exploring"],
  exploreMinMarkets: ["explore", "Worth tests"],
  exploreMinShipyards: ["explore", "Worth tests"],
  exploreMaxMarketStops: ["explore", "Worth tests"],
  warpTours: ["explore", "Tours"],
  tourHopPriority: ["explore", "Tours"],
  remoteSurveyPerPass: ["explore", "Remote survey"],
  remoteSurveyIntake: ["explore", "Remote survey"],
  sensorScanIntervalMin: ["explore", "Charting"],
  apiLaneProxy: ["api", "Second IP"],
  apiLaneCount: ["api", "Second IP"],
  tradeLaneShips: ["api", "Second IP"],
  shipLanes: ["api", "Second IP"],
  stateResponseSlim: ["api", "Dispatcher cost"],
  fleetListOnCountChange: ["api", "Dispatcher cost"],
  tradeLegsPrefilter: ["api", "Dispatcher cost"],
  shipBook: ["api", "Call savings"],
  marketSnapshotReuse: ["api", "Call savings"],
  arrivalSurveyMaxAgeMin: ["api", "Call savings"],
  arrivalSurveyReadKeepers: ["api", "Call savings"],
  traderSkipKeeperMarkets: ["api", "Call savings"],
  keeperPollMaxMin: ["api", "Keeper polling"],
  keeperLaneWorkers: ["api", "Keeper polling"],
  schedulerTradeWorkers: ["api", "Keeper polling"],
  keeperReadTiers: ["api", "Keeper read tiers"],
  keeperReadHotMin: ["api", "Keeper read tiers"],
  keeperReadWarmMin: ["api", "Keeper read tiers"],
  keeperReadColdMin: ["api", "Keeper read tiers"],
  keeperReadTopRoutes: ["api", "Keeper read tiers"],
  keeperReadWarmMinProfit: ["api", "Keeper read tiers"],
  keeperReadRecentTradeHours: ["api", "Keeper read tiers"],
  keeperBatchedSnapshotWrites: ["api", "Keeper polling"],
  dispatcherWorker: ["api", "Dispatcher cost"],
  keeperReadScheduler: ["api", "Keeper polling"],
  keeperTargetPassMin: ["api", "Keeper polling"],
  keeperReadCeilingPerMin: ["api", "Keeper polling"],
  routeReuseMaxSec: ["api", "Dispatcher cost"],
  openingAutomation: ["auto", "Opening"],
  jevAttention: ["auto", "Advisory"],
  jevRouter: ["auto", "Advisory"],
  warehouseTarget: ["retired", "Warehouse"],
  warehouseMax: ["retired", "Warehouse"],
  warehouseMinMargin: ["retired", "Warehouse"],
  cashFloorTradeSharePct: ["cash", "Trade spend"],
  buyAdvice: ["cash", "Buy advice"],
  buyAdviceAnyHullLine: ["cash", "Buy advice"],
  buyAdviceBigHullCargo: ["cash", "Buy advice"],
  buyAdviceBigHullLine: ["cash", "Buy advice"],
  buyAdviceBigHullLoad: ["cash", "Buy advice"],
  buyAdvicePaybackHours: ["cash", "Buy advice"],
  buyAdviceBigHullHolds: ["cash", "Buy advice"],
  buyAdviceTraderReserve: ["cash", "Buy advice"],
  traderSelfClaim: ["routes", "Trader fallbacks"],
  traderIdleDiscovery: ["routes", "Trader fallbacks"],
  jumpCashFloor: ["reach", "Jumps"],
  positioningCostScaled: ["reach", "Jumps"],
  routeMinTripSeconds: ["routes", "Scoring"],
  contractSourceAnySystem: ["gate", "Contracts"],
  keeperRotateSystems: ["keeper-buy", "Approval & auto-buy"],
  economyAlerts: ["alerts", "Economy alerts"],
  weekForecast: ["alerts", "Forecast"],
  weekForecastHeavyHour: ["alerts", "Forecast"],
  weekForecastAnchor: ["alerts", "Forecast"],
  economyNetNegativeHours: ["alerts", "Economy alerts"],
  economyDroughtHours: ["alerts", "Economy alerts"],
  economyMarginDecayPct: ["alerts", "Economy alerts"],
  economySmallHullCargo: ["alerts", "Economy alerts"],
  economySmallHullJumps: ["alerts", "Economy alerts"],
  economyCashStarvedMin: ["alerts", "Economy alerts"],
  healthStallAlert: ["alerts", "Engine health"],
  healthCpuAlert: ["alerts", "Engine health"],
};

/** Clauses that do nothing, or little, while the named clause is off (docs/doctrine-organization.md 6.1). */
export const CLAUSE_NEEDS: Readonly<Record<string, readonly string[]>> = {
  chainCircuitHorizonMin: ["chainCircuitWeight"], chainCircuitReturnPct: ["chainCircuitWeight"], chainCircuitMinGain: ["chainCircuitWeight"],
  chainCircuitMinRuns: ["chainCircuitWeight"], chainCircuitCrossSystem: ["chainCircuitWeight", "autoCrossSystemRoutes"],
  routeFitBigHold: ["routeFitMinTrip"],
  thinMarketMaxLots: ["thinMarketSellImpactPct"], thinMarketDearPrice: ["thinMarketSellImpactPct"], thinMarketDearImpactPct: ["thinMarketSellImpactPct"], thinMarketDearMaxLots: ["thinMarketSellImpactPct"],
  buyMarketSpacingAutoPct: ["buyMarketSpacingMin"],
  autoApproveFloorSaleMaxLoss: ["autoApproveFloorSale"],
  maxCrewPerField: ["fieldSpreadEnabled"], avoidStrippedFields: ["fieldSpreadEnabled"], avoidDriftFields: ["fieldSpreadEnabled"],
  explorerCreditFloor: ["exploringEnabled"], scoutCreditFloor: ["exploringEnabled"],
  remoteSurveyIntake: ["remoteSurveyPerPass", "autoKeeperGoodSystems"],
  keeperTopUpMaxPending: ["keeperTopUpPerHour"], keeperTopUpMaxUnpriced: ["keeperTopUpPerHour"], keeperTopUpMaxCalls: ["keeperTopUpPerHour"], keeperTopUpMeasuredLoad: ["keeperTopUpPerHour"], keeperMaxRotationMin: ["keeperTopUpPerHour"],
  freshTarget: ["freshGate"], freshStagedAhead: ["freshGate"], freshLeadMin: ["freshGate"], freshFadeHours: ["freshGate"], freshMinGapMin: ["freshGate"],
  freshTradingSells: ["freshGate"], releaseMinPricedPct: ["freshGate"], releaseOnTourPct: ["freshGate"], systemReleaseMinCash: ["freshGate"],
  freshKeepersPerSystem: ["freshGate"], freshTours: ["freshGate"], freshTourPinExpires: ["freshTours"], stagedTourListedFirst: ["freshGate"], stagedScoutProbe: ["freshTours"], stagedScoutProbeShipHops: ["stagedScoutProbe"], stagedScoutProbeKeeps: ["stagedScoutProbe"],
  freshIdleRecheckMin: ["freshIdleParkHours"], freshIdleMinHourlyProfit: ["freshIdleParkHours"], freshIdleHoldBound: ["freshIdleParkHours"],
  apiLaneCount: ["apiLaneProxy"],
  keeperReadHotMin: ["keeperReadTiers"], keeperReadWarmMin: ["keeperReadTiers"], keeperReadColdMin: ["keeperReadTiers"], keeperReadTopRoutes: ["keeperReadTiers"],
  keeperReadWarmMinProfit: ["keeperReadTiers"], keeperReadRecentTradeHours: ["keeperReadTiers"],
  shipBudget: ["autoBuyShips"], minerTarget: ["autoBuyShips"], siphonTarget: ["autoBuyShips"], explorerTarget: ["autoBuyShips"],
  keeperAutoApproveMinCash: ["autoApproveKeeperProbes"],
  keeperAutoApproveMinRate: ["autoApproveKeeperProbes"],
  keeperPlanFixedMinGoods: ["keeperTourPlan"], keeperPlanAlsoGoods: ["keeperTourPlan"], keeperPlanRouteMinProfit: ["keeperTourPlan"], keeperPlanDemoteHours: ["keeperTourPlan"], keeperPlanLoopLapMin: ["keeperTourPlan"], keeperPlanLoopBuy: ["keeperTourPlan"],
  buyAdviceAnyHullLine: ["buyAdvice"], buyAdviceBigHullCargo: ["buyAdvice"], buyAdviceBigHullLine: ["buyAdvice"], buyAdviceBigHullLoad: ["buyAdvice"],
  buyAdvicePaybackHours: ["buyAdvice"], buyAdviceBigHullHolds: ["buyAdvice"], buyAdviceTraderReserve: ["buyAdvice"],
  economyNetNegativeHours: ["economyAlerts"], economyDroughtHours: ["economyAlerts"], economyMarginDecayPct: ["economyAlerts"],
  economySmallHullCargo: ["economyAlerts"], economySmallHullJumps: ["economyAlerts"], economyCashStarvedMin: ["economyAlerts"],
  weekForecastHeavyHour: ["weekForecast"], weekForecastAnchor: ["weekForecast"],
};

/** The pinned "Common knobs": the clauses the operator actually changes during a week (doc 7.4, plus this week's). */
export const COMMON_KNOBS: readonly string[] = [
  "cashFloor", "cashFloorTradeSharePct", "jumpCashFloor", "positioningHops", "maxLotsPerTrip",
  "keeperAutoApproveMinCash", "autoApproveKeeperProbes", "keeperMaxTotal", "keeperTopUpPerHour", "keeperTopUpMaxCalls",
  "freshGate", "freshTours", "freshTarget", "freshStagedAhead", "releaseOnTourPct", "releaseMinPricedPct", "systemReleaseMinCash",
  "apiLaneCount", "resetWindDown",
];

/** Small-integer state clauses (value picks a mode). */
const MODE_KEYS = new Set(["freshGate", "apiLaneProxy", "keeperTourPlan"]);
/** Clauses whose value is meaningless or duplicates the switch (doc 2.1). */
const SWITCH_KEYS = new Set([
  "chainCircuitCrossSystem", "marketSnapshotReuse", "avoidStrippedFields", "fieldSpreadEnabled", "avoidDriftFields", "protectChainGoods",
  "autoKeeperProbes", "autoBuyShips", "autoKeeperGoodSystems", "autoCrossSystemRoutes", "warpTours", "tourHopPriority", "exploringEnabled",
  "openingAutomation",
]);

export type ClauseKind = "switch" | "number" | "mode";

export interface ClauseInput {
  key: string;
  name: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  enabled: boolean;
  adopted?: boolean;
  /** Catalog defaults, when known (dynamic shipCap: rules have none). */
  defaultValue?: number;
  defaultEnabled?: boolean;
}

export interface BriefClause {
  key: string;
  name: string;
  group: string;
  subGroup: string;
  kind: ClauseKind;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  enabled: boolean;
  adopted: boolean;
  common: boolean;
  needs?: string[];
  /** Present only when the clause differs from its catalog default. */
  default?: { value: number; enabled: boolean };
  /** First sentence of the description (<= 200 chars). */
  summary: string;
  description?: string;
}

export function groupOf(key: string): readonly [string, string] {
  if (key.startsWith("shipCap:")) return ["cash", "Hull caps"];
  return CLAUSE_GROUP[key] ?? ["auto", "Ungrouped"];
}

export function kindOf(c: { key: string; min: number; max: number }): ClauseKind {
  if (MODE_KEYS.has(c.key)) return "mode";
  if (SWITCH_KEYS.has(c.key) || c.min === c.max) return "switch";
  return "number";
}

export function summaryOf(description: string): string {
  const first = description.split(/(?<=\.)\s/)[0] ?? description;
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

export function isChanged(c: ClauseInput): boolean {
  if (c.defaultValue === undefined || c.defaultEnabled === undefined) return false;
  return c.value !== c.defaultValue || c.enabled !== c.defaultEnabled;
}

export function briefClause(c: ClauseInput, full = false): BriefClause {
  const [group, subGroup] = groupOf(c.key);
  const needs = CLAUSE_NEEDS[c.key];
  return {
    key: c.key, name: c.name, group, subGroup, kind: kindOf(c), value: c.value, unit: c.unit, min: c.min, max: c.max, step: c.step,
    enabled: c.enabled, adopted: c.adopted ?? true, common: COMMON_KNOBS.includes(c.key),
    ...(needs ? { needs: [...needs] } : {}),
    ...(isChanged(c) ? { default: { value: c.defaultValue!, enabled: c.defaultEnabled! } } : {}),
    summary: summaryOf(c.description),
    ...(full ? { description: c.description } : {}),
  };
}

/** Split camelCase and punctuation so "top up" finds keeperTopUpPerHour. */
function tokens(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[:_\-]/g, " ").toLowerCase();
}

/** Every word of `query` must appear in the clause's key, name, description, group or sub-group (case-insensitive). */
export function matchesSearch(c: ClauseInput, query: string): boolean {
  const words = tokens(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const [g, sg] = groupOf(c.key);
  const groupName = DOCTRINE_GROUPS.find((x) => x.id === g)?.name ?? g;
  const hay = `${tokens(c.key)} ${c.key.toLowerCase()} ${tokens(c.name)} ${c.description.toLowerCase()} ${g} ${tokens(groupName)} ${tokens(sg)}`;
  return words.every((w) => hay.includes(w));
}

export interface GroupSummary {
  id: string;
  name: string;
  blurb: string;
  count: number;
  on: number;
  changedFromDefault: number;
}

/** Per-group counts over the given clauses (retired omitted unless present; empty groups omitted). */
export function summarizeGroups(clauses: ClauseInput[]): GroupSummary[] {
  const out: GroupSummary[] = [];
  for (const g of DOCTRINE_GROUPS) {
    const inG = clauses.filter((c) => groupOf(c.key)[0] === g.id);
    if (!inG.length) continue;
    out.push({ id: g.id, name: g.name, blurb: g.blurb, count: inG.length, on: inG.filter((c) => c.enabled).length, changedFromDefault: inG.filter(isChanged).length });
  }
  return out;
}

/** Resolve a group argument: an id, or a case-insensitive prefix of the id or the name. */
export function resolveGroup(arg: string): string | undefined {
  const a = arg.trim().toLowerCase();
  if (!a) return undefined;
  return DOCTRINE_GROUPS.find((g) => g.id === a)?.id
    ?? DOCTRINE_GROUPS.find((g) => g.id.startsWith(a) || g.name.toLowerCase().startsWith(a))?.id;
}

export interface DoctrineQuery {
  group?: string;
  search?: string;
  keys?: string[];
  enabled?: boolean;
  adopted?: boolean;
  /** "default": only clauses that differ from their catalog default. */
  changed?: "default";
  detail?: "brief" | "full";
  limit?: number;
  offset?: number;
}

export type DoctrineQueryResult =
  | { total: number; groups: GroupSummary[]; common: BriefClause[]; hint: string }
  | { total: number; matched: number; offset: number; returned: number; clauses: BriefClause[]; groups: GroupSummary[]; next?: string };

const isEmptyQuery = (q: DoctrineQuery): boolean =>
  q.group === undefined && !q.search && !q.keys?.length && q.enabled === undefined && q.adopted === undefined && q.changed === undefined;

/**
 * What stcommand_get_doctrine returns. No filter: the group list and the common knobs (a few KB) with a hint how to drill
 * down. With a filter: the matching clauses as brief rows (or full rows with detail "full"), paged, plus group counts
 * over the matches. Retired clauses are never listed. An unknown group argument throws, naming the valid ids.
 */
export function queryDoctrine(clauses: ClauseInput[], q: DoctrineQuery): DoctrineQueryResult {
  const live = clauses.filter((c) => groupOf(c.key)[0] !== "retired");
  const full = q.detail === "full";
  if (isEmptyQuery(q)) {
    return {
      total: live.length,
      groups: summarizeGroups(live),
      common: COMMON_KNOBS.map((k) => live.find((c) => c.key === k)).filter((c): c is ClauseInput => !!c).map((c) => briefClause(c, full)),
      hint: "Drill down with group=<id> (e.g. fresh, keeper-buy, reach), search=<words> (e.g. \"top up\"), keys=[...], enabled, changed=\"default\". detail=\"full\" adds descriptions; detail=\"legacy\" returns the old {rules, catalog}.",
    };
  }
  let groupId: string | undefined;
  if (q.group !== undefined) {
    groupId = resolveGroup(q.group);
    if (!groupId) throw new Error(`unknown doctrine group "${q.group}"; groups: ${DOCTRINE_GROUPS.filter((g) => g.id !== "retired").map((g) => g.id).join(", ")}`);
  }
  const keySet = q.keys?.length ? new Set(q.keys) : undefined;
  const matched = live.filter((c) =>
    (!groupId || groupOf(c.key)[0] === groupId)
    && (!keySet || keySet.has(c.key))
    && (!q.search || matchesSearch(c, q.search))
    && (q.enabled === undefined || c.enabled === q.enabled)
    && (q.adopted === undefined || (c.adopted ?? true) === q.adopted)
    && (q.changed === undefined || isChanged(c)));
  const order = new Map(DOCTRINE_GROUPS.map((g, i) => [g.id, i]));
  matched.sort((a, b) => {
    const [ga, sa] = groupOf(a.key);
    const [gb, sb] = groupOf(b.key);
    return (order.get(ga) ?? 99) - (order.get(gb) ?? 99) || sa.localeCompare(sb);
  });
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(200, Math.max(1, q.limit ?? 40));
  const page = matched.slice(offset, offset + limit);
  return {
    total: live.length, matched: matched.length, offset, returned: page.length,
    clauses: page.map((c) => briefClause(c, full)),
    groups: summarizeGroups(matched),
    ...(offset + page.length < matched.length ? { next: `offset=${offset + page.length}` } : {}),
  };
}

/** Catalog rows (with the tenant's value/enabled/adopted) plus their catalog defaults, for the doctrine groups module. */
export function doctrineClauseInputs(rows: { key: string; name: string; description: string; value: number; min: number; max: number; step: number; unit: string; enabled: boolean; adopted: boolean }[]): ClauseInput[] {
  const defaults = new Map(DOCTRINE_CATALOG.map((d) => [d.key, d]));
  return rows.map((r) => { const d = defaults.get(r.key); return { ...r, defaultValue: d?.value, defaultEnabled: d?.enabled }; });
}
