import type { Detector, NotifyEvent, NotifySnapshot } from "./types.js";

/**
 * Detectors turn a snapshot into events. Each is pure and small; add one by writing it here and listing it in DETECTORS.
 * Wording stays short and carries no credit figures.
 */

/** Words for an approval, from the kind the engine asked under. Kinds can carry a key after a colon (sellBelowFloor:SHIP:GOOD). */
const APPROVAL_TITLES: Record<string, string> = {
  sellBelowFloor: "Sell below the loss floor?",
  buyShip: "Ship purchase needs approval",
  buyScout: "Scout purchase needs approval",
  buySiphoner: "Siphoner purchase needs approval",
  buyKeeperProbe: "Keeper probe purchase needs approval",
  buyKeeperProbeForMarket: "Keeper probe purchase needs approval",
  installScanner: "Scanner install needs approval",
  autoExploreBorrow: "Explorer borrow needs approval",
  assignShipRole: "Role change needs approval",
};

const humanize = (kind: string): string => {
  const words = kind.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function describeApproval(a: { kind: string; shipSymbol: string | null; expiresAt?: string | null }, now: number): { title: string; body: string } {
  const [base = "", ...rest] = a.kind.split(":");
  const title = APPROVAL_TITLES[base] ?? `${humanize(base)}: approval needed`;
  const ship = (a.shipSymbol ?? rest[0] ?? "").split("|")[0] || undefined;
  const good = base === "sellBelowFloor" ? rest[1] : undefined;
  const parts: string[] = [];
  if (ship) parts.push(good ? `${ship} is holding ${good.replace(/_/g, " ").toLowerCase()}` : ship);
  const left = a.expiresAt ? Math.round((Date.parse(a.expiresAt) - now) / 60_000) : NaN;
  if (Number.isFinite(left) && left > 0) parts.push(`${left} min to decide`);
  return { title, body: parts.join(" · ") || "Open Tower to decide." };
}

export const approvalsDetector: Detector = {
  id: "approvals",
  category: "approvals",
  detect: (s: NotifySnapshot): NotifyEvent[] =>
    s.approvals.map((a) => ({
      key: `approval:${a.id}`,
      category: "approvals",
      severity: "warning",
      ...describeApproval(a, s.now),
      url: "/m#approvals",
    })),
};

export const strandedDetector: Detector = {
  id: "stranded",
  category: "stranded",
  detect: (s) =>
    s.stranded.map((x) => ({
      key: `stranded:${x.symbol}`,
      category: "stranded",
      severity: "critical",
      title: `${x.symbol} is stranded`,
      body: "It cannot continue on its own.",
      url: "/m#fleet",
    })),
};

export const attentionDetector: Detector = {
  id: "attention",
  category: "attention",
  detect: (s) =>
    s.attention
      .filter((a) => a.severity === "critical")
      .map((a) => ({
        key: `attention:${a.ship}`,
        category: "attention",
        severity: "critical",
        title: `${a.ship} needs a look`,
        body: a.reasons.find((r) => r.severity === "critical")?.text ?? a.reasons[0]?.text ?? "Flagged by the attention feed.",
        url: "/m#fleet",
      })),
};

/** A trader with no route for five minutes (the fleet does the timing, idleTraders.ts). A key per ship, so each is told once an hour. */
export const idleDetector: Detector = {
  id: "idle",
  category: "idle",
  detect: (s) =>
    (s.idle ?? []).map((i) => ({
      key: `idle:${i.symbol}`,
      category: "idle",
      severity: "warning" as const,
      title: `${i.symbol} has had no route for ${Math.floor(i.idleMs / 60_000)} min`,
      body: i.waypoint ? `Idle at ${i.waypoint}.` : "Idle with an empty hold.",
      url: "/m#fleet",
    })),
};

/** Two warnings before the reset: two hours out, then fifteen minutes. A key per step, so each is sent once. */
export const resetDetector: Detector = {
  id: "reset",
  category: "reset",
  detect: (s) => {
    const ms = s.msToReset;
    if (ms === undefined || !(ms > 0)) return [];
    const out: NotifyEvent[] = [];
    if (ms <= 15 * 60_000) out.push({ key: "reset:15m", category: "reset", severity: "critical", title: "Reset in 15 minutes", body: "Ships still holding cargo will lose it.", url: "/m#home" });
    else if (ms <= 2 * 3_600_000) out.push({ key: "reset:2h", category: "reset", severity: "warning", title: "Reset in about 2 hours", body: "The wind-down is the time to sell what is held.", url: "/m#home" });
    return out;
  },
};

/** The last hour under half the 3-hour average, with a rate worth measuring. Compares the two figures; shows neither. */
export const rateDetector: Detector = {
  id: "rate",
  category: "rate",
  detect: (s) => {
    const r = s.rate;
    if (!r || !(r.perHour3h > 1_000_000) || !(r.perHour1h < r.perHour3h * 0.5)) return [];
    return [{ key: "rate:drop", category: "rate", severity: "warning", title: "Earning rate has dropped", body: "The last hour is under half the 3-hour average.", url: "/m#metrics" }];
  },
};

export const DETECTORS: readonly Detector[] = [approvalsDetector, strandedDetector, idleDetector, attentionDetector, resetDetector, rateDetector];

/** Run every detector. One that throws is skipped, so a bad detector never silences the others. */
export function detectAll(snapshot: NotifySnapshot, detectors: readonly Detector[] = DETECTORS): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const d of detectors) {
    try {
      out.push(...d.detect(snapshot).map((e) => ({ ...e, category: d.category })));
    } catch {
      /* skipped */
    }
  }
  return out;
}
