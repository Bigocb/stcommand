/**
 * The contracts the fleet has accepted and not yet been paid for: the "upcoming money" the metrics never showed.
 *
 * The payout is cash only when the contract completes, so none of this is ever added to Credits or net: it is reported
 * beside them. For each open contract: what it still owes us, how far along it is, what it has cost so far (the cost basis
 * of the goods already delivered, from the ledger), what finishing it should cost (the units still to buy at the cheapest
 * known market, less what ships already carry), the expected net, and how long is left.
 *
 * Pure: no I/O, no clock. The caller reads the contract list, the ledger sums, cargo and market prices and passes them in.
 */
export interface PipelineContract {
  id: string;
  type: string;
  factionSymbol: string;
  accepted: boolean;
  fulfilled: boolean;
  abandoned: boolean;
  deadline: string;
  onAccepted: number;
  onFulfilled: number;
  deliver: { tradeSymbol: string; destinationSymbol: string; unitsRequired: number; unitsFulfilled: number }[];
}

export interface PipelineContext {
  nowMs: number;
  /** Cheapest known price per unit of a good, or undefined when no market sells it (mined-only goods). */
  cheapestPrice: (good: string) => number | undefined;
  /** Units of a good ships are carrying right now, which need no buying. */
  heldUnits: (good: string) => number;
  /** Ledger sums for this contract so far (migrations/049): advance and payout received, units delivered and their cost basis. */
  ledger: (contractId: string) => { advance: number; costDelivered: number; unitsDelivered: number } | undefined;
}

export interface PipelineLine {
  good: string;
  destination: string;
  required: number;
  delivered: number;
  remaining: number;
  /** Units ships already carry, taken off what is left to buy. */
  held: number;
  /** Units still to buy: remaining less held, never negative. */
  toBuy: number;
  /** Cheapest known unit price, or null when no market sells the good (so it can only be mined). */
  unitPrice: number | null;
  estCost: number;
}

export interface PipelineItem {
  contractId: string;
  type: string;
  factionSymbol: string;
  /** Still owed on completion: the credits that land when the last unit is delivered. */
  owed: number;
  /** Advance already paid on accept (cash already received). */
  advanceReceived: number;
  progressPct: number;
  lines: PipelineLine[];
  /** Cost of the goods already delivered. */
  costSoFar: number;
  /** Estimated cost of what is still to buy. */
  estCostToFinish: number;
  /** owed - costSoFar - estCostToFinish: what completing it should still add to the books, advance excluded. */
  expectedNet: number;
  deadline: string;
  hoursLeft: number;
  /** One line on anything that makes the estimate soft or the contract risky. */
  warnings: string[];
  abandoned: boolean;
}

export interface Pipeline {
  items: PipelineItem[];
  /** Sum of `owed` over the contracts being worked (abandoned ones are not counted: nothing is being done to earn them). */
  totalOwed: number;
  totalEstCostToFinish: number;
  totalExpectedNet: number;
}

const rnd = (n: number): number => Math.round(n);

export function contractPipeline(contracts: readonly PipelineContract[], ctx: PipelineContext): Pipeline {
  const items: PipelineItem[] = [];
  for (const c of contracts) {
    if (!c.accepted || c.fulfilled) continue;
    const led = ctx.ledger(c.id);
    const warnings: string[] = [];
    const lines: PipelineLine[] = c.deliver.map((d) => {
      const remaining = Math.max(0, d.unitsRequired - d.unitsFulfilled);
      const held = Math.min(remaining, Math.max(0, ctx.heldUnits(d.tradeSymbol)));
      const toBuy = remaining - held;
      const price = ctx.cheapestPrice(d.tradeSymbol);
      if (toBuy > 0 && price === undefined) warnings.push(`${d.tradeSymbol} has no market, so it can only be mined`);
      return {
        good: d.tradeSymbol, destination: d.destinationSymbol, required: d.unitsRequired, delivered: d.unitsFulfilled,
        remaining, held, toBuy, unitPrice: price ?? null, estCost: rnd(toBuy * (price ?? 0)),
      };
    });
    const required = lines.reduce((n, l) => n + l.required, 0);
    const delivered = lines.reduce((n, l) => n + l.delivered, 0);
    const estCostToFinish = lines.reduce((n, l) => n + l.estCost, 0);
    const costSoFar = rnd(led?.costDelivered ?? 0);
    const hoursLeft = Math.max(0, (Date.parse(c.deadline) - ctx.nowMs) / 3_600_000);
    const expectedNet = rnd(c.onFulfilled - costSoFar - estCostToFinish);
    if (c.abandoned) warnings.push("not being worked: it will lapse at its deadline");
    else if (hoursLeft < 1 && lines.some((l) => l.remaining > 0)) warnings.push("under an hour left");
    if (expectedNet < 0) warnings.push("expected to finish at a loss");
    items.push({
      contractId: c.id, type: c.type, factionSymbol: c.factionSymbol, owed: c.onFulfilled, advanceReceived: rnd(led?.advance ?? 0),
      progressPct: required > 0 ? Math.round((delivered / required) * 100) : 0, lines, costSoFar, estCostToFinish, expectedNet,
      deadline: c.deadline, hoursLeft: Math.round(hoursLeft * 10) / 10, warnings, abandoned: c.abandoned,
    });
  }
  items.sort((a, b) => a.hoursLeft - b.hoursLeft);
  const worked = items.filter((i) => !i.abandoned);
  return {
    items,
    totalOwed: worked.reduce((n, i) => n + i.owed, 0),
    totalEstCostToFinish: worked.reduce((n, i) => n + i.estCostToFinish, 0),
    totalExpectedNet: worked.reduce((n, i) => n + i.expectedNet, 0),
  };
}
