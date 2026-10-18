/**
 * The per-transaction cap a market states when it refuses a buy or sell ("Trade good SHIP_PLATING has a limit of 8 units
 * per transaction."). The cap is the market's live trade volume, which moves with trading: SHIP_PLATING at D44 went 6, 8,
 * 9 and back to 8 on 2026-10-18, so a lot size planned from an earlier read can be one or two units too big by the time
 * the hold is sold. Pure; the caller retries at the size the market named, never at a guess.
 */
export function transactionLimit(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const n = Number(/limit of (\d+) units? per transaction/i.exec(msg)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The lot to retry at after a refusal: the market's own cap when it is smaller than the lot that failed, else none (a different error). */
export function lotAfterRefusal(err: unknown, failedLot: number): number | undefined {
  const cap = transactionLimit(err);
  return cap !== undefined && cap < failedLot ? cap : undefined;
}
